import { clone } from "../internal";
import type { Diagnostic, DiagnosticStore, FaultStore, PlcFault } from "../types";

export class InMemoryDiagnosticStore implements DiagnosticStore {
  private diagnostics: Diagnostic[] = [];

  add(diagnostic: Diagnostic): void {
    this.diagnostics.push(diagnostic);
  }

  list(): Diagnostic[] {
    return clone(this.diagnostics);
  }

  clear(): void {
    this.diagnostics = [];
  }

  restore(diagnostics: Diagnostic[]): void {
    this.diagnostics = clone(diagnostics);
  }
}

export class InMemoryFaultStore implements FaultStore {
  private faults: PlcFault[] = [];
  private readonly onRaise?: (fault: PlcFault) => void;
  private readonly onClear?: (fault?: PlcFault) => void;

  constructor(
    options: { onRaise?: (fault: PlcFault) => void; onClear?: (fault?: PlcFault) => void } = {},
  ) {
    this.onRaise = options.onRaise;
    this.onClear = options.onClear;
  }

  raise(fault: PlcFault): void {
    this.faults.push(fault);
    this.onRaise?.(fault);
  }

  list(): PlcFault[] {
    return clone(this.faults);
  }

  clear(id?: string): void {
    if (!id) {
      this.faults = [];
      this.onClear?.();
      return;
    }
    const fault = this.faults.find((entry) => entry.id === id);
    this.faults = this.faults.filter((entry) => entry.id !== id);
    this.onClear?.(fault);
  }

  snapshot(): PlcFault[] {
    return this.list();
  }

  restore(faults: PlcFault[]): void {
    this.faults = clone(faults);
  }
}
