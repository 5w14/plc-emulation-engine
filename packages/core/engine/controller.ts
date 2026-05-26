import type { ControllerMode, ControllerRuntime } from "../types";
import type { InMemoryFaultStore } from "../faults/stores";

export class DefaultControllerRuntime implements ControllerRuntime {
  mode: ControllerMode = "test";
  scanNumber = 0;
  reason?: string;

  constructor(private readonly faults: InMemoryFaultStore) {}

  setMode(mode: ControllerMode): void {
    this.mode = mode;
    this.reason = undefined;
  }

  clearFaults(): void {
    this.faults.clear();
    if (this.mode === "faulted") this.mode = "program";
  }
}
