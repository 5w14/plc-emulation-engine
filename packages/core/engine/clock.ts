import type { ClockSnapshot, PlcClock } from "../types";

function getHighResTimeNs(): number {
  if (typeof Bun !== "undefined" && "nanoseconds" in Bun) {
    return Number(Bun.nanoseconds());
  }
  if (typeof process !== "undefined" && "hrtime" in process && "bigint" in process.hrtime) {
    return Number(process.hrtime.bigint());
  }
  return (globalThis.performance?.now() ?? Date.now()) * 1_000_000;
}

export class DefaultPlcClock implements PlcClock {
  private mode: "real" | "virtual" = "virtual";
  private virtualNow = 0;

  now(): number {
    if (this.mode === "virtual") return this.virtualNow;
    return globalThis.performance?.now() ?? Date.now();
  }

  highResTime(): number {
    if (this.mode === "virtual") return this.virtualNow * 1_000_000;
    return getHighResTimeNs();
  }

  advance(ms: number): void {
    this.virtualNow += ms;
  }

  useRealTime(): void {
    this.mode = "real";
  }

  useVirtualTime(startMs = 0): void {
    this.mode = "virtual";
    this.virtualNow = startMs;
  }

  snapshot(): ClockSnapshot {
    return { mode: this.mode, nowMs: this.now() };
  }

  restore(snapshot: ClockSnapshot): void {
    this.mode = snapshot.mode;
    this.virtualNow = snapshot.nowMs;
  }
}
