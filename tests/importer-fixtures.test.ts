import { describe, expect, test } from "bun:test";
import { createPlcEngine, type ProgramSource } from "@plc-emulation/core";

describe("future importer shaped IR fixtures", () => {
  test("executes Rockwell/L5X-like IR without L5X parsing in core", async () => {
    const l5xLike: ProgramSource = {
      id: "l5x-fixture",
      name: "L5X Fixture",
      metadata: { importer: "@plc-emulation/l5x", vendor: "rockwell" },
      tags: [
        {
          name: "Local:1:I.Data.0",
          type: "BOOL",
          initialValue: true,
          metadata: { l5xAddress: "Local:1:I.Data.0" },
        },
        { name: "MotorRun", type: "BOOL", initialValue: false },
      ],
      aois: [
        {
          id: "MotorSealIn",
          name: "MotorSealIn",
          parameters: [
            { name: "Start", direction: "input", type: "BOOL" },
            { name: "Running", direction: "output", type: "BOOL" },
          ],
          routines: [
            {
              id: "aoi-main",
              name: "Logic",
              language: "ladder",
              rungs: [
                {
                  id: "aoi-rung",
                  instructions: [
                    { id: "aoi-xic", opcode: "xic", args: { tag: "Start" } },
                    { id: "aoi-ote", opcode: "ote", args: { tag: "Running" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
      programs: [
        {
          id: "MainProgram",
          name: "MainProgram",
          routines: [
            {
              id: "MainRoutine",
              name: "MainRoutine",
              language: "ladder",
              rungs: [
                {
                  id: "Rung0",
                  number: 0,
                  instructions: [
                    {
                      id: "aoi-call",
                      opcode: "fb.call",
                      args: {
                        definition: "MotorSealIn",
                        instance: "MotorSealIn_1",
                        parameters: { Start: "Local:1:I.Data.0", Running: "MotorRun" },
                      },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const engine = createPlcEngine();
    await engine.loadProgram(l5xLike);
    await engine.scan();

    expect(engine.tags.get("MotorRun")).toBe(true);
    expect(engine.snapshot().programs[0]?.source.metadata?.importer).toBe("@plc-emulation/l5x");
  });

  test("executes PLCopen XML-like IEC IR without XML parsing in core", async () => {
    const plcopenLike: ProgramSource = {
      id: "plcopen-fixture",
      name: "PLCopen Fixture",
      metadata: { importer: "@plc-emulation/plcopen-xml", standard: "IEC 61131-10" },
      configuration: {
        id: "Configuration",
        name: "Configuration",
        resources: [
          {
            id: "Resource",
            name: "Resource",
            tasks: [{ id: "Task", name: "Task", kind: "continuous", priority: 1 }],
            programs: [
              {
                id: "ProgramInstance",
                name: "ProgramInstance",
                program: "ProgramPou",
                task: "Task",
              },
            ],
          },
        ],
      },
      tags: [
        { name: "Start", type: "BOOL", initialValue: true },
        { name: "Run", type: "BOOL", initialValue: false },
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
                id: "Network1",
                name: "Network 1",
                instructions: [
                  { id: "contact", opcode: "xic", args: { tag: "Start" } },
                  { id: "coil", opcode: "ote", args: { tag: "Run" } },
                ],
              },
            ],
          },
        },
      ],
    };
    const engine = createPlcEngine();
    await engine.loadProgram(plcopenLike);
    await engine.scan();

    expect(engine.tags.get("Run")).toBe(true);
    expect(engine.snapshot().programs[0]?.source.metadata?.importer).toBe(
      "@plc-emulation/plcopen-xml",
    );
  });
});
