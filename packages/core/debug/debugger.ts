import { clone, id } from "../internal";
import type {
  Breakpoint,
  BreakpointInput,
  DebugEvent,
  DebugEventName,
  DebugListener,
  DebugSnapshot,
  ExecutionFrame,
  PlcDebugger,
  StepResult,
  Trace,
  TraceInput,
  Unsubscribe,
  Watch,
  WatchInput,
} from "../types";

export class DefaultPlcDebugger implements PlcDebugger {
  private listeners = new Map<DebugEventName, Set<DebugListener>>();
  private breakpoints: Breakpoint[] = [];
  private tagBreakpoints = new Map<string, Breakpoint[]>();
  private watches: Watch[] = [];
  private watchesByPath = new Map<string, Watch[]>();
  private traces: Trace[] = [];
  private lastEvent?: DebugEvent;
  private pausedEvent?: DebugEvent;
  private resumePaused?: () => void;
  private stepMode?: Parameters<PlcDebugger["step"]>[0];

  addBreakpoint(input: BreakpointInput): Breakpoint {
    const breakpoint = { id: id("breakpoint"), input, enabled: true };
    this.breakpoints.push(breakpoint);
    this.indexBreakpoint(breakpoint);
    return clone(breakpoint);
  }

  removeBreakpoint(id: string): void {
    const removed = this.breakpoints.find((breakpoint) => breakpoint.id === id);
    this.breakpoints = this.breakpoints.filter((breakpoint) => breakpoint.id !== id);
    if (removed) this.unindexBreakpoint(removed);
  }

  listBreakpoints(): Breakpoint[] {
    return clone(this.breakpoints);
  }

  addWatch(input: WatchInput): Watch {
    const watch = { id: id("watch"), input, value: undefined };
    this.watches.push(watch);
    this.addWatchIndex(watch);
    return clone(watch);
  }

  removeWatch(id: string): void {
    const removed = this.watches.find((watch) => watch.id === id);
    this.watches = this.watches.filter((watch) => watch.id !== id);
    if (removed) this.removeWatchIndex(removed);
  }

  trace(input: TraceInput): Trace {
    const trace = { id: id("trace"), input, samples: [] };
    this.traces.push(trace);
    return clone(trace);
  }

  removeTrace(id: string): void {
    this.traces = this.traces.filter((trace) => trace.id !== id);
  }

  async step(mode: Parameters<PlcDebugger["step"]>[0]): Promise<StepResult> {
    this.stepMode = mode;
    const event = this.pausedEvent ?? this.lastEvent;
    const wasPaused = Boolean(this.resumePaused);
    this.resumePaused?.();
    return {
      event: event ? clone(event) : undefined,
      stack: clone(event?.stack ?? []),
      resumed: wasPaused,
    };
  }

  async continue(): Promise<void> {
    this.stepMode = undefined;
    this.resumePaused?.();
    return;
  }

  on(event: DebugEventName, listener: DebugListener): Unsubscribe {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
    return () => listeners?.delete(listener);
  }

  emit(event: DebugEvent): void {
    this.lastEvent = event;
    const payload = event.payload as { path?: string; value?: unknown } | undefined;
    if (event.name === "tag:read" || event.name === "tag:write" || event.name === "tag:change") {
      const watches = payload?.path ? this.watchesByPath.get(payload.path) : undefined;
      if (watches) for (const watch of watches) watch.value = payload?.value;
    }
    const listeners = this.listeners.get(event.name);
    if (!listeners || listeners.size === 0) return;
    const cloned = clone(event);
    for (const listener of listeners) listener(cloned);
  }

  snapshot(): DebugSnapshot {
    return {
      breakpoints: clone(this.breakpoints),
      watches: clone(this.watches),
      traces: clone(this.traces),
      lastEvent: clone(this.pausedEvent ?? this.lastEvent),
    };
  }

  restore(snapshot: DebugSnapshot): void {
    this.breakpoints = clone(snapshot.breakpoints);
    this.watches = clone(snapshot.watches);
    this.traces = clone(snapshot.traces);
    this.rebuildIndexes();
  }

  shouldBreakBeforeInstruction(instructionId: string): Breakpoint | undefined {
    return this.breakpoints.find(
      (breakpoint) =>
        breakpoint.enabled &&
        breakpoint.input.kind === "instruction" &&
        breakpoint.input.instructionId === instructionId,
    );
  }

