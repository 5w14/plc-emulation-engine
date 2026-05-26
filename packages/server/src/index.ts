import { randomUUID } from "node:crypto";
import {
  createRuntimeRpcRouter,
  type PlcEngine,
  type RuntimeMessage,
  type RuntimeRpcRouter,
  type RuntimeTransport,
  type Unsubscribe,
} from "@plc-emulation/core";

export interface RuntimeServerHandle {
  readonly router: RuntimeRpcRouter;
  stop(): void | Promise<void>;
}

export interface RuntimeHttpRequest {
  method?: string;
  json(): Promise<unknown>;
}

export interface RuntimeHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export function createRuntimeRpcHttpHandler(
  engine: PlcEngine,
  router: RuntimeRpcRouter = createRuntimeRpcRouter(engine),
) {
  return async function handleRuntimeRpcHttp(
    request: RuntimeHttpRequest,
  ): Promise<RuntimeHttpResponse> {
    if (request.method && request.method !== "POST") {
      return response({ error: { code: -32600, message: "Only POST is supported" } }, 405);
    }
    const input = await request.json();
    if (Array.isArray(input)) {
      return response(
        await Promise.all(input.map((message) => router.handle(message as RuntimeMessage))),
      );
    }
    return response(await router.handle(input as RuntimeMessage));
  };
}

export interface RuntimeWebSocketConnection {
  send(message: string): void | Promise<void>;
  close?(code?: number, reason?: string): void;
}

export function attachRuntimeRpcSocket(
  router: RuntimeRpcRouter,
  socket: RuntimeWebSocketConnection,
): RuntimeTransport {
  const listeners = new Set<(message: RuntimeMessage) => void | Promise<void>>();
  const unsubscribe =
    router.onNotification?.((message) => socket.send(JSON.stringify(message))) ?? (() => undefined);
  return {
    id: "server-socket",
    send(message) {
      return socket.send(JSON.stringify(message));
    },
    onMessage(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    stop() {
      unsubscribe();
      socket.close?.(1000, "Runtime transport stopped");
    },
  };
}

export async function handleRuntimeSocketMessage(
  router: RuntimeRpcRouter,
  socket: RuntimeWebSocketConnection,
  raw: string | ArrayBuffer | Uint8Array,
): Promise<void> {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  const parsed = JSON.parse(text) as RuntimeMessage | RuntimeMessage[];
  if (Array.isArray(parsed)) {
    for (const message of parsed) await socket.send(JSON.stringify(await router.handle(message)));
    return;
  }
  await socket.send(JSON.stringify(await router.handle(parsed)));
}

export interface BunRuntimeServerOptions {
  engine: PlcEngine;
  port?: number;
  hostname?: string;
  path?: string;
  router?: RuntimeRpcRouter;
}

export function startBunRuntimeServer(
  options: BunRuntimeServerOptions,
): RuntimeServerHandle & { url: string } {
  const router = options.router ?? createRuntimeRpcRouter(options.engine);
  const path = options.path ?? "/rpc";
  const server = Bun.serve<{
    emit(message: RuntimeMessage): void | Promise<void>;
    stop(): void;
  }>({
    port: options.port ?? 0,
    hostname: options.hostname,
    fetch: async (request, bunServer) => {
      const url = new URL(request.url);
      if (url.pathname === path && request.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const upgraded = bunServer.upgrade(request, {
          data: {
            emit: async () => undefined,
            stop: () => undefined,
          },
        });
        return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 });
      }
      if (url.pathname === path) {
        const handler = createRuntimeRpcHttpHandler(options.engine, router);
        const result = await handler(request);
        return new Response(result.body, { status: result.status, headers: result.headers });
      }
      if (url.pathname === "/health")
        return Response.json({ ok: true, package: "@plc-emulation/server" });
      return new Response("Not Found", { status: 404 });
    },
    websocket: {
      open(ws) {
        const listeners = new Set<(message: RuntimeMessage) => void | Promise<void>>();
        const unsubscribe = options.engine.attachTransport({
          id: `server-socket:${randomUUID()}`,
          send(message) {
            ws.send(JSON.stringify(message));
          },
          onMessage(listener) {
            listeners.add(listener);
            return () => listeners.delete(listener);
          },
          stop() {
            listeners.clear();
          },
        });
        ws.data.emit = (message: RuntimeMessage) => {
          for (const listener of listeners) void listener(message);
        };
        ws.data.stop = unsubscribe;
      },
      async message(ws, message) {
        const text = typeof message === "string" ? message : new TextDecoder().decode(message);
        const parsed = JSON.parse(text) as RuntimeMessage | RuntimeMessage[];
        if (Array.isArray(parsed)) {
          for (const item of parsed) await ws.data.emit(item);
          return;
        }
        await ws.data.emit(parsed);
      },
      close(ws) {
        ws.data.stop();
      },
    },
  });

  return {
    router,
    url: `http://${server.hostname}:${server.port}${path}`,
    stop() {
      server.stop(true);
    },
  };
}

function response(value: unknown, status = 200): RuntimeHttpResponse {
  return {
    status,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  };
}
