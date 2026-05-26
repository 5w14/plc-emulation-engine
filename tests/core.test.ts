import { describe, expect, test } from "bun:test";
import {
  createPlcEngine,
  createRuntimeRpcRouter,
  defineProgram,
  loadJsProgram,
  type PlcPlugin,
  type ProgramSource,
} from "@plc-emulation/core";

function motorProgram(): ProgramSource {
  return {
    name: "Motor",
    tags: [
      { name: "StartPB", type: "BOOL", initialValue: false },
      { name: "MotorRunning", type: "BOOL", initialValue: false },
    ],
    programs: [
      {
        id: "main",
        name: "MainProgram",
        routines: [
          {
            id: "main-routine",
            name: "MainRoutine",
            language: "ladder",
            rungs: [
              {
                id: "rung-1",
                instructions: [
                  { id: "xic-1", opcode: "xic", args: { tag: "StartPB" } },
                  { id: "ote-1", opcode: "ote", args: { tag: "MotorRunning" } },
                ],
              },
            ],
          },
        ],
      },
    ],
  };
}

describe("@plc-emulation/core", () => {
  test("loads direct IR and executes ordered ladder scans", async () => {
    const engine = createPlcEngine();
    await engine.loadProgram(motorProgram());

    await engine.scan();
    expect(engine.tags.get("MotorRunning")).toBe(false);

    engine.tags.set("StartPB", true);
    const result = await engine.scan();

    expect(result.scanNumber).toBe(2);
    expect(engine.tags.get("MotorRunning")).toBe(true);
  });

  test("supports JS authoring without filesystem loading", async () => {
    const source = await loadJsProgram({
      module: {
        default: defineProgram(({ task, program, routine, rung, xic, ons, ote }) => {
          task("MainTask", () => {
            program("MainProgram", () => {
              routine("MainRoutine", () => {
                rung("Pulse", () => {
                  xic("StartPB");
                  ons("StartPB");
                  ote("Pulse");
                });
              });
            });
          });
        }),
      },
    });
    source.tags = [
      { name: "StartPB", type: "BOOL", initialValue: false },
      { name: "Pulse", type: "BOOL", initialValue: false },
    ];

    const engine = createPlcEngine();
    await engine.loadProgram(source);
    await engine.scan();
    engine.tags.set("StartPB", true);
    await engine.scan();
    expect(engine.tags.get("Pulse")).toBe(true);
    await engine.scan();
    expect(engine.tags.get("Pulse")).toBe(false);
  });

  test("runs timers, counters, branches, and math with virtual time", async () => {
    const engine = createPlcEngine();
    await engine.loadProgram({
      name: "Instructions",
      tags: [
        { name: "Start", type: "BOOL", initialValue: true },
        { name: "Other", type: "BOOL", initialValue: false },
        { name: "Out", type: "BOOL", initialValue: false },
        { name: "T1", type: "TIMER" },
        { name: "C1", type: "COUNTER" },
        { name: "A", type: "DINT", initialValue: 2 },
        { name: "B", type: "DINT", initialValue: 3 },
        { name: "Sum", type: "DINT", initialValue: 0 },
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
                      id: "branch",
                      opcode: "branch",
                      args: {},
                      children: [
                        {
                          id: "path-a",
                          opcode: "series",
                          args: {},
                          children: [{ id: "xic-start", opcode: "xic", args: { tag: "Start" } }],
                        },
                        {
                          id: "path-b",
                          opcode: "series",
                          args: {},
                          children: [{ id: "xic-other", opcode: "xic", args: { tag: "Other" } }],
                        },
                      ],
                    },
                    { id: "ote-out", opcode: "ote", args: { tag: "Out" } },
                    { id: "ton", opcode: "ton", args: { timer: "T1", pre: 100 } },
                    { id: "ctu", opcode: "ctu", args: { counter: "C1", pre: 2 } },
                    { id: "add", opcode: "add", args: { a: "A", b: "B", dest: "Sum" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });

    await engine.scan();
    engine.clock.advance(50);
    await engine.scan();
    engine.clock.advance(60);
    await engine.scan();

    expect(engine.tags.get("Out")).toBe(true);
    expect(engine.tags.get<Record<string, unknown>>("T1").DN).toBe(true);
    expect(engine.tags.get<Record<string, unknown>>("C1").ACC).toBe(1);
    expect(engine.tags.get("Sum")).toBe(5);
  });

  test("maps direct I/O addresses, aliases, forces, and snapshots", async () => {
    const engine = createPlcEngine();
    engine.controller.setMode("run");
    await engine.loadProgram({
      name: "Io",
      tags: [
        {
          name: "InputTag",
          type: "BOOL",
          initialValue: false,
          locatedAt: { area: "I", address: "0.0" },
        },
        {
          name: "OutputTag",
          type: "BOOL",
          initialValue: false,
          locatedAt: { area: "Q", address: "0.0" },
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
                    { id: "copy", opcode: "xic", args: { tag: "InputTag" } },
                    { id: "out", opcode: "ote", args: { tag: "OutputTag" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    engine.tags.declareAlias({ name: "StartAlias", target: "InputTag" });
    engine.io.inputs.set("%I0.0", true);
    await engine.scan();

    expect(engine.tags.get("StartAlias")).toBe(true);
    expect(engine.io.outputs.get("%Q0.0")).toBe(true);

    engine.tags.force("OutputTag", false);
    const snapshot = engine.snapshot();
    engine.tags.set("OutputTag", true);
    expect(engine.tags.get("OutputTag")).toBe(false);
    engine.restore(snapshot);
    expect(engine.tags.listForces()).toHaveLength(1);
  });

  test("declares IEC variable classes, scopes, UDTs, arrays, structs, enums, and subranges", () => {
    const engine = createPlcEngine();
    engine.tags.declareUdt({
      name: "MotorUdt",
      members: { Enabled: { name: "Enabled", type: "BOOL" } },
    });
    engine.tags.declare({
      name: "ProgramTag",
      class: "local",
      scope: { kind: "program", programId: "P1" },
      type: {
        kind: "struct",
        members: {
          ArrayMember: {
            name: "ArrayMember",
            type: { kind: "array", elementType: "DINT", dimensions: [{ lower: 0, upper: 2 }] },
          },
          Mode: {
            name: "Mode",
            type: { kind: "enum", values: ["Off", "Auto"] },
            initialValue: "Auto",
          },
          Speed: {
            name: "Speed",
            type: { kind: "subrange", baseType: "INT", min: 0, max: 100 },
            initialValue: 50,
          },
          Motor: {
            name: "Motor",
            type: { kind: "udt", name: "MotorUdt" },
            initialValue: { Enabled: true },
          },
        },
      },
    });

    const scope = { kind: "program" as const, programId: "P1" };
    engine.tags.set("ProgramTag.ArrayMember[1]", 42, { scope });

    expect(engine.tags.get("ProgramTag.ArrayMember[1]", { scope })).toBe(42);
    expect(engine.tags.get("ProgramTag.Mode", { scope })).toBe("Auto");
    expect(engine.tags.get("ProgramTag.Motor.Enabled", { scope })).toBe(true);
  });

  test("resolves symbolic array indices before UDT member access", () => {
    const engine = createPlcEngine();
    engine.tags.declareUdt({
      name: "Package",
      members: {
        Front: { name: "Front", type: "INT" },
        Back: { name: "Back", type: "INT" },
      },
    });
    engine.tags.declare({
      name: "Packages",
      type: {
        kind: "array",
        elementType: { kind: "udt", name: "Package" },
        dimensions: [{ lower: 0, upper: 49 }],
      },
    });
    engine.tags.declare({ name: "R51_Index", type: "DINT", initialValue: 4 });

    engine.tags.set("Packages[R51_Index].Front", 211);
    engine.tags.set("Packages[R51_Index-1].Back", 109);

    expect(engine.tags.get("Packages[4].Front")).toBe(211);
    expect(engine.tags.get("Packages[R51_Index].Front")).toBe(211);
    expect(engine.tags.get("Packages[3].Back")).toBe(109);
  });

  test("executes function blocks and AOI-shaped definitions through fb.call", async () => {
    const engine = createPlcEngine();
    await engine.loadProgram({
      name: "FB",
      tags: [
        { name: "StartPB", type: "BOOL", initialValue: true },
        { name: "Running", type: "BOOL", initialValue: false },
      ],
      pous: [
        {
          id: "MotorStarter",
          name: "MotorStarter",
          kind: "function-block",
          interface: {
            inputs: [{ name: "Start", type: "BOOL", class: "input" }],
            outputs: [{ name: "Running", type: "BOOL", class: "output" }],
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
                      { id: "fb-xic", opcode: "xic", args: { tag: "Start" } },
                      { id: "fb-ote", opcode: "ote", args: { tag: "Running" } },
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
          id: "main",
          name: "Main",
          routines: [
            {
              id: "main-r",
              name: "Main",
              language: "ladder",
              rungs: [
                {
                  id: "call-rung",
                  instructions: [
                    {
                      id: "call",
                      opcode: "fb.call",
                      args: {
                        definition: "MotorStarter",
                        instance: "M1",
                        parameters: { Start: "StartPB", Running: "Running" },
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
    expect(engine.tags.get("Running")).toBe(true);
    expect(engine.snapshot().fbMemory.M1).toBeDefined();
  });

  test("raises diagnostics/faults for unsupported instructions and exposes debugger/RPC", async () => {
    const engine = createPlcEngine();
    await engine.loadProgram({
      name: "Unsupported",
      programs: [
        {
          id: "p",
          name: "P",
          routines: [
            {
              id: "r",
              name: "R",
              language: "ladder",
              rungs: [{ id: "r1", instructions: [{ id: "bad", opcode: "vendor.only", args: {} }] }],
            },
          ],
        },
      ],
    });
    const hits: string[] = [];
    engine.debugger.on("breakpoint:hit", () => hits.push("hit"));
    engine.debugger.addBreakpoint({ kind: "instruction", instructionId: "bad" });
    const scan = engine.scan();
    await waitFor(() => hits.length === 1);
    expect(engine.controller.mode).toBe("paused");
    await engine.debugger.continue();
    await scan;

    expect(hits).toEqual(["hit"]);
    expect(engine.controller.mode).toBe("faulted");
    expect(engine.diagnostics.list()[0]?.code).toBe("UNSUPPORTED_INSTRUCTION");

    const router = createRuntimeRpcRouter(engine);
    const response = await router.handle({ id: 1, method: "faults.list" });
    expect(Array.isArray(response.result)).toBe(true);
  });

  test("enforces plugin compatibility and duplicate opcode rules", async () => {
    const engine = createPlcEngine({ target: "browser" });
    const plugin: PlcPlugin = {
      id: "node-only",
      target: ["node"],
      instructions: [{ opcode: "noop", execute: (_args, context) => ({ power: context.power }) }],
    };
    await expect(engine.plugins.register(plugin)).rejects.toThrow("incompatible");
    await expect(
      engine.plugins.register({
        id: "dup",
        instructions: [{ opcode: "xic", execute: (_args, context) => ({ power: context.power }) }],
      }),
    ).rejects.toThrow("Duplicate instruction");
  });
});

async function waitFor(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 50; index += 1) {
    if (condition()) return;
    await Bun.sleep(1);
  }
  throw new Error("Timed out waiting for condition");
}
