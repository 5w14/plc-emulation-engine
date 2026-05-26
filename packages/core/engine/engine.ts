import { createCoreInstructionPlugin } from "../instructions/builtin";
import { clone, defaultValueForType, id, sleep } from "../internal";
import { DefaultPlcDebugger } from "../debug/debugger";
import { DefaultIoRuntime } from "../io/runtime";
import { DefaultPluginRegistry } from "../plugins/registry";
import { DefaultRuntimeRpcRouter } from "../rpc/router";
import {
  compareTasksForScheduling,
  inspectScheduler,
  selectDueTasks,
  setTaskInhibited,
  triggerEventTask,
  type TaskRuntimeState,
} from "../scheduler/runtime";
import { InMemoryDiagnosticStore, InMemoryFaultStore } from "../faults/stores";
import { InMemoryTagStore } from "../tags/store";
import { ScopedTagStore } from "../tags/scoped";
import { DefaultPlcClock } from "./clock";
import { DefaultControllerRuntime } from "./controller";
import { MapInstructionMemory } from "./memory";
import { normalizeConfigurationIds, normalizeSourceStructureIds } from "./normalization";
import { validateProgramSource } from "./validation";
import type {
  AoiDefinition,
  DebugEvent,
  DirectAddress,
  ExecutionFrame,
  FunctionBlockCallContext,
  FunctionBlockInstanceInspection,
  InstructionContext,
  InstructionNode,
  LoadedProgram,
  PlcConfiguration,
  PlcConfigurationRuntime,
  PlcEngine,
  PlcFault,
  PlcNetwork,
  PlcProgramUnit,
  PlcResource,
  PlcRoutine,
  PlcTask,
  PouDefinition,
  PrescanOptions,
  ProgramInstance,
  ProgramSource,
  ResetOptions,
  RuntimeInspection,
  RuntimeMessage,
  RuntimeSnapshot,
  RuntimeTransport,
  ScanMetricsSnapshot,
  ScanOptions,
  ScanResult,
  TagStore,
  Unsubscribe,
  VariableDeclaration,
} from "../types";

interface EngineOptions {
  target?: "core" | "browser" | "worker" | "node" | "bun";
}

const branchOpcodes = new Set(["branch", "parallel"]);
const seriesOpcodes = new Set(["series"]);
const callOpcodes = new Set(["fb.call", "function.call"]);
const persistentCallOpcodes = new Set(["fb.call"]);

function runtimeId(value: string | undefined, kind = "object"): string {
  if (!value) throw new Error(`Runtime ${kind} is missing an id after normalization`);
  return value;
}

export class DefaultPlcEngine implements PlcEngine {
  readonly configuration: PlcConfigurationRuntime = { loadedPrograms: [] };
  readonly debugger = new DefaultPlcDebugger();
  readonly diagnostics = new InMemoryDiagnosticStore();
  readonly clock = new DefaultPlcClock();
  readonly plugins: DefaultPluginRegistry;
  readonly tags: InMemoryTagStore;
  readonly io: DefaultIoRuntime;
  readonly faults: InMemoryFaultStore;
  readonly controller: DefaultControllerRuntime;
  private readonly instructionMemory = new Map<string, MapInstructionMemory>();
  private readonly fbMemory = new Map<string, Record<string, unknown>>();
  private readonly fbInstances = new Map<string, Omit<FunctionBlockInstanceInspection, "memory">>();
  private readonly callStack: FunctionBlockCallContext[] = [];
  private readonly taskState = new Map<string, TaskRuntimeState>();
  private readonly transports = new Map<string, RuntimeTransport>();
  private readonly router: DefaultRuntimeRpcRouter;
  private readonly scanMetricsHistory: Array<{
    scanNumber: number;
    durationNs: number;
    startedAt: number;
  }> = [];
  private scanMetricsTotalNs = 0;
  private scanMetricsMinNs = Number.POSITIVE_INFINITY;
  private scanMetricsMaxNs = 0;
  private lastScanResult: ScanResult | null = null;
  private directAddressTags: Array<{ tag: string; address: DirectAddress }> = [];
  private running = false;
  private taskWasDebugPaused = false;
  private returnRequested = false;
  private labelJumpRequested: string | undefined;
  private currentExecutionStack: ExecutionFrame[] | undefined;

  constructor(options: EngineOptions = {}) {
    this.plugins = new DefaultPluginRegistry(options.target ?? "core");
    this.faults = new InMemoryFaultStore({
      onRaise: (fault) => {
        if (fault.severity === "major" || fault.severity === "fatal")
          this.controller.mode = "faulted";
        this.emit("fault:raise", fault);
      },
      onClear: (fault) => this.emit("fault:clear", fault),
    });
    this.controller = new DefaultControllerRuntime(this.faults);
    this.tags = new InMemoryTagStore({
      emit: (name, payload) => this.emit(name, payload),
      onRuntimeError: (error, metadata) =>
        this.raiseFault("major", this.faultCodeForError(error), error.message, metadata),
    });
    this.io = new DefaultIoRuntime({
      emit: (name, payload) => this.emit(name, payload),
    });
    this.plugins.setSetupContext({ engine: this, registry: this.plugins });
    void this.plugins.register(createCoreInstructionPlugin());
    this.router = new DefaultRuntimeRpcRouter(this);
  }

  async loadProgram(source: ProgramSource): Promise<LoadedProgram> {
    const normalized = this.normalizeSource(source);
    const loaded = {
      id: normalized.id ?? id("program-source"),
      name: normalized.name,
      source: normalized,
      loadedAt: this.clock.now(),
    };
    this.configuration.loadedPrograms.push(loaded);
    this.configuration.current = this.mergeConfiguration();
    this.declareSource(normalized);
    for (const diagnostic of normalized.diagnostics ?? []) this.diagnostics.add(diagnostic);
    for (const diagnostic of validateProgramSource(normalized, {
      tags: this.tags,
      getInstruction: (opcode) => this.plugins.getInstruction(opcode),
      findPouOrAoi: (name) => this.findPouOrAoi(name),
      structuralOpcodes: new Set([...branchOpcodes, ...seriesOpcodes]),
      callOpcodes,
    }))
      this.diagnostics.add(diagnostic);
    return clone(loaded);
  }

  async replaceProgram(programId: string, source: ProgramSource): Promise<LoadedProgram> {
    await this.resetInstructionState();
    await this.unloadProgram(programId);
    return this.loadProgram({ ...source, id: source.id ?? programId });
  }

