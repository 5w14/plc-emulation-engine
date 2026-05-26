import { clone } from "../internal";
import type { PlcResource, PlcTask, RuntimeInspection, ScanOptions } from "../types";

export interface TaskRuntimeState {
  lastRun?: number;
  pendingEvents: number;
}

function taskKey(task: PlcTask): string {
  if (!task.id) throw new Error(`Task ${task.name} is missing an id after normalization`);
  return task.id;
}

export function findTask(resources: PlcResource[], taskIdOrName: string): PlcTask | undefined {
  return resources
    .flatMap((resource) => resource.tasks)
    .find((task) => task.id === taskIdOrName || task.name === taskIdOrName);
}

export function triggerEventTask(
  resources: PlcResource[],
  taskState: Map<string, TaskRuntimeState>,
  taskIdOrName: string,
  count = 1,
): void {
  const task = findTask(resources, taskIdOrName);
  if (!task) throw new Error(`Unknown task: ${taskIdOrName}`);
  if (task.kind !== "event") throw new Error(`Task is not an event task: ${taskIdOrName}`);
  const key = taskKey(task);
  const state = taskState.get(key) ?? { pendingEvents: 0 };
  state.pendingEvents += Math.max(1, Math.floor(count));
  taskState.set(key, state);
}

export function setTaskInhibited(
  resources: PlcResource[],
  taskIdOrName: string,
  inhibited: boolean,
): PlcTask {
  const task = findTask(resources, taskIdOrName);
  if (!task) throw new Error(`Unknown task: ${taskIdOrName}`);
  task.inhibited = inhibited;
  return clone(task);
}

export function taskSchedulingPriority(task: PlcTask): number {
  return task.kind === "continuous" ? Number.POSITIVE_INFINITY : task.priority;
}

export function compareTasksForScheduling(a: PlcTask, b: PlcTask): number {
  const priority = taskSchedulingPriority(a) - taskSchedulingPriority(b);
  if (priority !== 0) return priority;
  if (a.kind === b.kind) return 0;
  if (a.kind === "continuous") return 1;
  if (b.kind === "continuous") return -1;
  return 0;
}

export function selectDueTasks(
  resources: PlcResource[],
  taskState: Map<string, TaskRuntimeState>,
  options: ScanOptions,
  now: number,
): PlcTask[] {
  return resources
    .flatMap((resource) => resource.tasks)
    .filter((task) => {
      if (task.inhibited) return false;
      const key = taskKey(task);
      if (options.tasks && !options.tasks.includes(key) && !options.tasks.includes(task.name))
        return false;
      if (task.kind === "continuous") return true;
      if (task.kind === "periodic") {
        const lastRun = taskState.get(key)?.lastRun;
        return lastRun === undefined || now - lastRun >= (task.periodMs ?? 0);
      }
      const state = taskState.get(key);
      if ((state?.pendingEvents ?? 0) > 0) {
        taskState.set(key, { ...state, pendingEvents: (state?.pendingEvents ?? 1) - 1 });
        return true;
      }
      return false;
    });
}

export function inspectScheduler(
  resources: PlcResource[],
  taskState: Map<string, TaskRuntimeState>,
  now: number,
): RuntimeInspection["scheduler"] {
  return resources.flatMap((resource) =>
    resource.tasks.map((task) => {
      const state = taskState.get(taskKey(task)) ?? { pendingEvents: 0 };
      const due =
        !task.inhibited &&
        (task.kind === "continuous" ||
          (task.kind === "periodic" &&
            (state.lastRun === undefined || now - state.lastRun >= (task.periodMs ?? 0))) ||
          (task.kind === "event" && state.pendingEvents > 0));
      return {
        task: clone(task),
        lastRun: state.lastRun,
        pendingEvents: state.pendingEvents,
        due,
      };
    }),
  );
}
