import { describe, expect, test } from "bun:test";
import { createPlcEngine, createRuntimeRpcRouter } from "@plc-emulation/core";
import { createMemoryTransport, createRuntimeRpcClient } from "../../packages/client/src/index";
import {
  createRuntimeRpcHttpHandler,
  handleRuntimeSocketMessage,
  startBunRuntimeServer,
  type RuntimeWebSocketConnection,
} from "../../packages/server/src/index";
import { runCli, type CliIo } from "../../packages/cli/src/index";
import {
  createEtherNetIpTagService,
  createModbusDevice,
  createMqttTagBridge,
  createOpcUaAddressSpace,
} from "../../packages/protocols/src/index";

const fixture = {
  name: "Fixture",
  tags: [
    { name: "Start", type: "BOOL", initialValue: true },
    { name: "Out", type: "BOOL", initialValue: false },
  ],
  programs: [
    {
      id: "p",
      name: "P",
      routines: [
        {
          id: "r",
          name: "R",
          language: "ladder",
          rungs: [
            {
              id: "r1",
              instructions: [
                { id: "i", opcode: "xic", args: { tag: "Start" } },
                { id: "o", opcode: "ote", args: { tag: "Out" } },
              ],
            },
          ],
        },
      ],
    },
  ],
};

describe("workspace packages", () => {
  test("client JSON-RPC works over memory transport", async () => {
    const transport = createMemoryTransport();
    const client = createRuntimeRpcClient({ transport, requestTimeoutMs: 1000 });
    const request = client.request("engine.info");
    const sent = transport.sent[0];
    expect(sent?.method).toBe("engine.info");
    transport.emit({ id: sent?.id, result: { ok: true } });

    expect(await request).toEqual({ ok: true });
    await client.close();
  });

  test("server HTTP handler and socket message handler route core RPC", async () => {
    const engine = createPlcEngine();
    const http = createRuntimeRpcHttpHandler(engine);
    const response = await http({
      method: "POST",
      async json() {
        return { id: 1, method: "engine.info" };
      },
    });
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body).result.name).toBe("@plc-emulation/core");

    const sent: string[] = [];
    const socket: RuntimeWebSocketConnection = { send: (message) => sent.push(message) };
    await handleRuntimeSocketMessage(
      createRuntimeRpcRouter(engine),
      socket,
      JSON.stringify({ id: 2, method: "engine.mode.get" }),
    );
    expect(JSON.parse(sent[0] ?? "{}").result).toBe("test");
  });

  test("Bun server adapter starts HTTP JSON-RPC without adding server code to core", async () => {
    const engine = createPlcEngine();
    const server = startBunRuntimeServer({ engine, port: 0, hostname: "127.0.0.1" });
    try {
      const response = await fetch(server.url, {
        method: "POST",
        body: JSON.stringify({ id: 1, method: "engine.info" }),
        headers: { "content-type": "application/json" },
      });
      const payload = await response.json();
      expect(payload.result.name).toBe("@plc-emulation/core");
    } finally {
      server.stop();
    }
  });

  test("CLI scans IR JSON and exposes tag commands", async () => {
    const output: string[] = [];
    const errors: string[] = [];
    const io: CliIo = {
      stdout: (message) => output.push(message),
      stderr: (message) => errors.push(message),
      readText: async () => JSON.stringify(fixture),
    };

    const scan = await runCli(["scan", "--program", "fixture.json"], io);
    const get = await runCli(["tag:get", "--program", "fixture.json", "--tag", "Start"], io);
    const set = await runCli(
      ["tag:set", "--program", "fixture.json", "--tag", "Start", "--value", "false"],
      io,
    );

    expect(scan.exitCode).toBe(0);
    expect(get.value).toBe(true);
    expect(set.value).toBe(false);
    expect(errors).toHaveLength(0);
    expect(output.length).toBeGreaterThan(0);
  });

  test("protocol adapters expose Modbus, MQTT, EtherNet/IP, and OPC UA facades", async () => {
    const engine = createPlcEngine();
    engine.tags.declare({ name: "Start", type: "BOOL", initialValue: false });
    engine.tags.declare({ name: "Count", type: "DINT", initialValue: 0 });
    engine.io.inputs.set("10001", true);
    engine.io.memory.set("Start", false);
    const modbus = createModbusDevice({
      id: "modbus",
      discreteInputs: [{ tag: "Start", address: "10001" }],
      holdingRegisters: [{ tag: "Count", address: "40001" }],
    });
    engine.io.attachDevice(modbus);
    await engine.io.updateInputs();
    expect(engine.io.memory.get("Start")).toBe(true);

    engine.io.memory.set("Count", 42);
    await engine.io.commitOutputs();
    expect(engine.io.outputs.get("40001")).toBe(42);

    const published: Array<{ topic: string; payload: string }> = [];
    const subscribers = new Map<string, (payload: string) => void>();
    const bridge = createMqttTagBridge({
      tags: engine.tags,
      client: {
        publish(topic, payload) {
          published.push({ topic, payload });
        },
        subscribe(topic, listener) {
          subscribers.set(topic, listener);
          return () => subscribers.delete(topic);
        },
      },
      bindings: [{ topic: "plc/start", tag: "Start", direction: "both" }],
    });
    await bridge.start();
    await bridge.publishAll();
    subscribers.get("plc/start")?.("true");
    expect(engine.tags.get("Start")).toBe(true);
    expect(published[0]?.topic).toBe("plc/start");
    bridge.stop();

    const enip = createEtherNetIpTagService(engine.tags);
    enip.writeTag("Count", 7);
    expect(enip.readTag("Count")).toBe(7);
    expect(enip.listTags().some((tag) => tag.name === "Count")).toBe(true);

    const opcua = createOpcUaAddressSpace(engine.tags);
    opcua.writeNode("ns=1;s=Count", 9);
    expect(opcua.readNode("ns=1;s=Count")).toBe(9);
    expect(opcua.browse().some((node) => node.browseName === "Count")).toBe(true);
  });
});
