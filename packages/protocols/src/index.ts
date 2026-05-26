import type { EmulatedDevice, IoRuntime, TagStore, VariableDeclaration } from "@plc-emulation/core";

export interface ProtocolBinding {
  tag: string;
  address: string;
  direction?: "input" | "output" | "memory" | "readwrite";
  scale?: number;
}

export interface ModbusDeviceOptions {
  id: string;
  coils?: ProtocolBinding[];
  discreteInputs?: ProtocolBinding[];
  holdingRegisters?: ProtocolBinding[];
  inputRegisters?: ProtocolBinding[];
}

export function createModbusDevice(options: ModbusDeviceOptions): EmulatedDevice {
  return {
    id: options.id,
    updateInputs(io: IoRuntime) {
      for (const binding of [
        ...(options.discreteInputs ?? []),
        ...(options.inputRegisters ?? []),
      ]) {
        const source = binding.direction === "memory" ? io.memory : io.inputs;
        if (source.has(binding.address))
          io.memory.set(binding.tag, applyScale(source.get(binding.address), binding.scale));
      }
    },
    commitOutputs(io: IoRuntime) {
      for (const binding of [...(options.coils ?? []), ...(options.holdingRegisters ?? [])]) {
        const value = io.memory.get(binding.tag);
        if (value !== undefined) io.outputs.set(binding.address, removeScale(value, binding.scale));
      }
    },
  };
}

export interface MqttClientLike {
  publish(topic: string, payload: string): void | Promise<void>;
  subscribe(
    topic: string,
    listener: (payload: string) => void | Promise<void>,
  ): void | Promise<void> | (() => void);
}

export interface MqttTagBinding {
  topic: string;
  tag: string;
  direction: "publish" | "subscribe" | "both";
}

export interface MqttTagBridge {
  start(): Promise<void>;
  stop(): void;
  publishAll(): Promise<void>;
}

export function createMqttTagBridge(options: {
  tags: TagStore;
  client: MqttClientLike;
  bindings: MqttTagBinding[];
}): MqttTagBridge {
  const unsubscribers: Array<() => void> = [];
  return {
    async start() {
      for (const binding of options.bindings) {
        if (binding.direction === "publish" || binding.direction === "both") {
          unsubscribers.push(
            options.tags.subscribe(binding.tag, (event) => {
              void options.client.publish(binding.topic, JSON.stringify(event.value));
            }),
          );
        }
        if (binding.direction === "subscribe" || binding.direction === "both") {
          const maybeUnsubscribe = await options.client.subscribe(binding.topic, (payload) => {
            options.tags.set(binding.tag, parsePayload(payload));
          });
          if (typeof maybeUnsubscribe === "function") unsubscribers.push(maybeUnsubscribe);
        }
      }
    },
    stop() {
      while (unsubscribers.length > 0) unsubscribers.pop()?.();
    },
    async publishAll() {
      for (const binding of options.bindings.filter(
        (entry) => entry.direction === "publish" || entry.direction === "both",
      )) {
        await options.client.publish(binding.topic, JSON.stringify(options.tags.get(binding.tag)));
      }
    },
  };
}

export interface EtherNetIpTagService {
  listTags(): Array<{ name: string; type?: unknown; value: unknown }>;
  readTag<T = unknown>(path: string): T;
  writeTag<T = unknown>(path: string, value: T): void;
}

export function createEtherNetIpTagService(tags: TagStore): EtherNetIpTagService {
  return {
    listTags() {
      return tags
        .list()
        .map((tag) => ({ name: tag.canonicalPath, type: tag.declaration?.type, value: tag.value }));
    },
    readTag<T = unknown>(path: string): T {
      return tags.get<T>(path);
    },
    writeTag<T = unknown>(path: string, value: T): void {
      tags.set(path, value);
    },
  };
}

export interface OpcUaNode {
  nodeId: string;
  browseName: string;
  dataType?: unknown;
  value: unknown;
}

export interface OpcUaAddressSpaceFacade {
  browse(): OpcUaNode[];
  readNode<T = unknown>(nodeId: string): T;
  writeNode<T = unknown>(nodeId: string, value: T): void;
  declareVariable(declaration: VariableDeclaration): void;
}

export function createOpcUaAddressSpace(
  tags: TagStore,
  options: { namespace?: string } = {},
): OpcUaAddressSpaceFacade {
  const namespace = options.namespace ?? "ns=1;s=";
  const pathFromNode = (nodeId: string) =>
    nodeId.startsWith(namespace) ? nodeId.slice(namespace.length) : nodeId;
  const nodeFromPath = (path: string) => `${namespace}${path}`;
  return {
    browse() {
      return tags.list().map((tag) => ({
        nodeId: nodeFromPath(tag.canonicalPath),
        browseName: tag.canonicalPath,
        dataType: tag.declaration?.type,
        value: tag.value,
      }));
    },
    readNode<T = unknown>(nodeId: string): T {
      return tags.get<T>(pathFromNode(nodeId));
    },
    writeNode<T = unknown>(nodeId: string, value: T): void {
      tags.set(pathFromNode(nodeId), value);
    },
    declareVariable(declaration: VariableDeclaration): void {
      tags.declare(declaration);
    },
  };
}

function applyScale(value: unknown, scale = 1): unknown {
  return typeof value === "number" ? value * scale : value;
}

function removeScale(value: unknown, scale = 1): unknown {
  return typeof value === "number" ? value / scale : value;
}

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}