  async unloadProgram(programId: string): Promise<void> {
    this.configuration.loadedPrograms = this.configuration.loadedPrograms.filter(
      (program) => program.id !== programId && program.source.id !== programId,
    );
    this.configuration.current = this.mergeConfiguration();
  }

  async prescan(_options: PrescanOptions = {}): Promise<void> {
    for (const loaded of this.configuration.loadedPrograms) {
      for (const routine of this.routinesForSource(loaded.source)) {
        await this.walkRoutineInstructions(routine, async (instruction, stack) => {
          const definition = this.plugins.getInstruction(instruction.opcode);
          if (!definition?.prescan) return;
          await definition.prescan(
            instruction.args,
            this.context(instruction, true, stack, this.tags),
          );
        });
      }
    }
  }

  private async postscan(): Promise<void> {
    for (const loaded of this.configuration.loadedPrograms) {
      for (const routine of this.routinesForSource(loaded.source)) {
        await this.walkRoutineInstructions(routine, async (instruction, stack) => {
          const definition = this.plugins.getInstruction(instruction.opcode);
          if (definition?.postscan)
            await definition.postscan(
              instruction.args,
              this.context(instruction, true, stack, this.tags),
            );
        });
      }
    }
  }

  private async resetInstructionState(): Promise<void> {
    for (const loaded of this.configuration.loadedPrograms) {
      for (const routine of this.routinesForSource(loaded.source)) {
        await this.walkRoutineInstructions(routine, async (instruction, stack) => {
          const definition = this.plugins.getInstruction(instruction.opcode);
          if (definition?.reset)
            await definition.reset(
              instruction.args,
              this.context(instruction, true, stack, this.tags),
            );
        });
      }
    }
    this.instructionMemory.clear();
  }

  async scan(options: ScanOptions = {}): Promise<ScanResult> {
    const startedAt = this.clock.now();
    const startedNs = this.clock.highResTime();
    const currentScan = this.controller.scanNumber + 1;
    if (
      this.controller.mode === "program" ||
      this.controller.mode === "remote-program" ||
      this.controller.mode === "paused" ||
      this.controller.mode === "faulted"
    ) {
      return {
        scanNumber: this.controller.scanNumber,
        startedAt,
        endedAt: startedAt,
        durationMs: 0,
        tasks: [],
        faults: this.faults.list(),
        diagnostics: this.diagnostics.list(),
      };
    }

    this.controller.scanNumber = currentScan;
    await this.emitAndMaybePause("scan:start", { scanNumber: currentScan });
    await this.latchInputs();
    const taskResults: ScanResult["tasks"] = [];
    const tasks = selectDueTasks(this.resources(), this.taskState, options, this.clock.now()).sort(
      compareTasksForScheduling,
    );
    for (const task of tasks) {
      this.taskWasDebugPaused = false;
      const taskId = runtimeId(task.id, "task");
      const taskStarted = this.clock.now();
      const taskStack = [{ kind: "task", id: taskId, name: task.name }] satisfies ExecutionFrame[];
      await this.emitAndMaybePause("task:start", { task }, [
        { kind: "task", id: taskId, name: task.name },
      ]);
      try {
        await this.executeTask(task, taskStack);
      } catch (error) {
        this.raiseFault(
          "major",
          "TASK_EXECUTION_ERROR",
          error instanceof Error ? error.message : String(error),
        );
      }
      const taskEnded = this.clock.now();
      const durationMs = taskEnded - taskStarted;
      if (
        !this.taskWasDebugPaused &&
        task.watchdogMs !== undefined &&
        durationMs > task.watchdogMs
      ) {
        this.raiseFault(
          "major",
          "WATCHDOG_TIMEOUT",
          `Task ${task.name} exceeded watchdog ${task.watchdogMs}ms`,
          { taskId, durationMs },
        );
      }
      this.taskState.set(taskId, {
        ...(this.taskState.get(taskId) ?? { pendingEvents: 0 }),
        lastRun: taskEnded,
      });
      taskResults.push({ id: taskId, name: task.name, durationMs });
      await this.emitAndMaybePause("task:end", { task, durationMs }, [
        { kind: "task", id: taskId, name: task.name },
      ]);
    }
    if (!options.suppressOutputs && this.controller.mode !== "test") await this.commitOutputs();
    await this.postscan();
    for (const event of this.debugger.recordTraces(
      (path) => this.tags.get(path),
      this.controller.scanNumber,
      this.clock.now(),
    ))
      this.debugger.emit(event);
    const endedAt = this.clock.now();
    const endedNs = this.clock.highResTime();
    const durationNs = Math.max(0, endedNs - startedNs);
    const result = {
      scanNumber: this.controller.scanNumber,
      startedAt,
      endedAt,
      durationMs: endedAt - startedAt,
      tasks: taskResults,
      faults: this.faults.list(),
      diagnostics: this.diagnostics.list(),
    };
    this.recordScanMetrics(result, durationNs);
    await this.emitAndMaybePause("scan:end", result);
    return result;
  }

  async run(
    options: { intervalMs?: number; maxScans?: number; signal?: { aborted: boolean } } = {},
  ) {
    this.running = true;
    this.clock.useRealTime();
    if (this.controller.mode === "program" || this.controller.mode === "remote-program")
      this.controller.setMode("run");
    let stopped = false;
    const handle = {
      stop: (reason?: string) => {
        stopped = true;
        this.stop(reason);
      },
      get running() {
        return !stopped;
      },
      done: Promise.resolve(),
    };
    handle.done = (async () => {
      let count = 0;
      while (
        !stopped &&
        !options.signal?.aborted &&
        this.running &&
        (options.maxScans === undefined || count < options.maxScans)
      ) {
        const previousScan = this.controller.scanNumber;
        const result = await this.scan();
        if (result.scanNumber > previousScan) count += result.scanNumber - previousScan;
        while (
          this.controller.mode === "paused" &&
          !stopped &&
          !options.signal?.aborted &&
          this.running
        )
          await sleep(1);
        if (options.intervalMs && options.intervalMs > 0) await sleep(options.intervalMs);
      }
      stopped = true;
    })();
    return handle;
  }

