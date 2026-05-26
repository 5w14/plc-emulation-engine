import { describe, expect, test } from "bun:test";
import {
  createPlcEngine,
  type InstructionNode,
  type PlcRung,
  type ProgramSource,
  type VariableDeclaration,
} from "@plc-emulation/core";

interface GeneratedProgramOptions {
  seed: number;
  programs: number;
  routinesPerProgram: number;
  rungsPerRoutine: number;
  contactsPerRung: number;
}

interface ScanBenchmarkResult {
  scans: number;
  elapsedMs: number;
  scansPerSecond: number;
  instructionsPerScan: number;
  instructionsPerSecond: number;
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}

function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function boolTag(index: number): string {
  return `B${index}`;
}

function dintTag(index: number): string {
  return `N${index}`;
}

function generatedProgram(options: GeneratedProgramOptions): {
  source: ProgramSource;
  instructionCount: number;
} {
  const random = rng(options.seed);
  const boolTagCount = 128;
  const dintTagCount = 64;
  const tags: VariableDeclaration[] = [
    ...Array.from({ length: boolTagCount }, (_, index) => ({
      name: boolTag(index),
      type: "BOOL" as const,
      initialValue: index % 3 === 0,
    })),
    ...Array.from({ length: dintTagCount }, (_, index) => ({
      name: dintTag(index),
      type: "DINT" as const,
      initialValue: index + 1,
    })),
  ];

  let instructionCount = 0;
  const programs = Array.from({ length: options.programs }, (_, programIndex) => ({
    id: `program-${programIndex}`,
    name: `Program${programIndex}`,
    routines: Array.from({ length: options.routinesPerProgram }, (_, routineIndex) => ({
      id: `program-${programIndex}-routine-${routineIndex}`,
      name: `Routine${routineIndex}`,
      language: "ladder" as const,
      rungs: Array.from({ length: options.rungsPerRoutine }, (_, rungIndex): PlcRung => {
        const target = boolTag(Math.floor(random() * boolTagCount));
        const accumulator = dintTag(Math.floor(random() * dintTagCount));
        const contacts = Array.from(
          { length: options.contactsPerRung },
          (_, contactIndex): InstructionNode => {
            instructionCount += 1;
            return {
              id: `p${programIndex}-r${routineIndex}-g${rungIndex}-c${contactIndex}`,
              opcode: random() > 0.5 ? "xic" : "xio",
              args: { tag: boolTag(Math.floor(random() * boolTagCount)) },
            };
          },
        );
        const useMath = random() > 0.35;
        const trailing: InstructionNode[] = useMath
          ? [
              {
                id: `p${programIndex}-r${routineIndex}-g${rungIndex}-add`,
                opcode: "add",
                args: { a: accumulator, b: Math.floor(random() * 10) + 1, dest: accumulator },
              },
              {
                id: `p${programIndex}-r${routineIndex}-g${rungIndex}-limit`,
                opcode: "limit",
                args: { min: 0, value: accumulator, max: 100_000, dest: accumulator },
              },
              {
                id: `p${programIndex}-r${routineIndex}-g${rungIndex}-ote`,
                opcode: "ote",
                args: { tag: target },
              },
            ]
          : [
              {
                id: `p${programIndex}-r${routineIndex}-g${rungIndex}-branch`,
                opcode: "branch",
                args: {},
                children: [
                  {
                    id: `p${programIndex}-r${routineIndex}-g${rungIndex}-path-a`,
                    opcode: "series",
                    args: {},
                    children: [
                      {
                        id: `p${programIndex}-r${routineIndex}-g${rungIndex}-path-a-contact`,
                        opcode: "xic",
                        args: { tag: boolTag(Math.floor(random() * boolTagCount)) },
                      },
                    ],
                  },
                  {
                    id: `p${programIndex}-r${routineIndex}-g${rungIndex}-path-b`,
                    opcode: "series",
                    args: {},
                    children: [
                      {
                        id: `p${programIndex}-r${routineIndex}-g${rungIndex}-path-b-contact`,
                        opcode: "xio",
                        args: { tag: boolTag(Math.floor(random() * boolTagCount)) },
                      },
                    ],
                  },
                ],
              },
              {
                id: `p${programIndex}-r${routineIndex}-g${rungIndex}-ote`,
                opcode: "ote",
                args: { tag: target },
              },
            ];
        instructionCount += countInstructions(trailing);
        return {
          id: `program-${programIndex}-routine-${routineIndex}-rung-${rungIndex}`,
          instructions: [
            {
              id: `p${programIndex}-r${routineIndex}-g${rungIndex}-series`,
              opcode: "series",
              args: {},
              children: [...contacts, ...trailing],
            },
          ],
        };
      }),
    })),
  }));

  instructionCount += options.programs * options.routinesPerProgram * options.rungsPerRoutine;
  return { source: { name: `GeneratedPerf${options.seed}`, tags, programs }, instructionCount };
}