  shouldBreakOnBoundary(kind: ExecutionFrame["kind"], id: string): Breakpoint | undefined {
    return this.breakpoints.find(
      (breakpoint) =>
        breakpoint.enabled &&
        breakpoint.input.kind === "boundary" &&
        breakpoint.input.boundary === kind &&
        breakpoint.input.id === id,
    );
  }

  shouldBreakOnTag(path: string, access: "read" | "write" | "change"): Breakpoint | undefined {
    return (
      this.tagBreakpoints
        .get(tagBreakpointKey(path, access))
        ?.find((breakpoint) => breakpoint.enabled) ??
      this.tagBreakpoints
        .get(tagBreakpointKey(path, undefined))
        ?.find((breakpoint) => breakpoint.enabled)
    );
  }

  shouldStepAt(event: DebugEvent): boolean {
    if (!this.stepMode) return false;
    if (this.stepMode === "instruction") return event.name === "instruction:before";
    if (this.stepMode === "scan") return event.name === "scan:start" || event.name === "scan:end";
    if (this.stepMode === "task") return event.name === "task:start";
    if (this.stepMode === "program") return event.name === "program:start";
    if (this.stepMode === "routine") return event.name === "routine:start";
    if (this.stepMode === "network") return event.name === "network:start";
    if (this.stepMode === "rung") return event.name === "rung:start";
    if (this.stepMode === "into-fb" || this.stepMode === "into-aoi")
      return event.name === "fb:before" || event.name === "instruction:before";
    if (this.stepMode === "over-fb" || this.stepMode === "over-aoi")
      return event.name === "fb:after";
    return false;
  }

  async pauseAt(event: DebugEvent): Promise<void> {
    this.pausedEvent = clone(event);
    await new Promise<void>((resolve) => {
      this.resumePaused = () => {
        this.pausedEvent = undefined;
        this.resumePaused = undefined;
        resolve();
      };
    });
  }

  private indexBreakpoint(breakpoint: Breakpoint): void {
    if (breakpoint.input.kind !== "tag") return;
    const key = tagBreakpointKey(breakpoint.input.path, breakpoint.input.access);
    const bucket = this.tagBreakpoints.get(key);
    if (bucket) bucket.push(breakpoint);
    else this.tagBreakpoints.set(key, [breakpoint]);
  }

  private unindexBreakpoint(breakpoint: Breakpoint): void {
    if (breakpoint.input.kind !== "tag") return;
    const key = tagBreakpointKey(breakpoint.input.path, breakpoint.input.access);
    const bucket = this.tagBreakpoints.get(key);
    if (!bucket) return;
    const next = bucket.filter((item) => item.id !== breakpoint.id);
    if (next.length > 0) this.tagBreakpoints.set(key, next);
    else this.tagBreakpoints.delete(key);
  }

  private addWatchIndex(watch: Watch): void {
    const bucket = this.watchesByPath.get(watch.input.path);
    if (bucket) bucket.push(watch);
    else this.watchesByPath.set(watch.input.path, [watch]);
  }

  private removeWatchIndex(watch: Watch): void {
    const bucket = this.watchesByPath.get(watch.input.path);
    if (!bucket) return;
    const next = bucket.filter((item) => item.id !== watch.id);
    if (next.length > 0) this.watchesByPath.set(watch.input.path, next);
    else this.watchesByPath.delete(watch.input.path);
  }

  private rebuildIndexes(): void {
    this.tagBreakpoints.clear();
    this.watchesByPath.clear();
    for (const breakpoint of this.breakpoints) this.indexBreakpoint(breakpoint);
    for (const watch of this.watches) this.addWatchIndex(watch);
  }

  recordTraces(
    read: (path: string) => unknown,
    scanNumber: number,
    timestamp: number,
  ): DebugEvent[] {
    const events: DebugEvent[] = [];
    for (const trace of this.traces) {
      const every = trace.input.everyScans ?? 1;
      if (scanNumber % every !== 0) continue;
      const value = read(trace.input.path);
      trace.samples.push({ scanNumber, timestamp, value: clone(value) });
      events.push({
        name: "trace:emit",
        scanNumber,
        timestamp,
        payload: { traceId: trace.id, path: trace.input.path, value },
      });
    }
    return events;
  }
}

function tagBreakpointKey(path: string, access: "read" | "write" | "change" | undefined): string {
  return `${path}:${access ?? ""}`;
}