  async reset(options: ResetOptions = {}): Promise<void> {
    const retained = options.retain ? this.tags.snapshot({ includeRetainedOnly: true }) : undefined;
    this.tags.restore({
      values: {},
      declarations: [],
      aliases: [],
      udts: [],
      forces: [],
      quality: [],
    });
    this.io.restore({
      inputs: {},
      outputs: {},
      memory: {},
      forces: { inputs: [], outputs: [], memory: [] },
    });
    this.instructionMemory.clear();
    this.fbMemory.clear();
    this.fbInstances.clear();
    this.taskState.clear();
    this.faults.clear();
    this.diagnostics.clear();
    this.controller.scanNumber = 0;
    this.controller.reason = undefined;
    this.controller.mode = options.mode ?? "program";
    this.resetScanMetrics();
    if (options.resetClock) this.clock.useVirtualTime(0);
    for (const loaded of this.configuration.loadedPrograms) {
      this.declareSource(loaded.source);
      for (const diagnostic of loaded.source.diagnostics ?? []) this.diagnostics.add(diagnostic);
      for (const diagnostic of validateProgramSource(loaded.source, {
        tags: this.tags,
        getInstruction: (opcode) => this.plugins.getInstruction(opcode),
        findPouOrAoi: (name) => this.findPouOrAoi(name),
        structuralOpcodes: new Set([...branchOpcodes, ...seriesOpcodes]),
        callOpcodes,
      }))
        this.diagnostics.add(diagnostic);
    }
    if (retained) {
      for (const declaration of retained.declarations) {
        const value = (
          retained.values[declaration.scope ? JSON.stringify(declaration.scope) : "global"] as
            | Record<string, unknown>
            | undefined
        )?.[declaration.name];
        if (value !== undefined)
          this.tags.set(declaration.name, value, {
            scope: declaration.scope,
            bypassReadonly: true,
          });
      }
    }
    await this.resetInstructionState();
  }

  pause(reason?: string): void {
    this.controller.mode = "paused";
    this.controller.reason = reason;
  }

  resume(): void {
    this.controller.mode = "run";
    this.controller.reason = undefined;
    void this.debugger.continue();
  }

  stop(reason?: string): void {
    this.running = false;
    this.controller.mode = "program";
    this.controller.reason = reason;
  }

  snapshot(): RuntimeSnapshot {
    return {
      tags: this.tags.snapshot(),
      faults: this.faults.snapshot(),
      diagnostics: this.diagnostics.list(),
      instructionMemory: Object.fromEntries(
        Array.from(this.instructionMemory.entries()).map(([key, memory]) => [
          key,
          memory.snapshot(),
        ]),
      ),
      fbMemory: clone(Object.fromEntries(this.fbMemory.entries())),
      fbInstances: clone(Object.fromEntries(this.fbInstances.entries())),
      io: this.io.snapshot(),
      scheduler: clone(Object.fromEntries(this.taskState.entries())),
      clock: this.clock.snapshot(),
      controller: {
        mode: this.controller.mode,
        scanNumber: this.controller.scanNumber,
        reason: this.controller.reason,
      },
      debug: this.debugger.snapshot(),
      programs: clone(this.configuration.loadedPrograms),
      configuration: clone(this.configuration.current),
    };
  }

  restore(snapshot: RuntimeSnapshot): void {
    this.tags.restore(snapshot.tags);
    this.faults.restore(snapshot.faults);
    this.diagnostics.clear();
    for (const diagnostic of snapshot.diagnostics) this.diagnostics.add(diagnostic);
    this.instructionMemory.clear();
    for (const [key, value] of Object.entries(snapshot.instructionMemory)) {
      const memory = new MapInstructionMemory();
      memory.restore(value);
      this.instructionMemory.set(key, memory);
    }
    this.fbMemory.clear();
    for (const [key, value] of Object.entries(snapshot.fbMemory))
      this.fbMemory.set(key, clone(value));
    this.fbInstances.clear();
    for (const [key, value] of Object.entries(snapshot.fbInstances ?? {}))
      this.fbInstances.set(key, clone(value));
    if (snapshot.io) this.io.restore(snapshot.io);
    this.taskState.clear();
    for (const [key, value] of Object.entries(snapshot.scheduler))
      this.taskState.set(key, value as TaskRuntimeState);
    this.clock.restore(snapshot.clock);
    this.controller.mode = snapshot.controller.mode;
    this.controller.scanNumber = snapshot.controller.scanNumber;
    this.controller.reason = snapshot.controller.reason;
    this.debugger.restore(snapshot.debug);
    this.configuration.loadedPrograms = clone(snapshot.programs);
    this.configuration.current = clone(snapshot.configuration);
    this.rebuildDirectAddressTags();
  }

  inspect(): RuntimeInspection {
    return {
      stack: clone(this.debugger.snapshot().lastEvent?.stack ?? []),
      instructionMemory: Object.fromEntries(
        Array.from(this.instructionMemory.entries()).map(([key, memory]) => [
          key,
          memory.snapshot(),
        ]),
      ),
      functionBlockMemory: clone(Object.fromEntries(this.fbMemory.entries())),
      functionBlockInstances: Array.from(this.fbInstances.values()).map((entry) => ({
        ...clone(entry),
        memory: clone(this.fbMemory.get(entry.instance) ?? {}),
      })),
      scheduler: inspectScheduler(this.resources(), this.taskState, this.clock.now()),
    };
  }

  attachTransport(transport: RuntimeTransport): Unsubscribe {
    this.transports.set(transport.id, transport);
    const unsubscribe = transport.onMessage(async (message) => {
      const response = await this.router.handle(message);
      await transport.send?.(response);
    });
    const unsubscribeNotifications = this.router.onNotification((message: RuntimeMessage) =>
      transport.send?.(message),
    );
    void transport.start?.({ router: this.router, engine: this });
    return () => {
      unsubscribe();
      unsubscribeNotifications();
      this.transports.delete(transport.id);
      void transport.stop?.();
    };
  }

  triggerEventTask(taskIdOrName: string, count = 1): void {
    triggerEventTask(this.resources(), this.taskState, taskIdOrName, count);
  }

  setTaskInhibited(taskIdOrName: string, inhibited: boolean): PlcTask {
    return setTaskInhibited(this.resources(), taskIdOrName, inhibited);
  }

