import type {
  RuntimeMessage,
  RuntimeMessageListener,
  RuntimeTransport,
  Unsubscribe,
} from "@plc-emulation/core";

export interface RuntimeRpcClient {
  request<T = unknown>(method: string, params?: unknown): Promise<T>;
  notify(method: string, params?: unknown): void | Promise<void>;
  onNotification(listener: RuntimeMessageListener): Unsubscribe;
  close(): void | Promise<void>;
}

export interface RuntimeRpcClientOptions {
  transport: RuntimeTransport;
  requestTimeoutMs?: number;
}

export function createRuntimeRpcClient(options: RuntimeRpcClientOptions): RuntimeRpcClient {
  const pending = new Map<
    string | number,
    {
      resolve(value: unknown): void;
      reject(error: Error): void;
      timer?: ReturnType<typeof setTimeout>;
    }
  >();
  const notifications = new Set<RuntimeMessageListener>();
  let nextId = 1;
  const unsubscribe = options.transport.onMessage((message) => {
    if (message.id !== undefined && pending.has(message.id)) {
      const entry = pending.get(message.id);
      pending.delete(message.id);
      if (entry?.timer) clearTimeout(entry.timer);
      if (message.error) entry?.reject(new Error(message.error.message));
      else entry?.resolve(message.result);
      return;
    }
    for (const listener of notifications) void listener(message);
  });

  return {
    request<T = unknown>(method: string, params?: unknown): Promise<T> {
      const id = nextId++;
      const message = { id, method, params };
      return new Promise<T>((resolve, reject) => {
        const timer = options.requestTimeoutMs
          ? setTimeout(() => {
              pending.delete(id);
              reject(new Error(`RPC request timed out: ${method}`));
            }, options.requestTimeoutMs)
          : undefined;
        pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
        void options.transport.send?.(message);
      });
    },
    notify(method: string, params?: unknown): void | Promise<void> {
      return options.transport.send?.({ method, params });
    },
    onNotification(listener: RuntimeMessageListener): Unsubscribe {
      notifications.add(listener);
      return () => notifications.delete(listener);
    },
    close(): void | Promise<void> {
      unsubscribe();
      for (const entry of pending.values()) {
        if (entry.timer) clearTimeout(entry.timer);
        entry.reject(new Error("RPC client closed"));
      }
      pending.clear();
      return options.transport.stop?.();
    },
  };
}

export interface MemoryRuntimeTransport extends RuntimeTransport {
  emit(message: RuntimeMessage): void;
  readonly sent: RuntimeMessage[];
}

export function createMemoryTransport(id = "memory-client"): MemoryRuntimeTransport {
  const listeners = new Set<RuntimeMessageListener>();
  const sent: RuntimeMessage[] = [];
  return {
    id,
    sent,
    send(message) {
      sent.push(message);
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(message) {
      for (const listener of listeners) void listener(message);
    },
  };
}

export interface WebSocketRuntimeTransportOptions {
  url: string | { toString(): string };
  protocols?: string | string[];
  WebSocketCtor?: typeof WebSocket;
}

export function createWebSocketRuntimeTransport(
  options: WebSocketRuntimeTransportOptions,
): RuntimeTransport {
  const listeners = new Set<RuntimeMessageListener>();
  let socket: WebSocket | undefined;
  const ctor = options.WebSocketCtor ?? WebSocket;
  return {
    id: `websocket-client:${String(options.url)}`,
    async start() {
      socket = new ctor(String(options.url), options.protocols);
      socket.addEventListener("message", (event) => {
        const data = typeof event.data === "string" ? event.data : String(event.data);
        const parsed = JSON.parse(data) as RuntimeMessage;
        for (const listener of listeners) void listener(parsed);
      });
      await new Promise<void>((resolve, reject) => {
        if (!socket) return reject(new Error("WebSocket was not created"));
        socket.addEventListener("open", () => resolve(), { once: true });
        socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), {
          once: true,
        });
      });
    },
    stop() {
      socket?.close();
      socket = undefined;
    },
    send(message) {
      if (!socket || socket.readyState !== socket.OPEN)
        throw new Error("WebSocket transport is not open");
      socket.send(JSON.stringify(message));
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
