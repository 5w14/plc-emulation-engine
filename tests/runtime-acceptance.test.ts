import { describe, expect, test } from "bun:test";
import {
  createPlcEngine,
  createRuntimeRpcRouter,
  type PlcPlugin,
  type DebugEvent,
  type RuntimeMessage,
  type RuntimeMessageListener,
  type RuntimeTransport,
  type Unsubscribe,
} from "@plc-emulation/core";

describe("runtime acceptance edges", () => {
  test("loadProgram generates omitted source ids while preserving explicit instruction ids", async () => {
    const engine = createPlcEngine();
    await engine.loadProgram({
      name: "GeneratedIds",
      configuration: {
        name: "Cfg",
        resources: [
          {
            name: "Resource",
            tasks: [{ name: "Task", kind: "continuous", priority: 1 }],
            programs: [{ name: "Instance", program: "Program", task: "Task" }],
          },
        ],
      },
      tags: [
        { name: "A", type: "BOOL", initialValue: true },
        { name: "B", type: "BOOL", initialValue: false },
      ],
      programs: [
        {
          name: "Program",
          routines: [
            {
              name: "Routine",
              language: "ladder",
              rungs: [
                {
                  instructions: [
                    { opcode: "xic", args: { tag: "A" } },
                    { id: "monitor-me", opcode: "ote", args: { tag: "B" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    await engine.scan();
    expect(engine.tags.get("B")).toBe(true);
    expect(engine.diagnostics.list().some((entry) => entry.code === "MISSING_ID")).toBe(false);

    const source = engine.configuration.loadedPrograms[0]?.source;
    expect(source?.configuration?.id).toBeString();
    expect(source?.configuration?.resources[0]?.id).toBeString();
    expect(source?.configuration?.resources[0]?.tasks[0]?.id).toBeString();
    expect(source?.programs?.[0]?.id).toBeString();
    expect(source?.programs?.[0]?.routines?.[0]?.id).toBeString();
    expect(source?.programs?.[0]?.routines?.[0]?.rungs?.[0]?.id).toBeString();
    expect(source?.programs?.[0]?.routines?.[0]?.rungs?.[0]?.instructions[0]?.id).toBeString();
    expect(source?.programs?.[0]?.routines?.[0]?.rungs?.[0]?.instructions[1]?.id).toBe(
      "monitor-me",
    );

    const breakpoint = engine.debugger.addBreakpoint({
      kind: "instruction",
      instructionId: "monitor-me",
    });
    expect(breakpoint.input).toEqual({ kind: "instruction", instructionId: "monitor-me" });
  });

  test("debugger pauses before instructions and steps to the next instruction", async () => {
    const engine = createPlcEngine();
    await engine.loadProgram({
      name: "Step",
      tags: [
        { name: "A", type: "BOOL", initialValue: true },
        { name: "B", type: "BOOL", initialValue: false },
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
                    { id: "i1", opcode: "xic", args: { tag: "A" } },
                    { id: "i2", opcode: "ote", args: { tag: "B" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const before: string[] = [];
    engine.debugger.on("instruction:before", (event) =>
      before.push((event.payload as { instruction: { id: string } }).instruction.id),
    );
    engine.debugger.addBreakpoint({ kind: "instruction", instructionId: "i1" });
    const scan = engine.scan();
    await waitFor(() => engine.controller.mode === "paused" && before.length === 1);

    const step = await engine.debugger.step("instruction");
    expect(step.resumed).toBe(true);
    await waitFor(() => engine.controller.mode === "paused" && before.length === 2);

    await engine.debugger.continue();
    await scan;
    expect(before).toEqual(["i1", "i2"]);
    expect(engine.tags.get("B")).toBe(true);
  });

  test("controller resume from a breakpoint releases the scan and breaks again on the next scan", async () => {
    const engine = createPlcEngine();
    await engine.loadProgram({
      name: "ResumeBreakpoint",
      tags: [
        { name: "A", type: "BOOL", initialValue: true },
        { name: "B", type: "BOOL", initialValue: false },
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
                    { id: "i1", opcode: "xic", args: { tag: "A" } },
                    { id: "i2", opcode: "ote", args: { tag: "B" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const hits: number[] = [];
    engine.debugger.on("breakpoint:hit", (event) => hits.push(event.scanNumber));
    engine.debugger.addBreakpoint({ kind: "instruction", instructionId: "i1" });
    const run = await engine.run({ maxScans: 2 });

    await waitFor(() => engine.controller.mode === "paused" && hits.length === 1);
    expect(hits).toEqual([1]);

    engine.resume();
    await waitFor(() => engine.controller.mode === "paused" && hits.length === 2);
    expect(hits).toEqual([1, 2]);

    await engine.debugger.continue();
    await run.done;
    expect(engine.controller.scanNumber).toBe(2);
  });

  test("controller resume after a manual pause can stop on a later breakpoint", async () => {
    const engine = createPlcEngine();
    await engine.loadProgram({
      name: "ResumeAfterManualPause",
      configuration: {
        id: "c",
        name: "C",
        resources: [
          {
            id: "res",
            name: "Resource",
            tasks: [
              { id: "continuous", name: "Continuous", kind: "continuous", priority: 10 },
              { id: "event", name: "Event", kind: "event", priority: 1 },
            ],
            programs: [
              { id: "idle-instance", name: "Idle", program: "idle", task: "continuous" },
              { id: "event-instance", name: "EventLogic", program: "event-program", task: "event" },
            ],
          },
        ],
      },
      tags: [{ name: "A", type: "BOOL", initialValue: true }],
      programs: [
        {
          id: "idle",
          name: "Idle",
          routines: [
            {
              id: "idle-routine",
              name: "IdleRoutine",
              language: "ladder",
              rungs: [{ id: "idle-rung", instructions: [{ id: "idle-nop", opcode: "nop" }] }],
            },
          ],
        },
        {
          id: "event-program",
          name: "EventProgram",
          routines: [
            {
              id: "event-routine",
              name: "EventRoutine",
              language: "ladder",
              rungs: [
                {
                  id: "event-rung",
                  instructions: [
                    { id: "breakpoint-instruction", opcode: "xic", args: { tag: "A" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const hits: number[] = [];
    engine.debugger.on("breakpoint:hit", (event) => hits.push(event.scanNumber));
    engine.debugger.addBreakpoint({
      kind: "instruction",
      instructionId: "breakpoint-instruction",
    });
    engine.triggerEventTask("event");
    const run = await engine.run({ maxScans: 4, intervalMs: 2 });

    await waitFor(() => engine.controller.mode === "paused" && hits.length === 1);
    expect(hits).toEqual([1]);

    engine.resume();
    await waitFor(() => engine.controller.scanNumber >= 2 && engine.controller.mode === "run");
    engine.pause("Manual pause from debugger");
    await waitFor(() => engine.controller.mode === "paused");
    expect(hits).toEqual([1]);

    engine.triggerEventTask("event");
    engine.resume();
    await waitFor(() => engine.controller.mode === "paused" && hits.length === 2);
    expect(hits[1]).toBeGreaterThan(hits[0] ?? 0);

    engine.resume();
    await run.done;
    expect(engine.controller.scanNumber).toBeGreaterThanOrEqual(3);
  });

  test("tag breakpoints during run pause once per completed scan after resume", async () => {
    const engine = createPlcEngine();
    await engine.loadProgram({
      name: "ResumeTagBreakpoint",
      tags: [
        { name: "A", type: "BOOL", initialValue: true },
        { name: "B", type: "BOOL", initialValue: false },
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
                    { id: "i1", opcode: "xic", args: { tag: "A" } },
                    { id: "i2", opcode: "ote", args: { tag: "B" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const hits: number[] = [];
    engine.debugger.on("breakpoint:hit", (event) => hits.push(event.scanNumber));
    engine.debugger.addBreakpoint({ kind: "tag", path: "B", access: "write" });
    const run = await engine.run({ maxScans: 2 });

    await waitFor(() => engine.controller.mode === "paused" && hits.length === 1);
    expect(hits).toEqual([1]);

    engine.resume();
    await waitFor(() => engine.controller.mode === "paused" && hits.length === 2);
    expect(hits).toEqual([1, 2]);

    engine.resume();
    await run.done;
    expect(engine.controller.scanNumber).toBe(2);
  });

  test("tag breakpoints follow AOI inout member writes back to the bound controller tag", async () => {
    const engine = createPlcEngine();
    await engine.loadProgram({
      name: "AoiBoundTagWatch",
      tags: [
        {
          name: "GlobalData",
          type: {
            kind: "struct",
            members: { Value: { name: "Value", type: "BOOL", initialValue: false } },
          },
          initialValue: { Value: false },
        },
      ],
      aois: [
        {
          name: "AOI_TEST",
          parameters: [
            {
              name: "DATA",
              direction: "inout",
              type: {
                kind: "struct",
                members: { Value: { name: "Value", type: "BOOL", initialValue: false } },
              },
            },
          ],
          routines: [
            {
              name: "AoiRoutine",
              language: "ladder",
              rungs: [
                {
                  id: "aoi-rung",
                  instructions: [{ id: "aoi-write", opcode: "ote", args: { tag: "DATA.Value" } }],
                },
              ],
            },
          ],
        },
      ],
      programs: [
        {
          name: "P",
          routines: [
            {
              name: "MainRoutine",
              language: "ladder",
              rungs: [
                {
                  id: "main-rung",
                  instructions: [
                    {
                      id: "call-aoi",
                      opcode: "fb.call",
                      args: {
                        definition: "AOI_TEST",
                        instance: "AOI_TEST_1",
                        parameters: { DATA: "GlobalData" },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    const hits: unknown[] = [];
    let hitStack: Array<{ id?: string }> | undefined;
    engine.debugger.on("breakpoint:hit", (event) => {
      hits.push((event.payload as { breakpoint: { input: unknown } }).breakpoint.input);
      hitStack = event.stack;
    });
    engine.debugger.addBreakpoint({ kind: "tag", path: "GlobalData.Value", access: "write" });

    const run = await engine.run({ maxScans: 1 });
    await waitFor(() => engine.controller.mode === "paused" && hits.length === 1);
    expect(hits[0]).toEqual({ kind: "tag", path: "GlobalData.Value", access: "write" });
    expect(hitStack?.at(-1)?.id).toBe("aoi-write");

    engine.resume();
    await run.done;
    expect(engine.tags.get("GlobalData.Value")).toBe(true);
  });

  test("tag watchpoints, trace cadence, and transport event notifications work without sockets", async () => {
    const engine = createPlcEngine();
    await engine.loadProgram({
      name: "Debug",
      tags: [
        { name: "A", type: "BOOL", initialValue: true },
        { name: "B", type: "BOOL", initialValue: false },
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
                    { id: "i1", opcode: "xic", args: { tag: "A" } },
                    { id: "i2", opcode: "ote", args: { tag: "B" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const sent: RuntimeMessage[] = [];
    const transport = memoryTransport(sent);
    const detach = engine.attachTransport(transport);
    const hits: RuntimeMessage[] = [];
    engine.debugger.on("breakpoint:hit", (event) => hits.push({ method: "hit", params: event }));
    const breakpoint = engine.debugger.addBreakpoint({ kind: "tag", path: "B", access: "write" });
    const trace = engine.debugger.trace({ path: "B", everyScans: 5 });

    await engine.scan();
    engine.debugger.removeBreakpoint(breakpoint.id);
    engine.resume();
    for (let index = 0; index < 4; index += 1) await engine.scan();

    expect(hits).toHaveLength(1);
    expect(
      engine.debugger.snapshot().traces.find((entry) => entry.id === trace.id)?.samples,
    ).toHaveLength(1);
    expect(sent.some((message) => message.method === "runtime.event")).toBe(true);
    detach();
  });

  test("tag store enforces readonly, type mismatch, range, invalid index, and quality", () => {
    const engine = createPlcEngine();
    engine.tags.declare({ name: "Readonly", type: "BOOL", initialValue: false, readonly: true });
    engine.tags.declare({
      name: "Speed",
      type: { kind: "subrange", baseType: "INT", min: 0, max: 10 },
      initialValue: 1,
    });
    engine.tags.declare({
      name: "Mode",
      type: { kind: "enum", values: ["Off", "Auto"] },
      initialValue: "Off",
    });
    engine.tags.declare({
      name: "Array",
      type: { kind: "array", elementType: "DINT", dimensions: [{ lower: 0, upper: 1 }] },
    });

    expect(() => engine.tags.set("Readonly", true)).toThrow("readonly");
    expect(() => engine.tags.set("Speed", 11)).toThrow("Range violation");
    expect(() => engine.tags.set("Mode", "Manual")).toThrow("Range violation");
    expect(() => engine.tags.set("Array[9]", 1)).toThrow("Array index out of range");
    expect(() => engine.tags.set("Speed", "fast")).toThrow("Type mismatch");
    engine.tags.force("Speed", 4, { reason: "test" });

    expect(engine.tags.quality("Speed").quality).toBe("forced");
    expect(engine.faults.list().map((fault) => fault.code)).toContain("RANGE_VIOLATION");
  });

  test("plugin setup, RPC methods, lifecycle hooks, and watchdog faults are enforced", async () => {
    const engine = createPlcEngine();
    engine.tags.declare({ name: "Pre", type: "DINT", initialValue: 0 });
    engine.tags.declare({ name: "Post", type: "DINT", initialValue: 0 });
    const plugin: PlcPlugin = {
      id: "acceptance-plugin",
      target: ["core"],
      setup(context) {
        context.engine.tags.declare({ name: "SetupRan", type: "BOOL", initialValue: true });
      },
      rpcMethods: [{ name: "plugin.echo", handler: (_context, params) => params }],
      instructions: [
        {
          opcode: "lifecycle",
          prescan(_args, context) {
            context.tags.set("Pre", context.tags.get<number>("Pre") + 1);
          },
          execute(_args, context) {
            return { power: context.power };
          },
          postscan(_args, context) {
            context.tags.set("Post", context.tags.get<number>("Post") + 1);
          },
          reset(_args, context) {
            context.memory.set("reset", true);
          },
        },
        {
          opcode: "advance-clock",
          execute(args, context) {
            context.clock.advance(Number((args as { ms: number }).ms));
            return { power: context.power };
          },
        },
      ],
    };
    await engine.plugins.register(plugin);
    await engine.loadProgram({
      name: "Lifecycle",
      configuration: {
        id: "c",
        name: "C",
        resources: [
          {
            id: "res",
            name: "R",
            tasks: [{ id: "t", name: "T", kind: "continuous", priority: 1, watchdogMs: 5 }],
            programs: [{ id: "pi", name: "P", program: "p", task: "t" }],
          },
        ],
      },
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
                    { id: "life", opcode: "lifecycle", args: {} },
                    { id: "slow", opcode: "advance-clock", args: { ms: 6 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    await engine.prescan();
    await engine.scan();

    expect(engine.tags.get("SetupRan")).toBe(true);
    expect(engine.tags.get("Pre")).toBe(1);
    expect(engine.tags.get("Post")).toBe(1);
    expect(engine.faults.list().some((fault) => fault.code === "WATCHDOG_TIMEOUT")).toBe(true);
    const response = await createRuntimeRpcRouter(engine).handle({
      id: 1,
      method: "plugin.echo",
      params: { ok: true },
    });
    expect(response.result).toEqual({ ok: true });
  });

  test("watchdog is not triggered when task execution is paused by debugger", async () => {
    const engine = createPlcEngine();
    await engine.loadProgram({
      name: "WatchdogDebug",
      configuration: {
        id: "c",
        name: "C",
        resources: [
          {
            id: "res",
            name: "R",
            tasks: [{ id: "t", name: "T", kind: "continuous", priority: 1, watchdogMs: 5 }],
            programs: [{ id: "pi", name: "P", program: "p", task: "t" }],
          },
        ],
      },
      tags: [{ name: "A", type: "BOOL", initialValue: true }],
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
                    { id: "i1", opcode: "xic", args: { tag: "A" } },
                    { id: "i2", opcode: "ote", args: { tag: "B" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    engine.debugger.addBreakpoint({ kind: "instruction", instructionId: "i1" });
    const run = await engine.run({ maxScans: 1 });

    await waitFor(() => engine.controller.mode === "paused");
    await Bun.sleep(20);
    engine.resume();

    await run.done;
    expect(engine.faults.list().some((fault) => fault.code === "WATCHDOG_TIMEOUT")).toBe(false);
  });

  test("event tasks are triggered explicitly and periodic tasks use the virtual clock", async () => {
    const engine = createPlcEngine();
    engine.tags.declare({ name: "Count", type: "DINT", initialValue: 0 });
    await engine.plugins.register({
      id: "count-plugin",
      instructions: [
        {
          opcode: "inc",
          execute: (_args, context) => {
            context.tags.set("Count", context.tags.get<number>("Count") + 1);
            return { power: context.power };
          },
        },
      ],
    });
    await engine.loadProgram({
      name: "Tasks",
      configuration: {
        id: "c",
        name: "C",
        resources: [
          {
            id: "r",
            name: "R",
            tasks: [
              { id: "periodic", name: "Periodic", kind: "periodic", priority: 2, periodMs: 10 },
              { id: "event", name: "Event", kind: "event", priority: 1 },
            ],
            programs: [
              { id: "periodic-program", name: "PeriodicProgram", program: "p", task: "periodic" },
              { id: "event-program", name: "EventProgram", program: "p", task: "event" },
            ],
          },
        ],
      },
      programs: [
        {
          id: "p",
          name: "P",
          routines: [
            {
              id: "r",
              name: "R",
              language: "ladder",
              rungs: [{ id: "r1", instructions: [{ id: "inc", opcode: "inc", args: {} }] }],
            },
          ],
        },
      ],
    });

    await engine.scan();
    await engine.scan();
    expect(engine.tags.get("Count")).toBe(1);
    engine.clock.advance(10);
    await engine.scan();
    expect(engine.tags.get("Count")).toBe(2);
    engine.triggerEventTask("event");
    await engine.scan();
    expect(engine.tags.get("Count")).toBe(3);
  });

  test("task triggering, scheduler inspection, and RPC tag subscriptions are public runtime features", async () => {
    const engine = createPlcEngine();
    engine.tags.declare({ name: "Count", type: "DINT", initialValue: 0 });
    await engine.plugins.register({
      id: "rpc-task-plugin",
      instructions: [
        {
          opcode: "inc.rpc",
          execute: (_args, context) => {
            context.tags.set("Count", context.tags.get<number>("Count") + 1);
            return { power: context.power };
          },
        },
      ],
    });
    await engine.loadProgram({
      name: "TaskRpc",
      configuration: {
        id: "c",
        name: "C",
        resources: [
          {
            id: "res",
            name: "R",
            tasks: [{ id: "evt", name: "EventTask", kind: "event", priority: 1 }],
            programs: [{ id: "pi", name: "PI", program: "p", task: "evt" }],
          },
        ],
      },
      programs: [
        {
          id: "p",
          name: "P",
          routines: [
            {
              id: "r",
              name: "R",
              language: "ladder",
              rungs: [{ id: "r1", instructions: [{ id: "inc", opcode: "inc.rpc", args: {} }] }],
            },
          ],
        },
      ],
    });

    const sent: RuntimeMessage[] = [];
    const transport = memoryTransport(sent);
    const detach = engine.attachTransport(transport);
    transport.emit({ id: 1, method: "tags.subscribe", params: { path: "Count" } });
    await waitFor(() => sent.some((message) => message.id === 1));
    expect(
      (sent.find((message) => message.id === 1)?.result as { subscriptionId: string })
        .subscriptionId,
    ).toBeString();
    transport.emit({ id: 2, method: "tasks.trigger", params: { task: "EventTask", count: 2 } });
    await waitFor(() => sent.some((message) => message.id === 2));
    expect(sent.find((message) => message.id === 2)?.result).toBe(true);
    expect(engine.inspect().scheduler[0]?.pendingEvents).toBe(2);

    await engine.scan();
    await engine.scan();

    expect(engine.tags.get("Count")).toBe(2);
    expect(engine.inspect().scheduler[0]?.pendingEvents).toBe(0);
    expect(sent.some((message) => message.method === "tags.change")).toBe(true);
    detach();
  });

  test("load-time IR validation reports structural, task, call, and unsupported-instruction diagnostics", async () => {
    const engine = createPlcEngine();
    await engine.loadProgram({
      name: "InvalidIr",
      configuration: {
        id: "c",
        name: "C",
        resources: [
          {
            id: "res",
            name: "R",
            tasks: [
              { id: "periodic", name: "Periodic", kind: "periodic", priority: 1, periodMs: -1 },
            ],
            programs: [{ id: "pi", name: "PI", program: "missing-program", task: "missing-task" }],
          },
        ],
      },
      tags: [
        { name: "Known", type: "BOOL", initialValue: false },
        { name: "Known", type: "BOOL", initialValue: true },
        { name: "BadAddress", type: "BOOL", locatedAt: { area: "Z" as "I", address: "" } },
      ],
      aois: [
        {
          id: "Aoi",
          name: "Aoi",
          parameters: [{ name: "Req", direction: "input", required: true }],
          routines: [],
        },
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
                    { id: "bad-op", opcode: "vendor.only", args: {} },
                    {
                      id: "bad-call",
                      opcode: "fb.call",
                      args: {
                        definition: "Aoi",
                        instance: "A1",
                        parameters: { Req: "MissingTag" },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(engine.diagnostics.list().map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining([
        "INVALID_TASK_PERIOD",
        "UNKNOWN_TASK",
        "UNKNOWN_PROGRAM",
        "UNSUPPORTED_INSTRUCTION",
        "UNKNOWN_PARAMETER_TAG",
        "DUPLICATE_TAG",
        "INVALID_DIRECT_ADDRESS",
      ]),
    );
  });

  test("load-time ladder validation warns about broken rung instruction order", async () => {
    const engine = createPlcEngine();
    await engine.loadProgram({
      name: "BrokenLadder",
      tags: [{ name: "Input", type: "BOOL", initialValue: false }],
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
                  id: "terminal-condition",
                  instructions: [{ id: "xic", opcode: "xic", args: { tag: "Input" } }],
                },
                { id: "empty-branch", instructions: [{ id: "b", opcode: "branch", args: {} }] },
              ],
            },
          ],
        },
      ],
    });

    const diagnostics = engine.diagnostics.list();
    expect(diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "CONDITION_TERMINAL", severity: "warning" }),
        expect.objectContaining({ code: "EMPTY_BRANCH", severity: "warning" }),
      ]),
    );
  });

  test("tag store rejects writes to undeclared tags", () => {
    const engine = createPlcEngine();
    engine.tags.declare({ name: "Known", type: "BOOL", initialValue: false });

    expect(() => engine.tags.set("RandomTag", true)).toThrow("Unknown tag: RandomTag");
    expect(engine.tags.has("RandomTag")).toBe(false);
  });

  test("elementary and structured PLC data type validation enforces ranges and required shapes", () => {
    const engine = createPlcEngine();
    engine.tags.declare({ name: "Small", type: "SINT", initialValue: 0 });
    engine.tags.declare({ name: "Unsigned", type: "UINT", initialValue: 0 });
    engine.tags.declare({ name: "Real", type: "REAL", initialValue: 1.5 });
    engine.tags.declare({ name: "Control", type: "CONTROL" });
    engine.tags.declare({ name: "Timer", type: "TIMER" });
    engine.tags.declare({
      name: "Struct",
      type: { kind: "struct", members: { Speed: { name: "Speed", type: "INT" } } },
    });

    expect(() => engine.tags.set("Small", 128)).toThrow("Range violation");
    expect(() => engine.tags.set("Unsigned", -1)).toThrow("Range violation");
    expect(() => engine.tags.set("Real", Number.POSITIVE_INFINITY)).toThrow("Type mismatch");
    expect(() => engine.tags.set("Control", { LEN: 1 })).toThrow("Type mismatch");
    expect(() => engine.tags.set("Timer", { PRE: 1, ACC: 0 })).toThrow("Type mismatch");
    expect(() => engine.tags.set("Struct", { Speed: 40000 })).toThrow("Range violation");
  });

  test("tag paths support IEC lower bounds and multidimensional array indexes", () => {
    const engine = createPlcEngine();
    engine.tags.declare({
      name: "Matrix",
      type: {
        kind: "array",
        elementType: "DINT",
        dimensions: [
          { lower: 1, upper: 2 },
          { lower: 5, upper: 6 },
        ],
      },
    });
    engine.tags.declare({
      name: "Nested",
      type: {
        kind: "struct",
        members: {
          Values: {
            name: "Values",
            type: { kind: "array", elementType: "INT", dimensions: [{ lower: -1, upper: 1 }] },
          },
        },
      },
    });

    engine.tags.set("Matrix[1,5]", 15);
    engine.tags.set("Matrix[2,6]", 26);
    engine.tags.set("Nested.Values[-1]", -1);
    engine.tags.set("Nested.Values[1]", 1);

    expect(engine.tags.get("Matrix[1,5]")).toBe(15);
    expect(engine.tags.get("Matrix[2,6]")).toBe(26);
    expect(engine.tags.get("Nested.Values[-1]")).toBe(-1);
    expect(engine.tags.get("Nested.Values[1]")).toBe(1);
    expect(() => engine.tags.get("Matrix[0,5]")).toThrow("Array index out of range");
  });

  test("task inhibit/enable controls are public and available over RPC", async () => {
    const engine = createPlcEngine();
    engine.tags.declare({ name: "Runs", type: "DINT", initialValue: 0 });
    await engine.plugins.register({
      id: "task-toggle-plugin",
      instructions: [
        {
          opcode: "inc.toggle",
          execute: (_args, context) => {
            context.tags.set("Runs", context.tags.get<number>("Runs") + 1);
            return { power: context.power };
          },
        },
      ],
    });
    await engine.loadProgram({
      name: "TaskToggle",
      configuration: {
        id: "c",
        name: "C",
        resources: [
          {
            id: "res",
            name: "R",
            tasks: [{ id: "task", name: "Task", kind: "continuous", priority: 1 }],
            programs: [{ id: "pi", name: "PI", program: "p", task: "task" }],
          },
        ],
      },
      programs: [
        {
          id: "p",
          name: "P",
          routines: [
            {
              id: "r",
              name: "R",
              language: "ladder",
              rungs: [{ id: "r1", instructions: [{ id: "inc", opcode: "inc.toggle", args: {} }] }],
            },
          ],
        },
      ],
    });
    const router = createRuntimeRpcRouter(engine);

    await engine.scan();
    expect(engine.tags.get("Runs")).toBe(1);
    expect(
      ((await router.handle({ id: 0, method: "instructions.list" })).result as unknown[]).some(
        (instruction) => (instruction as { id?: string }).id === "inc",
      ),
    ).toBe(true);
    expect((await router.handle({ id: 0.5, method: "debug.inspect" })).result).toMatchObject({
      scheduler: expect.any(Array),
    });
    expect(
      (await router.handle({ id: 1, method: "tasks.inhibit", params: { task: "Task" } })).result,
    ).toMatchObject({ inhibited: true });
    await engine.scan();
    expect(engine.tags.get("Runs")).toBe(1);
    expect(engine.inspect().scheduler[0]?.due).toBe(false);
    expect(
      (await router.handle({ id: 2, method: "tasks.enable", params: { taskId: "task" } })).result,
    ).toMatchObject({ inhibited: false });
    await engine.scan();
    expect(engine.tags.get("Runs")).toBe(2);
  });

  test("plugin device definitions attach devices and debug sinks receive runtime events", async () => {
    const engine = createPlcEngine();
    const events: DebugEvent[] = [];
    await engine.plugins.register({
      id: "device-and-debug-plugin",
      devices: [
        {
          id: "input-device",
          create: () => ({
            id: "input-device-instance",
            updateInputs(io) {
              io.inputs.set("%I0.1", true);
            },
          }),
        },
      ],
      debugSinks: [{ id: "sink", emit: (event) => events.push(event) }],
    });
    engine.controller.setMode("run");
    await engine.loadProgram({
      name: "PluginDevices",
      tags: [
        {
          name: "Input",
          type: "BOOL",
          initialValue: false,
          locatedAt: { area: "I", address: "0.1" },
        },
        { name: "Output", type: "BOOL", initialValue: false },
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
                    { id: "in", opcode: "xic", args: { tag: "Input" } },
                    { id: "out", opcode: "ote", args: { tag: "Output" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    await engine.scan();

    expect(engine.io.devices.get("input-device-instance")).toBeDefined();
    expect(engine.tags.get("Input")).toBe(true);
    expect(engine.tags.get("Output")).toBe(true);
    expect(events.some((event) => event.name === "scan:start")).toBe(true);
    expect(events.some((event) => event.name === "instruction:after")).toBe(true);
  });

  test("I/O image forces override writes and survive runtime snapshots", async () => {
    const engine = createPlcEngine();
    engine.controller.setMode("run");
    await engine.loadProgram({
      name: "IoForces",
      tags: [
        {
          name: "Input",
          type: "BOOL",
          initialValue: false,
          locatedAt: { area: "I", address: "1.0" },
        },
        {
          name: "Output",
          type: "BOOL",
          initialValue: false,
          locatedAt: { area: "Q", address: "1.0" },
        },
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
                    { id: "in", opcode: "xic", args: { tag: "Input" } },
                    { id: "out", opcode: "ote", args: { tag: "Output" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    engine.io.inputs.force("%I1.0", true, "test input");
    engine.io.outputs.force("%Q1.0", false, "test output");

    await engine.scan();

    expect(engine.tags.get("Input")).toBe(true);
    expect(engine.tags.get("Output")).toBe(true);
    expect(engine.io.outputs.get("%Q1.0")).toBe(false);
    const snapshot = engine.snapshot();
    engine.io.inputs.unforce("%I1.0");
    engine.io.outputs.unforce("%Q1.0");
    engine.io.inputs.set("%I1.0", false);
    engine.io.outputs.set("%Q1.0", true);
    engine.restore(snapshot);

    expect(engine.io.inputs.get("%I1.0")).toBe(true);
    expect(engine.io.outputs.get("%Q1.0")).toBe(false);
    expect(engine.io.outputs.listForces()).toHaveLength(1);
  });

  test("RPC exposes I/O force, snapshot, and restore operations", async () => {
    const engine = createPlcEngine();
    const router = createRuntimeRpcRouter(engine);

    expect(
      (
        await router.handle({
          id: 1,
          method: "io.inputs.force",
          params: { address: "%I2.0", value: true, reason: "rpc" },
        })
      ).result,
    ).toBe(true);
    expect(
      (await router.handle({ id: 2, method: "io.inputs.read", params: { address: "%I2.0" } }))
        .result,
    ).toBe(true);
    const forces = await router.handle({ id: 3, method: "io.forces.list" });
    expect((forces.result as { inputs: unknown[] }).inputs).toHaveLength(1);
    const snapshot = await router.handle({ id: 4, method: "io.snapshot" });
    await router.handle({ id: 5, method: "io.inputs.unforce", params: { address: "%I2.0" } });
    await router.handle({
      id: 6,
      method: "io.inputs.write",
      params: { address: "%I2.0", value: false },
    });
    expect(
      (await router.handle({ id: 7, method: "io.inputs.read", params: { address: "%I2.0" } }))
        .result,
    ).toBe(false);
    expect(
      (await router.handle({ id: 8, method: "io.restore", params: { snapshot: snapshot.result } }))
        .result,
    ).toBe(true);
    expect(
      (await router.handle({ id: 9, method: "io.inputs.read", params: { address: "%I2.0" } }))
        .result,
    ).toBe(true);
  });

  test("FB/AOI calls enforce runtime bindings, expose call context, and inspect instance memory", async () => {
    const engine = createPlcEngine();
    await engine.plugins.register({
      id: "fb-context-plugin",
      instructions: [
        {
          opcode: "capture.call",
          execute(_args, context) {
            context.tags.set("Seen", context.call?.instance === "M1");
            return { power: context.power };
          },
        },
      ],
    });
    await engine.loadProgram({
      id: "source",
      name: "FbInspect",
      tags: [
        { name: "Seen", type: "BOOL", initialValue: false },
        { name: "Out", type: "BOOL", initialValue: false },
      ],
      pous: [
        {
          id: "MemoryBlock",
          name: "MemoryBlock",
          kind: "function-block",
          interface: { outputs: [{ name: "Seen", type: "BOOL" }] },
          variables: [{ name: "Count", type: "DINT", initialValue: 0 }],
          body: {
            language: "ld",
            networks: [
              {
                id: "n",
                rungs: [
                  {
                    id: "r",
                    instructions: [
                      { id: "count", opcode: "add", args: { a: "Count", b: 1, dest: "Count" } },
                      { id: "capture", opcode: "capture.call", args: {} },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
      aois: [
        {
          id: "RequiredAoi",
          name: "RequiredAoi",
          parameters: [{ name: "Req", direction: "input", required: true }],
          routines: [],
        },
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
                    {
                      id: "fb",
                      opcode: "fb.call",
                      args: {
                        definition: "MemoryBlock",
                        instance: "M1",
                        parameters: { Seen: "Seen" },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    await engine.scan();
    await engine.scan();
    expect(engine.tags.get("Seen")).toBe(true);
    const instance = engine
      .inspect()
      .functionBlockInstances.find((entry) => entry.instance === "M1");
    expect(instance).toMatchObject({
      definitionId: "MemoryBlock",
      definitionName: "MemoryBlock",
      kind: "function-block",
    });
    expect(((instance?.memory.global as Record<string, unknown>) ?? {}).Count).toBe(2);

    await engine.replaceProgram("source", {
      id: "source",
      name: "BadAoiCall",
      tags: [{ name: "Seen", type: "BOOL", initialValue: false }],
      aois: [
        {
          id: "RequiredAoi",
          name: "RequiredAoi",
          parameters: [{ name: "Req", direction: "input", required: true }],
          routines: [],
        },
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
                    {
                      id: "bad",
                      opcode: "fb.call",
                      args: { definition: "RequiredAoi", instance: "A1", parameters: {} },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    engine.controller.clearFaults();
    engine.controller.setMode("test");
    await engine.scan();
    expect(
      engine.faults
        .list()
        .some((fault) => fault.message.includes("missing required parameter Req")),
    ).toBe(true);
  });

  test("debugger can step over a function block call boundary", async () => {
    const engine = createPlcEngine();
    await engine.loadProgram({
      name: "StepOverFb",
      tags: [
        { name: "In", type: "BOOL", initialValue: true },
        { name: "Out", type: "BOOL", initialValue: false },
      ],
      pous: [
        {
          id: "Block",
          name: "Block",
          kind: "function-block",
          interface: {
            inputs: [{ name: "In", type: "BOOL" }],
            outputs: [{ name: "Out", type: "BOOL" }],
          },
          body: {
            language: "ld",
            networks: [
              {
                id: "n",
                rungs: [
                  {
                    id: "r",
                    instructions: [
                      { id: "inner-xic", opcode: "xic", args: { tag: "In" } },
                      { id: "inner-ote", opcode: "ote", args: { tag: "Out" } },
                    ],
                  },
                ],
              },
            ],
          },
        },
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
                    {
                      id: "call",
                      opcode: "fb.call",
                      args: {
                        definition: "Block",
                        instance: "B1",
                        parameters: { In: "In", Out: "Out" },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    engine.debugger.addBreakpoint({ kind: "instruction", instructionId: "call" });
    const scan = engine.scan();
    await waitFor(
      () => engine.controller.mode === "paused" && engine.inspect().stack.at(-1)?.id === "call",
    );
    await engine.debugger.step("over-fb");
    await waitFor(
      () => engine.controller.mode === "paused" && engine.inspect().stack.at(-1)?.kind === "fb",
    );
    expect(engine.inspect().stack.at(-1)).toMatchObject({ kind: "fb", id: "B1" });
    await engine.debugger.continue();
    await scan;
    expect(engine.tags.get("Out")).toBe(true);
  });

  test("JSR and RET are implemented as instruction behavior through execution controls", async () => {
    const engine = createPlcEngine();
    await engine.loadProgram({
      name: "Subroutines",
      tags: [
        { name: "A", type: "BOOL", initialValue: false },
        { name: "B", type: "BOOL", initialValue: false },
        { name: "C", type: "BOOL", initialValue: false },
      ],
      programs: [
        {
          id: "p",
          name: "P",
          routines: [
            {
              id: "main",
              name: "Main",
              language: "ladder",
              rungs: [
                {
                  id: "main-rung",
                  instructions: [
                    { id: "main-jsr", opcode: "jsr", args: { routine: "Sub" } },
                    { id: "main-ote", opcode: "ote", args: { tag: "C" } },
                  ],
                },
              ],
            },
            {
              id: "sub",
              name: "Sub",
              language: "ladder",
              rungs: [
                {
                  id: "sub-rung",
                  instructions: [
                    { id: "sub-otl", opcode: "otl", args: { tag: "A" } },
                    { id: "sub-ret", opcode: "ret", args: {} },
                    { id: "sub-skipped", opcode: "otl", args: { tag: "B" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    await engine.scan();

    expect(engine.tags.get("A")).toBe(true);
    expect(engine.tags.get("B")).toBe(false);
    expect(engine.tags.get("C")).toBe(true);
  });

  test("custom instructions can use execution controls to jump to subroutines", async () => {
    const engine = createPlcEngine();
    await engine.plugins.register({
      id: "control-plugin",
      instructions: [
        {
          opcode: "call.sub",
          async execute(args, context) {
            if (context.power)
              await context.control.jumpToSubroutine(String((args as { routine: string }).routine));
            return { power: context.power };
          },
        },
      ],
    });
    await engine.loadProgram({
      name: "CustomControl",
      tags: [{ name: "Called", type: "BOOL", initialValue: false }],
      programs: [
        {
          id: "p",
          name: "P",
          routines: [
            {
              id: "main",
              name: "Main",
              language: "ladder",
              rungs: [
                {
                  id: "r1",
                  instructions: [{ id: "call", opcode: "call.sub", args: { routine: "Sub" } }],
                },
              ],
            },
            {
              id: "sub",
              name: "Sub",
              language: "ladder",
              rungs: [
                { id: "r2", instructions: [{ id: "set", opcode: "otl", args: { tag: "Called" } }] },
              ],
            },
          ],
        },
      ],
    });

    await engine.scan();

    expect(engine.tags.get("Called")).toBe(true);
  });

  test("IEC program POUs execute directly and function calls remain stateless", async () => {
    const engine = createPlcEngine();
    await engine.loadProgram({
      name: "PouProgram",
      tags: [
        { name: "In", type: "BOOL", initialValue: true },
        { name: "Out", type: "BOOL", initialValue: false },
      ],
      pous: [
        {
          id: "ProgramPou",
          name: "ProgramPou",
          kind: "program",
          interface: {},
          body: {
            language: "ld",
            networks: [
              {
                id: "n",
                rungs: [
                  {
                    id: "r",
                    instructions: [
                      {
                        id: "call-f",
                        opcode: "function.call",
                        args: {
                          definition: "Fn",
                          instance: "Fn1",
                          parameters: { In: "In", Out: "Out" },
                        },
                      },
                    ],
                  },
                ],
              },
            ],
          },
        },
        {
          id: "Fn",
          name: "Fn",
          kind: "function",
          interface: {
            inputs: [{ name: "In", type: "BOOL" }],
            outputs: [{ name: "Out", type: "BOOL" }],
          },
          body: {
            language: "ld",
            networks: [
              {
                id: "fn-n",
                rungs: [
                  {
                    id: "fn-r",
                    instructions: [
                      { id: "fn-xic", opcode: "xic", args: { tag: "In" } },
                      { id: "fn-ote", opcode: "ote", args: { tag: "Out" } },
                    ],
                  },
                ],
              },
            ],
          },
        },
      ],
    });

    await engine.scan();
    expect(engine.tags.get("Out")).toBe(true);
    expect(engine.snapshot().fbMemory.Fn1).toBeUndefined();
  });

  test("retained-only tag snapshots exclude non-retained variables", () => {
    const engine = createPlcEngine();
    engine.tags.declare({ name: "Retained", type: "DINT", initialValue: 1, retain: true });
    engine.tags.declare({ name: "Scratch", type: "DINT", initialValue: 2, nonRetain: true });

    const snapshot = engine.tags.snapshot({ includeRetainedOnly: true });

    expect((snapshot.values.global as Record<string, unknown>).Retained).toBe(1);
    expect((snapshot.values.global as Record<string, unknown>).Scratch).toBeUndefined();
    expect(snapshot.declarations.map((declaration) => declaration.name)).toEqual(["Retained"]);
  });

  test("engine reset clears runtime state while optionally preserving retained tags", async () => {
    const engine = createPlcEngine();
    await engine.loadProgram({
      name: "Reset",
      tags: [
        { name: "Retained", type: "DINT", initialValue: 1, retain: true },
        { name: "Scratch", type: "DINT", initialValue: 2 },
        {
          name: "Input",
          type: "BOOL",
          initialValue: false,
          locatedAt: { area: "I", address: "3.0" },
        },
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
                    { id: "add", opcode: "add", args: { a: "Scratch", b: 1, dest: "Scratch" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    engine.tags.set("Retained", 99);
    engine.tags.set("Scratch", 42);
    engine.io.inputs.force("%I3.0", true);
    await engine.scan();
    expect(engine.controller.scanNumber).toBe(1);

    await engine.reset({ retain: true, resetClock: true, mode: "test" });

    expect(engine.tags.get("Retained")).toBe(99);
    expect(engine.tags.get("Scratch")).toBe(2);
    expect(engine.io.inputs.listForces()).toHaveLength(0);
    expect(engine.controller.scanNumber).toBe(0);
    expect(engine.controller.mode).toBe("test");

    const router = createRuntimeRpcRouter(engine);
    engine.tags.set("Retained", 123);
    expect(
      (
        await router.handle({
          id: 1,
          method: "engine.reset",
          params: { retain: false, mode: "program" },
        })
      ).error,
    ).toBeUndefined();
    expect(engine.tags.get("Retained")).toBe(1);
    expect(engine.controller.mode).toBe("program");
  });

  test("built-in instruction validators report bad argument shapes at load time", async () => {
    const engine = createPlcEngine();
    await engine.loadProgram({
      name: "BadBuiltins",
      tags: [{ name: "A", type: "DINT", initialValue: 1 }],
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
                    { id: "bad-xic", opcode: "xic", args: { tag: "Missing" } },
                    { id: "bad-add", opcode: "add", args: { a: "A", b: 1 } },
                    { id: "bad-jsr", opcode: "jsr", args: {} },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(engine.diagnostics.list().map((diagnostic) => diagnostic.code)).toEqual(
      expect.arrayContaining(["UNKNOWN_TAG", "INVALID_ARGUMENTS"]),
    );
  });

  test("JS authoring supports imperative routine.scan escape hatches", async () => {
    const { loadJsProgram, defineProgram } = await import("@plc-emulation/core");
    const source = await loadJsProgram({
      module: {
        default: defineProgram(({ task, program, routine }) => {
          task("MainTask", () => {
            program("MainProgram", () => {
              routine.scan("CustomLogic", ({ tags, memory }) => {
                const previous = memory.get<boolean>("previous") ?? false;
                const current = tags.get<boolean>("Start");
                if (!previous && current) tags.set("Pulse", true);
                else tags.set("Pulse", false);
                memory.set("previous", current);
              });
            });
          });
        }),
      },
    });
    source.tags = [
      { name: "Start", type: "BOOL", initialValue: false },
      { name: "Pulse", type: "BOOL", initialValue: false },
    ];
    const engine = createPlcEngine();
    await engine.loadProgram(source);

    await engine.scan();
    engine.tags.set("Start", true);
    await engine.scan();
    expect(engine.tags.get("Pulse")).toBe(true);
    await engine.scan();
    expect(engine.tags.get("Pulse")).toBe(false);
  });

  test("external language plugins execute non-LD POU bodies without core compilers", async () => {
    const engine = createPlcEngine();
    await engine.plugins.register({
      id: "st-language",
      languages: [
        {
          language: "st",
          execute(body, context) {
            const typed = body as { output: string; value: unknown };
            context.tags.set(typed.output, typed.value);
          },
        },
      ],
    });
    await engine.loadProgram({
      name: "LanguagePlugin",
      tags: [{ name: "Out", type: "BOOL", initialValue: false }],
      pous: [
        {
          id: "StPou",
          name: "StPou",
          kind: "program",
          interface: {},
          body: { language: "st", statements: { output: "Out", value: true } },
        },
      ],
    });

    await engine.scan();
    expect(engine.tags.get("Out")).toBe(true);
  });

  test("scan metrics track duration, min, max, average, and recent history", async () => {
    const engine = createPlcEngine();
    await engine.loadProgram({
      name: "Metrics",
      tags: [
        { name: "A", type: "BOOL", initialValue: true },
        { name: "B", type: "BOOL", initialValue: false },
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
                    { id: "i1", opcode: "xic", args: { tag: "A" } },
                    { id: "i2", opcode: "ote", args: { tag: "B" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    expect(engine.scanMetrics().totalScans).toBe(0);
    expect(engine.scanMetrics().lastScan).toBeNull();

    engine.clock.useRealTime();
    await engine.scan();
    await engine.scan();
    await engine.scan();

    const metrics = engine.scanMetrics();
    expect(metrics.totalScans).toBe(3);
    expect(metrics.averageDurationNs).toBeGreaterThan(0);
    expect(metrics.minDurationNs).toBeGreaterThan(0);
    expect(metrics.maxDurationNs).toBeGreaterThanOrEqual(metrics.minDurationNs);
    expect(metrics.lastScan?.scanNumber).toBe(3);
    expect(metrics.lastScan?.durationNs).toBeGreaterThan(0);
    expect(metrics.lastScan?.tasks.length).toBe(1);
    expect(metrics.recent.length).toBe(3);
    expect(metrics.recent[0]?.scanNumber).toBe(1);
    expect(metrics.recent[2]?.scanNumber).toBe(3);
    expect(metrics.recent.every((r) => r.durationNs > 0)).toBe(true);

    const router = createRuntimeRpcRouter(engine);
    const rpcMetrics = await router.handle({ id: 1, method: "metrics.scan" });
    expect(rpcMetrics.error).toBeUndefined();
    expect((rpcMetrics.result as typeof metrics).totalScans).toBe(3);

    const reset = await router.handle({ id: 2, method: "metrics.scan.reset" });
    expect(reset.error).toBeUndefined();
    expect(reset.result).toBe(true);
    expect(engine.scanMetrics().totalScans).toBe(0);

    await engine.reset({ mode: "run" });
    engine.clock.useRealTime();
    await engine.scan();
    expect(engine.scanMetrics().totalScans).toBe(1);
  });
});

function memoryTransport(
  sent: RuntimeMessage[],
): RuntimeTransport & { emit(message: RuntimeMessage): void } {
  const listeners = new Set<RuntimeMessageListener>();
  return {
    id: "memory",
    send(message) {
      sent.push(message);
    },
    onMessage(listener): Unsubscribe {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(message) {
      for (const listener of listeners) void listener(message);
    },
  };
}

async function waitFor(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 100; index += 1) {
    if (condition()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for condition");
}