  scanMetrics(): ScanMetricsSnapshot {
    const totalScans = this.scanMetricsHistory.length;
    const totalDurationNs = this.scanMetricsTotalNs;
    return {
      totalScans,
      totalDurationNs,
      averageDurationNs: totalScans > 0 ? totalDurationNs / totalScans : 0,
      minDurationNs: totalScans > 0 ? this.scanMetricsMinNs : 0,
      maxDurationNs: totalScans > 0 ? this.scanMetricsMaxNs : 0,
      lastScan: this.lastScanResult
        ? {
            scanNumber: this.lastScanResult.scanNumber,
            startedAt: this.lastScanResult.startedAt,
            endedAt: this.lastScanResult.endedAt,
            durationMs: this.lastScanResult.durationMs,
            durationNs: this.lastScanResult.durationMs * 1_000_000,
            tasks: this.lastScanResult.tasks,
          }
        : null,
      recent: this.scanMetricsHistory.slice(),
    };
  }

  resetScanMetrics(): void {
    this.scanMetricsHistory.length = 0;
    this.scanMetricsTotalNs = 0;
    this.scanMetricsMinNs = Number.POSITIVE_INFINITY;
    this.scanMetricsMaxNs = 0;
    this.lastScanResult = null;
  }

  getRpcRouter(): DefaultRuntimeRpcRouter {
    return this.router;
  }

  private normalizeSource(source: ProgramSource): ProgramSource {
    const normalized = clone(source);
    normalized.id ??= id("source");
    normalized.tasks ??= [];
    normalized.programs ??= [];
    normalized.pous ??= [];
    normalized.tags ??= [];
    normalized.udts ??= [];
    normalized.aois ??= [];
    normalizeSourceStructureIds(normalized);
    normalized.configuration ??= this.defaultConfiguration(normalized);
    normalizeConfigurationIds(normalized.configuration);
    return normalized;
  }

  private defaultConfiguration(source: ProgramSource): PlcConfiguration {
    const tasks: PlcTask[] =
      source.tasks && source.tasks.length > 0
        ? source.tasks
        : [{ id: "default-task", name: "MainTask", kind: "continuous", priority: 10 }];
    const programUnits: Array<{ id: string; name: string }> = [
      ...(source.programs ?? []).map((program) => ({
        id: runtimeId(program.id),
        name: program.name,
      })),
      ...(source.pous ?? [])
        .filter((pou) => pou.kind === "program")
        .map((pou) => ({ id: runtimeId(pou.id), name: pou.name })),
    ];
    const programs: ProgramInstance[] = programUnits.map((program, index) => ({
      id: `${program.id}-instance`,
      name: program.name,
      program: program.id,
      task: tasks[index]?.id ?? tasks[0]?.id,
    }));
    return {
      id: `${source.id ?? "default"}-configuration`,
      name: `${source.name} Configuration`,
      resources: [{ id: "default-resource", name: "Default Resource", tasks, programs }],
      globalVariables: source.tags,
    };
  }

  private mergeConfiguration(): PlcConfiguration | undefined {
    const configurations = this.configuration.loadedPrograms
      .map((program) => program.source.configuration)
      .filter((configuration): configuration is PlcConfiguration => Boolean(configuration));
    if (configurations.length === 0) return undefined;
    return {
      id: "runtime-configuration",
      name: "Runtime Configuration",
      resources: configurations.flatMap((configuration) => configuration.resources),
      globalVariables: configurations.flatMap(
        (configuration) => configuration.globalVariables ?? [],
      ),
      accessPaths: configurations.flatMap((configuration) => configuration.accessPaths ?? []),
    };
  }

  private declareSource(source: ProgramSource): void {
    for (const udt of source.udts ?? []) this.tags.declareUdt(udt);
    for (const tag of [...(source.configuration?.globalVariables ?? []), ...(source.tags ?? [])])
      this.declareTag(tag);
    for (const resource of source.configuration?.resources ?? []) {
      for (const tag of resource.globalVariables ?? []) this.declareTag(tag);
    }
    for (const program of source.programs ?? []) {
      for (const variable of program.variables ?? []) this.declareTag(variable);
    }
    for (const pou of (source.pous ?? []).filter((definition) => definition.kind === "program")) {
      for (const variable of [
        ...(pou.variables ?? []),
        ...(pou.interface.inputs ?? []),
        ...(pou.interface.outputs ?? []),
        ...(pou.interface.inouts ?? []),
        ...(pou.interface.externals ?? []),
      ]) {
        this.declareTag(variable);
      }
    }
    this.rebuildDirectAddressTags();
  }

  private declareTag(tag: VariableDeclaration): void {
    this.tags.declare(tag);
    if (tag.locatedAt) this.directAddressTags.push({ tag: tag.name, address: tag.locatedAt });
  }

  private rebuildDirectAddressTags(): void {
    this.directAddressTags = [];
    for (const loaded of this.configuration.loadedPrograms) {
      for (const tag of [
        ...(loaded.source.configuration?.globalVariables ?? []),
        ...(loaded.source.tags ?? []),
      ]) {
        if (tag.locatedAt) this.directAddressTags.push({ tag: tag.name, address: tag.locatedAt });
      }
    }
  }

  private async latchInputs(): Promise<void> {
    await this.io.updateInputs();
    for (const mapping of this.directAddressTags) {
      if (mapping.address.area === "I" && this.io.inputs.has(mapping.address))
        this.tags.set(mapping.tag, this.io.inputs.get(mapping.address));
      if (mapping.address.area === "M" && this.io.memory.has(mapping.address))
        this.tags.set(mapping.tag, this.io.memory.get(mapping.address));
    }
  }

  private async commitOutputs(): Promise<void> {
    for (const mapping of this.directAddressTags) {
      if (mapping.address.area === "Q")
        this.io.outputs.set(mapping.address, this.tags.get(mapping.tag));
      if (mapping.address.area === "M")
        this.io.memory.set(mapping.address, this.tags.get(mapping.tag));
    }
    await this.io.commitOutputs();
  }

  private async executeTask(task: PlcTask, stack: ExecutionFrame[]): Promise<void> {
    for (const resource of this.configuration.current?.resources ?? []) {
      const instances = resource.programs.filter(
        (program) => !program.task || program.task === task.id || program.task === task.name,
      );
      for (const instance of instances)
        await this.executeProgramInstance(instance, resource, stack);
    }
  }

