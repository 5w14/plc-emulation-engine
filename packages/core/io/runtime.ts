import { addressKey, clone } from "../internal";
import type {
  DeviceRegistry,
  DirectAddress,
  EmulatedDevice,
  IoForceState,
  IoImage,
  IoRuntime,
  IoRuntimeSnapshot,
} from "../types";

class InMemoryIoImage implements IoImage {
  private values = new Map<string, unknown>();
  private forces = new Map<string, IoForceState>();

  get<T = unknown>(address: string | DirectAddress): T {
    const key = addressKey(address);
    const force = this.forces.get(key);
    return clone((force ? force.value : this.values.get(key)) as T);
  }

  set<T = unknown>(address: string | DirectAddress, value: T): void {
    const key = addressKey(address);
    if (this.forces.has(key)) return;
    this.values.set(key, clone(value));
  }

  has(address: string | DirectAddress): boolean {
    return this.values.has(addressKey(address));
  }

  snapshot(): Record<string, unknown> {
    return clone(Object.fromEntries(this.values.entries()));
  }

  restore(snapshot: Record<string, unknown>): void {
    this.values = new Map(Object.entries(clone(snapshot)));
  }

  force(address: string | DirectAddress, value: unknown, reason?: string): void {
    const key = addressKey(address);
    this.forces.set(key, { address: key, value: clone(value), reason });
    this.values.set(key, clone(value));
  }

  unforce(address: string | DirectAddress): void {
    this.forces.delete(addressKey(address));
  }

  listForces(): IoForceState[] {
    return clone(Array.from(this.forces.values()));
  }

  restoreForces(forces: IoForceState[]): void {
    this.forces = new Map(forces.map((force) => [force.address, clone(force)]));
  }
}

class InMemoryDeviceRegistry implements DeviceRegistry {
  constructor(private readonly devices: Map<string, EmulatedDevice>) {}

  list(): EmulatedDevice[] {
    return Array.from(this.devices.values());
  }

  get(id: string): EmulatedDevice | undefined {
    return this.devices.get(id);
  }
}

export class DefaultIoRuntime implements IoRuntime {
  readonly inputs = new InMemoryIoImage();
  readonly outputs = new InMemoryIoImage();
  readonly memory = new InMemoryIoImage();
  readonly devices: DeviceRegistry;
  private readonly deviceMap = new Map<string, EmulatedDevice>();
  private readonly emit?: (name: "io:input-update" | "io:output-commit", payload: unknown) => void;

  constructor(
    options: {
      emit?: (name: "io:input-update" | "io:output-commit", payload: unknown) => void;
    } = {},
  ) {
    this.emit = options.emit;
    this.devices = new InMemoryDeviceRegistry(this.deviceMap);
  }

  async updateInputs(): Promise<void> {
    for (const device of this.deviceMap.values()) await device.updateInputs?.(this);
    this.emit?.("io:input-update", { inputs: this.inputs.snapshot() });
  }

  async commitOutputs(): Promise<void> {
    for (const device of this.deviceMap.values()) await device.commitOutputs?.(this);
    this.emit?.("io:output-commit", { outputs: this.outputs.snapshot() });
  }

  attachDevice(device: EmulatedDevice): void {
    this.deviceMap.set(device.id, device);
  }

  snapshot(): IoRuntimeSnapshot {
    return {
      inputs: this.inputs.snapshot(),
      outputs: this.outputs.snapshot(),
      memory: this.memory.snapshot(),
      forces: {
        inputs: this.inputs.listForces(),
        outputs: this.outputs.listForces(),
        memory: this.memory.listForces(),
      },
    };
  }

  restore(snapshot: IoRuntimeSnapshot): void {
    this.inputs.restore(snapshot.inputs);
    this.outputs.restore(snapshot.outputs);
    this.memory.restore(snapshot.memory);
    this.inputs.restoreForces(snapshot.forces?.inputs ?? []);
    this.outputs.restoreForces(snapshot.forces?.outputs ?? []);
    this.memory.restoreForces(snapshot.forces?.memory ?? []);
  }
}
