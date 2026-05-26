import { clone } from "../internal";
import type { InstructionMemory } from "../types";

export class MapInstructionMemory implements InstructionMemory {
  private data = new Map<string, unknown>();

  get<T = unknown>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  set<T = unknown>(key: string, value: T): void {
    this.data.set(key, value);
  }

  delete(key: string): void {
    this.data.delete(key);
  }

  snapshot(): Record<string, unknown> {
    return clone(Object.fromEntries(this.data.entries()));
  }

  restore(snapshot: Record<string, unknown>): void {
    this.data = new Map(Object.entries(clone(snapshot)));
  }
}