  private async executeProgramInstance(
    instance: ProgramInstance,
    resource: PlcResource,
    stack: ExecutionFrame[] = [],
  ): Promise<void> {
    const source = this.configuration.loadedPrograms.find(
      (loaded) =>
        (loaded.source.programs ?? []).some(
          (program) => program.id === instance.program || program.name === instance.program,
        ) ||
        (loaded.source.pous ?? []).some(
          (pou) => pou.id === instance.program || pou.name === instance.program,
        ),
    )?.source;
    if (!source) return;
    const unit = source.programs?.find(
      (program) => program.id === instance.program || program.name === instance.program,
    );
    const pou = source.pous?.find(
      (candidate) =>
        candidate.id === instance.program ||
        candidate.name === instance.program ||
        candidate.id === unit?.pou ||
        candidate.name === unit?.pou,
    );
    const instanceId = runtimeId(instance.id, "program instance");
    const programFrame = {
      kind: "program",
      id: instanceId,
      name: instance.name,
    } satisfies ExecutionFrame;
    const programStack = [...stack, programFrame];
    await this.emitAndMaybePause("program:start", { instance, resource }, programStack);
    if (unit) {
      for (const routine of unit.routines ?? [])
        await this.executeRoutine(routine, this.tags, programStack);
    }
    if (pou) await this.executePou(pou, this.tags, programStack);
    await this.emitAndMaybePause("program:end", { instance, resource }, programStack);
  }

  private async executePou(
    pou: PouDefinition,
    tags: TagStore,
    stack: ExecutionFrame[],
  ): Promise<void> {
    const pouId = runtimeId(pou.id, "pou");
    const frame = { kind: "pou", id: pouId, name: pou.name } satisfies ExecutionFrame;
    const nextStack = [...stack, frame];
    await this.emitAndMaybePause("pou:start", { pou }, nextStack);
    const language = this.plugins.getLanguage(pou.body.language);
    if (language?.execute) {
      await language.execute(
        pou.body.statements ?? pou.body.graph ?? pou.body.custom ?? pou.body,
        this.context(
          { id: `${pouId}:body`, opcode: `language.${pou.body.language}`, args: pou.body },
          true,
          nextStack,
          tags,
        ),
      );
    }
    for (const routine of pou.body.routines ?? [])
      await this.executeRoutine(routine, tags, nextStack);
    for (const network of pou.body.networks ?? [])
      await this.executeNetwork(network, tags, nextStack);
    await this.emitAndMaybePause("pou:end", { pou }, nextStack);
  }

  private async executeRoutine(
    routine: PlcRoutine,
    tags: TagStore,
    stack: ExecutionFrame[],
  ): Promise<void> {
    const routineId = runtimeId(routine.id, "routine");
    const frame = { kind: "routine", id: routineId, name: routine.name } satisfies ExecutionFrame;
    const nextStack = [...stack, frame];
    const parentReturnRequested = this.returnRequested;
    this.returnRequested = false;
    await this.emitAndMaybePause("routine:start", { routine }, nextStack);
    if (routine.scan) {
      const memory = this.memoryFor(`routine:${routineId}`);
      await routine.scan({ tags, memory, engine: this, clock: this.clock });
    }
    for (const network of routine.networks ?? []) {
      await this.executeNetwork(network, tags, nextStack);
      if (this.returnRequested) break;
    }
    const rungs = routine.rungs ?? [];
    for (let index = 0; index < rungs.length; index += 1) {
      const rung = rungs[index];
      if (!rung) continue;
      await this.executeRung(rung, tags, nextStack);
      if (this.returnRequested) break;
      if (this.labelJumpRequested) {
        const target = this.findLabelRungIndex(rungs, this.labelJumpRequested);
        const label = this.labelJumpRequested;
        this.labelJumpRequested = undefined;
        if (target === undefined) throw new Error(`Unknown label: ${label}`);
        index = target - 1;
      }
    }
    await this.emitAndMaybePause("routine:end", { routine }, nextStack);
    this.returnRequested = parentReturnRequested;
  }

  private resources(): PlcResource[] {
    return this.configuration.current?.resources ?? [];
  }

  private async executeNetwork(
    network: PlcNetwork,
    tags: TagStore,
    stack: ExecutionFrame[],
  ): Promise<boolean> {
    if (network.enabled === false) return false;
    const frame = {
      kind: "network",
      id: runtimeId(network.id, "network"),
      name: network.name,
    } satisfies ExecutionFrame;
    const nextStack = [...stack, frame];
    await this.emitAndMaybePause("network:start", { network }, nextStack);
    let power = true;
    for (const instruction of network.instructions ?? []) {
      power = await this.executeInstruction(instruction, power, tags, nextStack);
      if (this.returnRequested) break;
    }
    for (const rung of network.rungs ?? []) {
      power = await this.executeRung(rung, tags, nextStack);
      if (this.returnRequested) break;
    }
    await this.emitAndMaybePause("network:end", { network, power }, nextStack);
    return power;
  }

  private async executeRung(
    rung: { id?: string; name?: string; enabled?: boolean; instructions: InstructionNode[] },
    tags: TagStore,
    stack: ExecutionFrame[],
  ): Promise<boolean> {
    if (rung.enabled === false) return false;
    const frame = {
      kind: "rung",
      id: runtimeId(rung.id, "rung"),
      name: rung.name,
    } satisfies ExecutionFrame;
    const nextStack = [...stack, frame];
    await this.emitAndMaybePause("rung:start", { rung }, nextStack);
    let power = true;
    for (const instruction of rung.instructions) {
      power = await this.executeInstruction(instruction, power, tags, nextStack);
      if (this.returnRequested) break;
    }
    await this.emitAndMaybePause("rung:end", { rung, power }, nextStack);
    return power;
  }