function countInstructions(instructions: InstructionNode[]): number {
  let count = 0;
  for (const instruction of instructions) {
    count += 1;
    count += countInstructions(instruction.children ?? []);
  }
  return count;
}

async function benchmarkScans(
  source: ProgramSource,
  scans: number,
  instructionsPerScan: number,
): Promise<ScanBenchmarkResult> {
  const engine = createPlcEngine();
  await engine.loadProgram(source);
  await engine.scan();

  const started = nowMs();
  for (let scan = 0; scan < scans; scan += 1) {
    engine.tags.set(boolTag(scan % 128), scan % 2 === 0);
    engine.tags.set(boolTag((scan * 7) % 128), scan % 3 === 0);
    await engine.scan();
  }
  const elapsedMs = Math.max(0.001, nowMs() - started);
  const scansPerSecond = (scans / elapsedMs) * 1_000;
  const instructionsPerSecond = ((scans * instructionsPerScan) / elapsedMs) * 1_000;
  return { scans, elapsedMs, scansPerSecond, instructionsPerScan, instructionsPerSecond };
}

function report(label: string, result: ScanBenchmarkResult): void {
  console.info(
    `[perf] ${label}: ${result.scans.toLocaleString()} scans in ${result.elapsedMs.toFixed(2)}ms, ` +
      `${Math.round(result.scansPerSecond).toLocaleString()} scans/sec, ` +
      `${Math.round(result.instructionsPerSecond).toLocaleString()} instructions/sec ` +
      `(${result.instructionsPerScan.toLocaleString()} instructions/scan)`,
  );
}

describe("PLC scan performance", () => {
  test("reports full program scans per second for a generated medium ladder program", async () => {
    const generated = generatedProgram({
      seed: 0x5eed,
      programs: 2,
      routinesPerProgram: 2,
      rungsPerRoutine: 30,
      contactsPerRung: 4,
    });

    const result = await benchmarkScans(generated.source, 40, generated.instructionCount);
    report("medium generated ladder", result);

    expect(result.scans).toBe(40);
    expect(result.instructionsPerScan).toBeGreaterThan(1_000);
    expect(result.scansPerSecond).toBeGreaterThan(1);
    expect(result.instructionsPerSecond).toBeGreaterThan(result.scansPerSecond);
  });

  test("reports scan throughput across generated program sizes", async () => {
    const cases = [
      {
        label: "small",
        scans: 80,
        options: {
          seed: 101,
          programs: 1,
          routinesPerProgram: 1,
          rungsPerRoutine: 25,
          contactsPerRung: 3,
        },
      },
      {
        label: "large",
        scans: 20,
        options: {
          seed: 202,
          programs: 3,
          routinesPerProgram: 3,
          rungsPerRoutine: 20,
          contactsPerRung: 5,
        },
      },
    ];

    for (const entry of cases) {
      const generated = generatedProgram(entry.options);
      const result = await benchmarkScans(
        generated.source,
        entry.scans,
        generated.instructionCount,
      );
      report(`${entry.label} generated ladder`, result);
      expect(result.scansPerSecond).toBeGreaterThan(1);
      expect(result.instructionsPerScan).toBeGreaterThan(100);
    }
  });
});