  private async executeInstruction(
    instruction: InstructionNode,
    power: boolean,
    tags: TagStore,
    stack: ExecutionFrame[],
  ): Promise<boolean> {
    const frame = {
      kind: "instruction",
      id: runtimeId(instruction.id, "instruction"),
      name: instruction.opcode,
    } satisfies ExecutionFrame;
    const nextStack = [...stack, frame];
    await this.emitAndMaybePause("instruction:before", { instruction, power }, nextStack);
    const previousExecutionStack = this.currentExecutionStack;
    this.currentExecutionStack = nextStack;
    try {
      if (branchOpcodes.has(instruction.opcode))
        return await this.executeBranch(instruction, power, tags, nextStack);
      if (seriesOpcodes.has(instruction.opcode))
        return await this.executeSeries(instruction, power, tags, nextStack);
      if (callOpcodes.has(instruction.opcode))
        return await this.executeFunctionBlockCall(instruction, power, tags, nextStack);
      const definition = this.plugins.getInstruction(instruction.opcode);
      if (!definition) {
        const diagnostic = {
          id: id("diagnostic"),
          severity: "error" as const,
          code: "UNSUPPORTED_INSTRUCTION",
          message: `Unsupported instruction: ${instruction.opcode}`,
          source: instruction.source,
        };
        this.diagnostics.add(diagnostic);
        this.raiseFault("major", "UNSUPPORTED_INSTRUCTION", diagnostic.message, { instruction });
        return false;
      }
      const result = await definition.execute(
        instruction.args,
        this.context(instruction, power, nextStack, tags),
      );
      const nextPower = result.power ?? power;
      if (result.done) this.returnRequested = true;
      await this.emitAndMaybePause(
        "instruction:after",
        { instruction, power: nextPower, result },
        nextStack,
      );
      return nextPower;
    } catch (error) {
      await this.emitAndMaybePause(
        "instruction:error",
        { instruction, error: error instanceof Error ? error.message : String(error) },
        nextStack,
      );
      this.raiseFault(
        "major",
        "INSTRUCTION_FAILURE",
        error instanceof Error ? error.message : String(error),
        { instruction },
      );
      return false;
    } finally {
      this.currentExecutionStack = previousExecutionStack;
    }
  }

  private async executeSeries(
    instruction: InstructionNode,
    power: boolean,
    tags: TagStore,
    stack: ExecutionFrame[],
  ): Promise<boolean> {
    let nextPower = power;
    for (const child of instruction.children ?? []) {
      nextPower = await this.executeInstruction(child, nextPower, tags, stack);
      if (this.returnRequested) break;
    }
    await this.emitAndMaybePause("instruction:after", { instruction, power: nextPower }, stack);
    return nextPower;
  }

  private async executeBranch(
    instruction: InstructionNode,
    power: boolean,
    tags: TagStore,
    stack: ExecutionFrame[],
  ): Promise<boolean> {
    let any = false;
    for (const child of instruction.children ?? []) {
      const result = await this.executeInstruction(child, power, tags, stack);
      any = any || result;
      if (this.returnRequested) break;
    }
    await this.emitAndMaybePause("instruction:after", { instruction, power: any }, stack);
    return any;
  }

  private async executeFunctionBlockCall(
    instruction: InstructionNode,
    power: boolean,
    tags: TagStore,
    stack: ExecutionFrame[],
  ): Promise<boolean> {
    if (!power) return false;
    const args = instruction.args as {
      definition?: string;
      instance?: string;
      parameters?: Record<string, string>;
    };
    const definitionName = args.definition;
    const instance = args.instance ?? `${definitionName ?? instruction.id}-instance`;
    const definition = this.findPouOrAoi(definitionName);
    if (!definition) throw new Error(`Unknown function block/AOI: ${definitionName}`);
    const parameters = args.parameters ?? {};
    this.assertCallBindings(instruction, definition, parameters, tags);
    const kind = "kind" in definition && definition.kind === "aoi" ? "aoi" : "fb";
    const inspectionKind =
      "kind" in definition && definition.kind === "aoi"
        ? "aoi"
        : "kind" in definition && definition.kind === "function"
          ? "function"
          : "function-block";
    this.fbInstances.set(instance, {
      instance,
      definitionId: runtimeId(definition.id, "function block definition"),
      definitionName: definition.name,
      kind: inspectionKind,
      parameters: clone(parameters),
    });
    const frame = { kind, id: instance, name: definitionName } satisfies ExecutionFrame;
    const nextStack = [...stack, frame];
    await this.emitAndMaybePause("fb:before", { definition, instance, parameters }, nextStack);
    const local = new InMemoryTagStore();
    const inputBindings: Record<string, string> = {};
    const outputBindings: Record<string, string> = {};
    const boundInputs: Array<{ local: string; parent: string }> = [];
    const persists =
      persistentCallOpcodes.has(instruction.opcode) ||
      !("kind" in definition) ||
      definition.kind === "function-block" ||
      definition.kind === "aoi";
    const callContext = {
      definition,
      instance,
      parameters: clone(parameters),
    } satisfies FunctionBlockCallContext;
    this.callStack.push(callContext);
    try {
      if ("interface" in definition) {
        for (const variable of [
          ...(definition.interface.inputs ?? []),
          ...(definition.interface.inouts ?? []),
        ]) {
          const bound = parameters[variable.name];
          if (bound) inputBindings[variable.name] = bound;
          if (bound) boundInputs.push({ local: variable.name, parent: bound });
          local.declare({
            ...variable,
            value: bound
              ? tags.get(bound)
              : (variable.initialValue ?? defaultValueForType(variable.type)),
          });
        }
        for (const variable of definition.interface.outputs ?? []) {
          const bound = parameters[variable.name];
          if (bound) outputBindings[variable.name] = bound;
          local.declare({
            ...variable,
            value: bound
              ? tags.get(bound)
              : (variable.initialValue ?? defaultValueForType(variable.type)),
          });
        }
        for (const variable of definition.variables ?? []) local.declare(variable);
        if (persists) this.restoreFunctionBlockMemory(instance, local);
        for (const binding of boundInputs)
          local.set(binding.local, tags.get(binding.parent), { bypassReadonly: true });
        await this.executePou(
          definition,
          new ScopedTagStore(tags, local, inputBindings, outputBindings),
          nextStack,
        );
      } else {
        for (const parameter of definition.parameters) {
          const bound = parameters[parameter.name];
          if (bound && (parameter.direction === "input" || parameter.direction === "inout"))
            inputBindings[parameter.name] = bound;
          if (bound && (parameter.direction === "output" || parameter.direction === "inout"))
            outputBindings[parameter.name] = bound;
          if (bound && (parameter.direction === "input" || parameter.direction === "inout"))
            boundInputs.push({ local: parameter.name, parent: bound });
          local.declare({
            name: parameter.name,
            type: parameter.type,
            initialValue: parameter.defaultValue,
          });
        }
        for (const variable of definition.localTags ?? []) local.declare(variable);
        if (persists) this.restoreFunctionBlockMemory(instance, local);
        for (const binding of boundInputs)
          local.set(binding.local, tags.get(binding.parent), { bypassReadonly: true });
        const scoped = new ScopedTagStore(tags, local, inputBindings, outputBindings);
        for (const routine of definition.routines)
          await this.executeRoutine(routine, scoped, nextStack);
      }
      if (persists) this.fbMemory.set(instance, local.snapshot().values);
    } catch (error) {
      await this.emitAndMaybePause(
        "fb:error",
        { definition, instance, error: error instanceof Error ? error.message : String(error) },
        nextStack,
      );
      throw error;
    } finally {
      this.callStack.pop();
    }
    await this.emitAndMaybePause("fb:after", { definition, instance }, nextStack);
    return true;
  }

  private assertCallBindings(
    instruction: InstructionNode,
    definition: PouDefinition | AoiDefinition,
    parameters: Record<string, string>,
    tags: TagStore,
  ): void {
    const assertKnownTag = (parameterName: string, bound: string): void => {
      if (!tags.has(bound)) {
        throw new Error(
          `Call ${instruction.id} parameter ${parameterName} references unknown tag ${bound}`,
        );
      }
    };
    if ("parameters" in definition) {
      const knownParameters = new Set(definition.parameters.map((parameter) => parameter.name));
      for (const parameter of definition.parameters) {
        const bound = parameters[parameter.name];
        if (parameter.required && !bound && parameter.defaultValue === undefined) {
          throw new Error(`Call ${instruction.id} is missing required parameter ${parameter.name}`);
        }
        if (bound) assertKnownTag(parameter.name, bound);
      }
      for (const parameterName of Object.keys(parameters)) {
        if (!knownParameters.has(parameterName))
          throw new Error(`Call ${instruction.id} has unknown parameter ${parameterName}`);
      }
      return;
    }
    const interfaceVariables = [
      ...(definition.interface.inputs ?? []),
      ...(definition.interface.outputs ?? []),
      ...(definition.interface.inouts ?? []),
    ];
    const knownParameters = new Set(interfaceVariables.map((variable) => variable.name));
    for (const variable of interfaceVariables) {
      const bound = parameters[variable.name];
      if (bound) assertKnownTag(variable.name, bound);
    }
    for (const parameterName of Object.keys(parameters)) {
      if (!knownParameters.has(parameterName))
        throw new Error(`Call ${instruction.id} has unknown parameter ${parameterName}`);
    }
  }

  private restoreFunctionBlockMemory(instance: string, local: InMemoryTagStore): void {
    const values = this.fbMemory.get(instance);
    if (!values) return;
    const current = local.snapshot();
    local.restore({ ...current, values: clone(values) });
  }

  private async jumpToSubroutine(
    target: string,
    tags: TagStore,
    stack: ExecutionFrame[],
  ): Promise<void> {
    for (const loaded of this.configuration.loadedPrograms) {
      const routine = this.routinesForSource(loaded.source).find(
        (candidate) => candidate.id === target || candidate.name === target,
      );
      if (routine) {
        await this.executeRoutine(routine, tags, stack);
        return;
      }
    }
    throw new Error(`Unknown routine: ${target}`);
  }

  private findPouOrAoi(name?: string): PouDefinition | AoiDefinition | undefined {
    if (!name) return undefined;
    for (const loaded of this.configuration.loadedPrograms) {
      const pou = loaded.source.pous?.find(
        (candidate) => candidate.id === name || candidate.name === name,
      );
      if (pou) return pou;
      const aoi = loaded.source.aois?.find(
        (candidate) => candidate.id === name || candidate.name === name,
      );
      if (aoi) return { ...aoi, kind: "aoi" as const };
    }
    return undefined;
  }

  private context(
    instruction: InstructionNode,
    power: boolean,
    stack: ExecutionFrame[],
    tags: TagStore,
  ): InstructionContext {
    return {
      engine: this,
      tags,
      io: this.io,
      clock: this.clock,
      control: {
        jumpToSubroutine: (nameOrId) => this.jumpToSubroutine(nameOrId, tags, stack),
        jumpToLabel: (label) => {
          this.labelJumpRequested = label;
        },
        returnFromRoutine: () => {
          this.returnRequested = true;
        },
      },
      memory: this.memoryFor(runtimeId(instruction.id, "instruction")),
      scanNumber: this.controller.scanNumber,
      power,
      instruction,
      stack,
      call: this.callStack[this.callStack.length - 1],
    };
  }

  private memoryFor(key: string): MapInstructionMemory {
    let memory = this.instructionMemory.get(key);
    if (!memory) {
      memory = new MapInstructionMemory();
      this.instructionMemory.set(key, memory);
    }
    return memory;
  }

  private findLabelRungIndex(
    rungs: Array<{ instructions: InstructionNode[] }>,
    label: string,
  ): number | undefined {
    for (let index = 0; index < rungs.length; index += 1) {
      if (
        rungs[index]?.instructions.some((instruction) =>
          this.instructionHasLabel(instruction, label),
        )
      )
        return index;
    }
    return undefined;
  }

  private instructionHasLabel(instruction: InstructionNode, label: string): boolean {
    const args = instruction.args as Record<string, unknown>;
    const candidate = args.label ?? args.name ?? args.target;
    return (
      (instruction.opcode === "lbl" && candidate === label) ||
      (instruction.children ?? []).some((child) => this.instructionHasLabel(child, label))
    );
  }

  private routinesForSource(source: ProgramSource): PlcRoutine[] {
    return [
      ...(source.programs ?? []).flatMap((program) => program.routines ?? []),
      ...(source.pous ?? []).flatMap((pou) => [
        ...(pou.body.routines ?? []),
        ...(pou.body.networks
          ? [
              {
                id: `${pou.id}:body`,
                name: pou.name,
                language: pou.body.language,
                networks: pou.body.networks,
              } satisfies PlcRoutine,
            ]
          : []),
      ]),
      ...(source.aois ?? []).flatMap((aoi) => aoi.routines),
    ];
  }

  private async walkRoutineInstructions(
    routine: PlcRoutine,
    visit: (instruction: InstructionNode, stack: ExecutionFrame[]) => Promise<void>,
  ): Promise<void> {
    for (const rung of routine.rungs ?? []) {
      const stack = [
        { kind: "routine", id: runtimeId(routine.id, "routine"), name: routine.name },
        { kind: "rung", id: runtimeId(rung.id, "rung"), name: rung.name },
      ] satisfies ExecutionFrame[];
      for (const instruction of rung.instructions)
        await this.walkInstruction(instruction, stack, visit);
    }
    for (const network of routine.networks ?? []) {
      const stack = [
        { kind: "routine", id: runtimeId(routine.id, "routine"), name: routine.name },
        { kind: "network", id: runtimeId(network.id, "network"), name: network.name },
      ] satisfies ExecutionFrame[];
      for (const instruction of network.instructions ?? [])
        await this.walkInstruction(instruction, stack, visit);
      for (const rung of network.rungs ?? []) {
        for (const instruction of rung.instructions)
          await this.walkInstruction(
            instruction,
            [...stack, { kind: "rung", id: runtimeId(rung.id, "rung"), name: rung.name }],
            visit,
          );
      }
    }
  }

  private async walkInstruction(
    instruction: InstructionNode,
    stack: ExecutionFrame[],
    visit: (instruction: InstructionNode, stack: ExecutionFrame[]) => Promise<void>,
  ): Promise<void> {
    await visit(instruction, stack);
    for (const child of instruction.children ?? []) await this.walkInstruction(child, stack, visit);
  }

  private raiseFault(
    severity: PlcFault["severity"],
    code: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.faults.raise({
      id: id("fault"),
      severity,
      code,
      message,
      scanNumber: this.controller.scanNumber,
      recoverable: severity !== "fatal",
      metadata,
    });
  }

  private faultCodeForError(error: Error): string {
    if (error.message.includes("array index")) return "INVALID_ARRAY_INDEX";
    if (error.message.includes("Range violation")) return "RANGE_VIOLATION";
    if (error.message.includes("Type mismatch")) return "TYPE_MISMATCH";
    if (error.message.includes("readonly")) return "READONLY_TAG";
    if (error.message.includes("Invalid tag path")) return "INVALID_TAG_PATH";
    return "TAG_RUNTIME_ERROR";
  }

  private emit(name: DebugEvent["name"], payload: unknown, stack?: ExecutionFrame[]): void {
    const event = {
      name,
      scanNumber: this.controller.scanNumber,
      timestamp: this.clock.now(),
      stack: stack ?? this.currentExecutionStack,
      payload,
    };
    this.debugger.emit(event);
    this.emitToDebugSinks(event);
    this.broadcastEvent(event);
    const access =
      name === "tag:read"
        ? "read"
        : name === "tag:write"
          ? "write"
          : name === "tag:change"
            ? "change"
            : undefined;
    const path = access ? (payload as { path?: string } | undefined)?.path : undefined;
    const breakpoint = path && access ? this.debugger.shouldBreakOnTag(path, access) : undefined;
    if (breakpoint) {
      this.pause(`Breakpoint ${breakpoint.id}`);
      const hit = {
        name: "breakpoint:hit" as const,
        scanNumber: this.controller.scanNumber,
        timestamp: this.clock.now(),
        stack: event.stack,
        payload: { breakpoint, event },
      };
      this.debugger.emit(hit);
      this.emitToDebugSinks(hit);
      this.broadcastEvent(hit);
    }
  }

  private async emitAndMaybePause(
    name: DebugEvent["name"],
    payload: unknown,
    stack?: ExecutionFrame[],
    forcePause = false,
  ): Promise<void> {
    const event = {
      name,
      scanNumber: this.controller.scanNumber,
      timestamp: this.clock.now(),
      stack,
      payload,
    };
    this.debugger.emit(event);
    this.emitToDebugSinks(event);
    const breakpoint = this.boundaryBreakpointFor(event);
    const shouldStep = this.debugger.shouldStepAt(event);
    if (this.shouldBroadcastBoundaryEvent(event, breakpoint, shouldStep, forcePause))
      this.broadcastEvent(event);
    if (!forcePause && !breakpoint && !shouldStep) return;
    this.taskWasDebugPaused = true;
    const previousMode = this.controller.mode;
    this.pause(
      forcePause || breakpoint
        ? `Breakpoint ${(breakpoint as { id?: string } | undefined)?.id ?? "hit"}`
        : `Step ${name}`,
    );
    if (breakpoint) {
      const hit = {
        name: "breakpoint:hit" as const,
        scanNumber: this.controller.scanNumber,
        timestamp: this.clock.now(),
        stack,
        payload: { breakpoint, event },
      };
      this.debugger.emit(hit);
      this.emitToDebugSinks(hit);
      this.broadcastEvent(hit);
    }
    await this.debugger.pauseAt(event);
    if (this.controller.mode === "paused") this.controller.mode = previousMode;
  }

  private boundaryBreakpointFor(event: DebugEvent) {
    if (event.name === "instruction:before") {
      const instruction = (event.payload as { instruction?: InstructionNode } | undefined)
        ?.instruction;
      if (instruction)
        return this.debugger.shouldBreakBeforeInstruction(runtimeId(instruction.id, "instruction"));
    }
    const frame = event.stack?.at(-1);
    if (frame) return this.debugger.shouldBreakOnBoundary(frame.kind, frame.id);
    return undefined;
  }

  private broadcastEvent(event: DebugEvent): void {
    for (const transport of this.transports.values()) {
      void transport.send?.({ method: "runtime.event", params: event });
    }
  }

  private recordScanMetrics(result: ScanResult, durationNs: number): void {
    this.scanMetricsHistory.push({
      scanNumber: result.scanNumber,
      durationNs,
      startedAt: result.startedAt,
    });
    if (this.scanMetricsHistory.length > 1000) {
      const removed = this.scanMetricsHistory.shift()!;
      this.scanMetricsTotalNs -= removed.durationNs;
    }
    this.scanMetricsTotalNs += durationNs;
    if (durationNs < this.scanMetricsMinNs) this.scanMetricsMinNs = durationNs;
    if (durationNs > this.scanMetricsMaxNs) this.scanMetricsMaxNs = durationNs;
    this.lastScanResult = result;
  }

  private shouldBroadcastBoundaryEvent(
    event: DebugEvent,
    breakpoint: unknown,
    shouldStep: boolean,
    forcePause: boolean,
  ): boolean {
    if (forcePause || breakpoint || shouldStep) return true;
    return (
      event.name === "fault:raise" ||
      event.name === "fault:clear" ||
      event.name === "instruction:error" ||
      event.name === "fb:error" ||
      event.name === "trace:emit"
    );
  }

  private emitToDebugSinks(event: DebugEvent): void {
    for (const sink of this.plugins.getDebugSinks()) {
      void sink.emit(event);
    }
  }
}

export function createPlcEngine(options?: EngineOptions): PlcEngine {
  return new DefaultPlcEngine(options);
}
