import { describe, expect, test } from "bun:test";
import {
  createPlcEngine,
  type InstructionNode,
  type ProgramSource,
  type VariableDeclaration,
} from "@plc-emulation/core";

type TagValue = VariableDeclaration["initialValue"];

function tag(
  name: string,
  initialValue?: TagValue,
  type?: VariableDeclaration["type"],
): VariableDeclaration {
  return { name, type, initialValue };
}

function timer(name: string, pre = 0): VariableDeclaration {
  return tag(name, { PRE: pre, ACC: 0, EN: false, TT: false, DN: false }, "TIMER");
}

function counter(name: string, pre = 0, acc = 0): VariableDeclaration {
  return tag(
    name,
    { PRE: pre, ACC: acc, CU: false, CD: false, DN: false, OV: false, UN: false },
    "COUNTER",
  );
}

function program(tags: VariableDeclaration[], instructions: InstructionNode[]): ProgramSource {
  return {
    name: "InstructionSemantics",
    tags,
    programs: [
      {
        id: "p",
        name: "P",
        routines: [
          {
            id: "r",
            name: "R",
            language: "ladder",
            rungs: instructions.map((instruction, index) => ({
              id: `rung-${index}`,
              instructions: [instruction],
            })),
          },
        ],
      },
    ],
  };
}

async function loaded(tags: VariableDeclaration[], instructions: InstructionNode[]) {
  const engine = createPlcEngine();
  await engine.loadProgram(program(tags, instructions));
  return engine;
}

function series(id: string, instructions: InstructionNode[]): InstructionNode {
  return { id, opcode: "series", args: {}, children: instructions };
}

describe("built-in instruction semantics", () => {
  test("contacts and coils follow ladder power flow, latch, and unlatch behavior", async () => {
    const engine = await loaded(
      [
        tag("In", false, "BOOL"),
        tag("Set", false, "BOOL"),
        tag("Reset", false, "BOOL"),
        tag("Out", true, "BOOL"),
        tag("NotIn", false, "BOOL"),
        tag("Latched", false, "BOOL"),
      ],
      [
        series("out-rung", [
          { id: "xic-in", opcode: "xic", args: { tag: "In" } },
          { id: "ote-out", opcode: "ote", args: { tag: "Out" } },
        ]),
        series("not-rung", [
          { id: "xio-in", opcode: "xio", args: { tag: "In" } },
          { id: "ote-not", opcode: "ote", args: { tag: "NotIn" } },
        ]),
        series("latch-rung", [
          { id: "xic-set", opcode: "xic", args: { tag: "Set" } },
          { id: "otl", opcode: "otl", args: { tag: "Latched" } },
        ]),
        series("unlatch-rung", [
          { id: "xic-reset", opcode: "xic", args: { tag: "Reset" } },
          { id: "otu", opcode: "otu", args: { tag: "Latched" } },
        ]),
      ],
    );

    await engine.scan();
    expect(engine.tags.get("Out")).toBe(false);
    expect(engine.tags.get("NotIn")).toBe(true);
    expect(engine.tags.get("Latched")).toBe(false);

    engine.tags.set("In", true);
    engine.tags.set("Set", true);
    await engine.scan();
    expect(engine.tags.get("Out")).toBe(true);
    expect(engine.tags.get("NotIn")).toBe(false);
    expect(engine.tags.get("Latched")).toBe(true);

    engine.tags.set("In", false);
    engine.tags.set("Set", false);
    await engine.scan();
    expect(engine.tags.get("Out")).toBe(false);
    expect(engine.tags.get("Latched")).toBe(true);

    engine.tags.set("Reset", true);
    await engine.scan();
    expect(engine.tags.get("Latched")).toBe(false);
  });

  test("one-shot and edge instructions emit exactly one scan for matching transitions", async () => {
    const engine = await loaded(
      [
        tag("Signal", false, "BOOL"),
        tag("OnsStorage", false, "BOOL"),
        tag("StoredOnsStorage", false, "BOOL"),
        tag("OsfStorage", false, "BOOL"),
        tag("OnsRise", false, "BOOL"),
        tag("StoredPulse", false, "BOOL"),
        tag("RTrig", false, "BOOL"),
        tag("FTrig", false, "BOOL"),
        tag("Osf", false, "BOOL"),
      ],
      [
        series("ons-rise", [
          { id: "ons-rise-contact", opcode: "xic", args: { tag: "Signal" } },
          { id: "ons-rise-i", opcode: "ons", args: { storage: "OnsStorage" } },
          { id: "ons-rise-o", opcode: "ote", args: { tag: "OnsRise" } },
        ]),
        series("ons-storage", [
          { id: "ons-storage-contact", opcode: "xic", args: { tag: "Signal" } },
          { id: "ons-storage-i", opcode: "ons", args: { storage: "StoredOnsStorage" } },
          { id: "ons-storage-o", opcode: "ote", args: { tag: "StoredPulse" } },
        ]),
        series("r-trig", [
          { id: "rtrig-i", opcode: "r_trig", args: { tag: "Signal" } },
          { id: "rtrig-o", opcode: "ote", args: { tag: "RTrig" } },
        ]),
        series("f-trig", [
          { id: "ftrig-i", opcode: "f_trig", args: { tag: "Signal" } },
          { id: "ftrig-o", opcode: "ote", args: { tag: "FTrig" } },
        ]),
        series("osf", [
          { id: "osf-contact", opcode: "xic", args: { tag: "Signal" } },
          { id: "osf-i", opcode: "osf", args: { storage: "OsfStorage", output: "Osf" } },
        ]),
      ],
    );

    await engine.scan();
    expect(engine.tags.get("OnsRise")).toBe(false);
    expect(engine.tags.get("OnsStorage")).toBe(false);

    engine.tags.set("Signal", true);
    await engine.scan();
    expect(engine.tags.get("OnsRise")).toBe(true);
    expect(engine.tags.get("StoredPulse")).toBe(true);
    expect(engine.tags.get("RTrig")).toBe(true);
    expect(engine.tags.get("FTrig")).toBe(false);

    await engine.scan();
    expect(engine.tags.get("OnsRise")).toBe(false);
    expect(engine.tags.get("StoredPulse")).toBe(false);
    expect(engine.tags.get("RTrig")).toBe(false);

    engine.tags.set("Signal", false);
    await engine.scan();
    expect(engine.tags.get("FTrig")).toBe(true);
    expect(engine.tags.get("Osf")).toBe(true);

    await engine.scan();
    expect(engine.tags.get("Osf")).toBe(false);
  });

  test("timer instructions use scan transitions and the injected clock", async () => {
    const engine = await loaded(
      [
        tag("Enable", false, "BOOL"),
        tag("Pulse", false, "BOOL"),
        timer("TOn", 100),
        timer("TOff", 100),
        timer("TPulse", 100),
      ],
      [
        series("ton-rung", [
          { id: "xic-ton", opcode: "xic", args: { tag: "Enable" } },
          { id: "ton", opcode: "ton", args: { timer: "TOn", pre: 100 } },
        ]),
        series("tof-rung", [
          { id: "xic-tof", opcode: "xic", args: { tag: "Enable" } },
          { id: "tof", opcode: "tof", args: { timer: "TOff", pre: 100 } },
        ]),
        series("tp-rung", [
          { id: "xic-tp", opcode: "xic", args: { tag: "Pulse" } },
          { id: "tp", opcode: "tp", args: { timer: "TPulse", pre: 100 } },
        ]),
      ],
    );

    await engine.scan();
    engine.clock.advance(1_000);
    engine.tags.set("Enable", true);
    await engine.scan();
    expect(engine.tags.get<Record<string, unknown>>("TOn").ACC).toBe(0);
    expect(engine.tags.get<Record<string, unknown>>("TOn").DN).toBe(false);
    expect(engine.tags.get<Record<string, unknown>>("TOff").DN).toBe(true);

    engine.clock.advance(60);
    await engine.scan();
    expect(engine.tags.get<Record<string, unknown>>("TOn").ACC).toBe(60);
    expect(engine.tags.get<Record<string, unknown>>("TOn").TT).toBe(true);

    engine.clock.advance(40);
    await engine.scan();
    expect(engine.tags.get<Record<string, unknown>>("TOn").ACC).toBe(100);
    expect(engine.tags.get<Record<string, unknown>>("TOn").DN).toBe(true);

    engine.tags.set("Enable", false);
    await engine.scan();
    expect(engine.tags.get<Record<string, unknown>>("TOn").ACC).toBe(0);
    expect(engine.tags.get<Record<string, unknown>>("TOff").ACC).toBe(0);
    expect(engine.tags.get<Record<string, unknown>>("TOff").DN).toBe(true);

    engine.clock.advance(100);
    await engine.scan();
    expect(engine.tags.get<Record<string, unknown>>("TOff").DN).toBe(false);

    engine.tags.set("Pulse", true);
    await engine.scan();
    expect(engine.tags.get<Record<string, unknown>>("TPulse").TT).toBe(true);
    engine.clock.advance(100);
    await engine.scan();
    expect(engine.tags.get<Record<string, unknown>>("TPulse").TT).toBe(false);
    expect(engine.tags.get<Record<string, unknown>>("TPulse").DN).toBe(true);
  });

  test("counters and reset operate on rising count edges", async () => {
    const engine = await loaded(
      [
        tag("Up", false, "BOOL"),
        tag("Down", false, "BOOL"),
        tag("Reset", false, "BOOL"),
        counter("CUp", 2),
        counter("CDown", 0, 2),
        counter("CBoth", 1),
      ],
      [
        series("ctu-rung", [
          { id: "up-contact", opcode: "xic", args: { tag: "Up" } },
          { id: "ctu", opcode: "ctu", args: { counter: "CUp", pre: 2 } },
        ]),
        series("ctd-rung", [
          { id: "down-contact", opcode: "xic", args: { tag: "Down" } },
          { id: "ctd", opcode: "ctd", args: { counter: "CDown", pre: 0 } },
        ]),
        { id: "ctud", opcode: "ctud", args: { counter: "CBoth", up: "Up", down: "Down", pre: 1 } },
        series("res-rung", [
          { id: "reset-contact", opcode: "xic", args: { tag: "Reset" } },
          { id: "res", opcode: "res", args: { counter: "CUp" } },
        ]),
      ],
    );

    await engine.scan();
    engine.tags.set("Up", true);
    await engine.scan();
    expect(engine.tags.get<Record<string, unknown>>("CUp").ACC).toBe(1);
    expect(engine.tags.get<Record<string, unknown>>("CBoth").ACC).toBe(1);
    expect(engine.tags.get<Record<string, unknown>>("CBoth").DN).toBe(true);

    await engine.scan();
    expect(engine.tags.get<Record<string, unknown>>("CUp").ACC).toBe(1);

    engine.tags.set("Up", false);
    await engine.scan();
    engine.tags.set("Up", true);
    await engine.scan();
    expect(engine.tags.get<Record<string, unknown>>("CUp").ACC).toBe(2);
    expect(engine.tags.get<Record<string, unknown>>("CUp").DN).toBe(true);

    engine.tags.set("Up", false);
    engine.tags.set("Down", true);
    await engine.scan();
    expect(engine.tags.get<Record<string, unknown>>("CDown").ACC).toBe(1);

    engine.tags.set("Reset", true);
    await engine.scan();
    expect(engine.tags.get<Record<string, unknown>>("CUp").ACC).toBe(0);
    expect(engine.tags.get<Record<string, unknown>>("CUp").DN).toBe(false);
  });

  test("counter instructions inhibit an initial true rung count", async () => {
    const engine = await loaded(
      [
        tag("Up", true, "BOOL"),
        tag("Down", true, "BOOL"),
        counter("CUp", 2),
        counter("CDown", 0, 2),
      ],
      [
        series("ctu-rung", [
          { id: "up-contact", opcode: "xic", args: { tag: "Up" } },
          { id: "ctu", opcode: "ctu", args: { counter: "CUp", pre: 2 } },
        ]),
        series("ctd-rung", [
          { id: "down-contact", opcode: "xic", args: { tag: "Down" } },
          { id: "ctd", opcode: "ctd", args: { counter: "CDown", pre: 0 } },
        ]),
      ],
    );

    await engine.prescan();
    await engine.scan();
    expect(engine.tags.get<Record<string, unknown>>("CUp").ACC).toBe(0);
    expect(engine.tags.get<Record<string, unknown>>("CDown").ACC).toBe(2);

    engine.tags.set("Up", false);
    engine.tags.set("Down", false);
    await engine.scan();
    engine.tags.set("Up", true);
    engine.tags.set("Down", true);
    await engine.scan();

    expect(engine.tags.get<Record<string, unknown>>("CUp").ACC).toBe(1);
    expect(engine.tags.get<Record<string, unknown>>("CDown").ACC).toBe(1);
  });

  test("bistables preserve state and apply set/reset precedence", async () => {
    const engine = await loaded(
      [
        tag("Enable", true, "BOOL"),
        tag("Set", false, "BOOL"),
        tag("Reset", false, "BOOL"),
        tag("SetDominant", false, "BOOL"),
        tag("ResetDominant", false, "BOOL"),
      ],
      [
        series("sr-rung", [
          { id: "sr-enable", opcode: "xic", args: { tag: "Enable" } },
          { id: "sr", opcode: "sr", args: { set: "Set", reset: "Reset", dest: "SetDominant" } },
        ]),
        series("rs-rung", [
          { id: "rs-enable", opcode: "xic", args: { tag: "Enable" } },
          { id: "rs", opcode: "rs", args: { set: "Set", reset: "Reset", dest: "ResetDominant" } },
        ]),
      ],
    );

    engine.tags.set("Set", true);
    await engine.scan();
    expect(engine.tags.get("SetDominant")).toBe(true);
    expect(engine.tags.get("ResetDominant")).toBe(true);

    engine.tags.set("Set", false);
    await engine.scan();
    expect(engine.tags.get("SetDominant")).toBe(true);
    expect(engine.tags.get("ResetDominant")).toBe(true);

    engine.tags.set("Set", true);
    engine.tags.set("Reset", true);
    await engine.scan();
    expect(engine.tags.get("SetDominant")).toBe(true);
    expect(engine.tags.get("ResetDominant")).toBe(false);

    engine.tags.set("Enable", false);
    engine.tags.set("Set", false);
    engine.tags.set("Reset", true);
    await engine.scan();
    expect(engine.tags.get("SetDominant")).toBe(true);
    expect(engine.tags.get("ResetDominant")).toBe(false);
  });

  test("comparison instructions gate downstream power", async () => {
    const engine = await loaded(
      [
        tag("A", 3, "DINT"),
        tag("B", 3, "DINT"),
        tag("Eq", false, "BOOL"),
        tag("Neq", true, "BOOL"),
        tag("Gt", true, "BOOL"),
        tag("Ge", false, "BOOL"),
        tag("Lt", true, "BOOL"),
        tag("Le", false, "BOOL"),
      ],
      [
        series("equ", [
          { id: "equ-i", opcode: "equ", args: { a: "A", b: "B" } },
          { id: "equ-o", opcode: "ote", args: { tag: "Eq" } },
        ]),
        series("neq", [
          { id: "neq-i", opcode: "neq", args: { a: "A", b: "B" } },
          { id: "neq-o", opcode: "ote", args: { tag: "Neq" } },
        ]),
        series("gt", [
          { id: "gt-i", opcode: "gt", args: { a: "A", b: "B" } },
          { id: "gt-o", opcode: "ote", args: { tag: "Gt" } },
        ]),
        series("ge", [
          { id: "ge-i", opcode: "ge", args: { a: "A", b: "B" } },
          { id: "ge-o", opcode: "ote", args: { tag: "Ge" } },
        ]),
        series("lt", [
          { id: "lt-i", opcode: "lt", args: { a: "A", b: "B" } },
          { id: "lt-o", opcode: "ote", args: { tag: "Lt" } },
        ]),
        series("le", [
          { id: "le-i", opcode: "le", args: { a: "A", b: "B" } },
          { id: "le-o", opcode: "ote", args: { tag: "Le" } },
        ]),
      ],
    );

    await engine.scan();
    expect(engine.tags.get("Eq")).toBe(true);
    expect(engine.tags.get("Neq")).toBe(false);
    expect(engine.tags.get("Gt")).toBe(false);
    expect(engine.tags.get("Ge")).toBe(true);
    expect(engine.tags.get("Lt")).toBe(false);
    expect(engine.tags.get("Le")).toBe(true);
  });

  test("comparison instructions prevent downstream move writes when false", async () => {
    const engine = await loaded(
      [
        tag("A", 1, "DINT"),
        tag("B", 2, "DINT"),
        tag("Source", 42, "DINT"),
        tag("Destination", 7, "DINT"),
      ],
      [
        series("false-equ-move", [
          { id: "equ-false", opcode: "equ", args: { a: "A", b: "B" } },
          { id: "mov-after-equ", opcode: "mov", args: { source: "Source", dest: "Destination" } },
        ]),
      ],
    );

    await engine.scan();
    expect(engine.tags.get("Destination")).toBe(7);
  });

  test("math, move, conversion, and selection instructions write expected values", async () => {
    const engine = await loaded(
      [
        tag("A", 8, "DINT"),
        tag("B", 3, "DINT"),
        tag("Index", 1, "DINT"),
        tag("Gate", true, "BOOL"),
        tag("Add", 0, "DINT"),
        tag("Sub", 0, "DINT"),
        tag("Mul", 0, "DINT"),
        tag("Div", 0, "REAL"),
        tag("Mod", 0, "DINT"),
        tag("Moved", 0, "DINT"),
        tag("BoolValue", false, "BOOL"),
        tag("StringValue", "", "STRING"),
        tag("Selected", 0, "DINT"),
        tag("Muxed", 0, "DINT"),
        tag("Min", 0, "DINT"),
        tag("Max", 0, "DINT"),
        tag("Limited", 0, "DINT"),
      ],
      [
        { id: "add", opcode: "add", args: { a: "A", b: "B", dest: "Add" } },
        { id: "sub", opcode: "sub", args: { a: "A", b: "B", dest: "Sub" } },
        { id: "mul", opcode: "mul", args: { a: "A", b: "B", dest: "Mul" } },
        { id: "div", opcode: "div", args: { a: "A", b: "B", dest: "Div" } },
        { id: "mod", opcode: "mod", args: { a: "A", b: "B", dest: "Mod" } },
        { id: "mov", opcode: "mov", args: { source: "A", dest: "Moved" } },
        { id: "to-bool", opcode: "to_bool", args: { source: "A", dest: "BoolValue" } },
        { id: "to-string", opcode: "to.string", args: { source: "B", dest: "StringValue" } },
        { id: "sel", opcode: "sel", args: { g: "Gate", in0: 10, in1: 20, dest: "Selected" } },
        {
          id: "mux",
          opcode: "mux",
          args: { index: "Index", inputs: [10, "A", 30], dest: "Muxed" },
        },
        { id: "min", opcode: "min", args: { values: [9, "A", "B"], dest: "Min" } },
        { id: "max", opcode: "max", args: { values: [9, "A", "B"], dest: "Max" } },
        { id: "limit", opcode: "limit", args: { min: 0, value: 14, max: 10, dest: "Limited" } },
      ],
    );

    await engine.scan();
    expect(engine.tags.get("Add")).toBe(11);
    expect(engine.tags.get("Sub")).toBe(5);
    expect(engine.tags.get("Mul")).toBe(24);
    expect(engine.tags.get("Div")).toBeCloseTo(8 / 3);
    expect(engine.tags.get("Mod")).toBe(2);
    expect(engine.tags.get("Moved")).toBe(8);
    expect(engine.tags.get("BoolValue")).toBe(true);
    expect(engine.tags.get("StringValue")).toBe("3");
    expect(engine.tags.get("Selected")).toBe(20);
    expect(engine.tags.get("Muxed")).toBe(8);
    expect(engine.tags.get("Min")).toBe(3);
    expect(engine.tags.get("Max")).toBe(9);
    expect(engine.tags.get("Limited")).toBe(10);
  });

  test("Logix MOV/FLL conversions and CONCAT follow Rockwell-compatible semantics", async () => {
    const engine = await loaded(
      [
        tag("RealSource", 123.5, "REAL"),
        tag("DintDest", 0, "DINT"),
        tag("IntDest", 0, "INT"),
        tag("RealDest", 0, "REAL"),
        tag("StringA", "Alarm ", "STRING"),
        tag("StringB", "Active", "STRING"),
        tag("Message", "", "STRING"),
        tag(
          "Struct",
          { A: true, B: 7, Nested: { C: true } },
          {
            kind: "struct",
            members: {
              A: { name: "A", type: "BOOL" },
              B: { name: "B", type: "DINT" },
              Nested: {
                name: "Nested",
                type: { kind: "struct", members: { C: { name: "C", type: "BOOL" } } },
              },
            },
          },
        ),
      ],
      [
        { id: "mov-real-dint", opcode: "mov", args: { source: "RealSource", dest: "DintDest" } },
        { id: "mov-dint-real", opcode: "mov", args: { source: "DintDest", dest: "RealDest" } },
        { id: "mov-truncate", opcode: "mov", args: { source: 32767.4, dest: "IntDest" } },
        {
          id: "concat",
          opcode: "concat",
          args: { sourceA: "StringA", sourceB: "StringB", dest: "Message" },
        },
        { id: "fll-struct", opcode: "fll", args: { source: 0, dest: "Struct", length: 1 } },
      ],
    );

    await engine.scan();
    expect(engine.tags.get("DintDest")).toBe(124);
    expect(engine.tags.get("RealDest")).toBe(124);
    expect(engine.tags.get("IntDest")).toBe(32767);
    expect(engine.tags.get("Message")).toBe("Alarm Active");
    expect(engine.tags.get("Struct")).toEqual({ A: false, B: 0, Nested: { C: false } });
  });

  test("Rockwell file, compute, system, and program-control instructions execute", async () => {
    const engine = await loaded(
      [
        tag("Gate", true, "BOOL"),
        tag("Skipped", false, "BOOL"),
        tag("Ended", false, "BOOL"),
        tag("AfterEnd", false, "BOOL"),
        tag("Source", [1, 2, 3, 4], {
          kind: "array",
          elementType: "DINT",
          dimensions: [{ lower: 0, upper: 3 }],
        }),
        tag("Dest", [0, 0, 0, 0], {
          kind: "array",
          elementType: "DINT",
          dimensions: [{ lower: 0, upper: 3 }],
        }),
        tag("Filled", [0, 0, 0], {
          kind: "array",
          elementType: "DINT",
          dimensions: [{ lower: 0, upper: 2 }],
        }),
        tag("A", 5, "DINT"),
        tag("B", 3, "DINT"),
        tag("Computed", 0, "DINT"),
        tag("Cosine", 0, "REAL"),
        tag("ScanNumber", 0, "DINT"),
      ],
      [
        series("afi-rung", [
          { id: "afi", opcode: "afi", args: {} },
          { id: "afi-out", opcode: "ote", args: { tag: "Skipped" } },
        ]),
        { id: "cop", opcode: "cop", args: { source: "Source", dest: "Dest", length: 3 } },
        { id: "cps", opcode: "cps", args: { source: "Source[1]", dest: "Dest[3]", length: 1 } },
        { id: "fll", opcode: "fll", args: { source: 9, dest: "Filled", length: 3 } },
        { id: "cpt", opcode: "cpt", args: { expression: "A + B * 2", dest: "Computed" } },
        { id: "cos", opcode: "cos", args: { source: 0, dest: "Cosine" } },
        {
          id: "gsv",
          opcode: "gsv",
          args: { class: "Controller", attribute: "ScanNumber", dest: "ScanNumber" },
        },
        series("jump-rung", [
          { id: "jump-contact", opcode: "xic", args: { tag: "Gate" } },
          { id: "jump", opcode: "jmp", args: { label: "done" } },
        ]),
        { id: "jumped-over", opcode: "ote", args: { tag: "Skipped" } },
        { id: "label", opcode: "lbl", args: { label: "done" } },
        { id: "end-before", opcode: "ote", args: { tag: "Ended" } },
        { id: "tnd", opcode: "tnd", args: {} },
        { id: "after-end", opcode: "ote", args: { tag: "AfterEnd" } },
      ],
    );

    await engine.scan();
    expect(engine.tags.get("Skipped")).toBe(false);
    expect(engine.tags.get("Dest")).toEqual([1, 2, 3, 2]);
    expect(engine.tags.get("Filled")).toEqual([9, 9, 9]);
    expect(engine.tags.get("Computed")).toBe(11);
    expect(engine.tags.get("Cosine")).toBe(1);
    expect(engine.tags.get("ScanNumber")).toBe(1);
    expect(engine.tags.get("Ended")).toBe(true);
    expect(engine.tags.get("AfterEnd")).toBe(false);
  });

  test("GSV Task.Rate reads the current or named task period", async () => {
    const source: ProgramSource = {
      name: "TaskRateProgram",
      tags: [
        tag("CurrentRate", 0, "DINT"),
        tag("NamedRate", 0, "DINT"),
        tag("CurrentTask", "", "STRING"),
      ],
      tasks: [{ id: "fast-task", name: "FastTask", kind: "periodic", priority: 1, periodMs: 25 }],
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
                  id: "rate-rung",
                  instructions: [
                    {
                      id: "gsv-current-rate",
                      opcode: "gsv",
                      args: { class: "Task", attribute: "Rate", dest: "CurrentRate" },
                    },
                    {
                      id: "gsv-named-rate",
                      opcode: "gsv",
                      args: {
                        class: "Task",
                        objectName: "FastTask",
                        attribute: "Rate",
                        dest: "NamedRate",
                      },
                    },
                    {
                      id: "gsv-task-name",
                      opcode: "gsv",
                      args: { class: "Task", attribute: "Name", dest: "CurrentTask" },
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
    await engine.loadProgram(source);

    await engine.scan();

    expect(engine.tags.get("CurrentRate")).toBe(25);
    expect(engine.tags.get("NamedRate")).toBe(25);
    expect(engine.tags.get("CurrentTask")).toBe("FastTask");
  });

  test("FOR invokes a routine repeatedly with the configured index", async () => {
    const source: ProgramSource = {
      name: "ForProgram",
      tags: [tag("Index", 0, "DINT"), tag("Total", 0, "DINT")],
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
                  id: "for-rung",
                  instructions: [
                    {
                      id: "for",
                      opcode: "for",
                      args: { routine: "Body", index: "Index", initial: 1, terminal: 3, step: 1 },
                    },
                  ],
                },
              ],
            },
            {
              id: "body",
              name: "Body",
              language: "ladder",
              rungs: [
                {
                  id: "body-rung",
                  instructions: [
                    { id: "add", opcode: "add", args: { a: "Total", b: "Index", dest: "Total" } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const engine = createPlcEngine();
    await engine.loadProgram(source);

    await engine.scan();
    expect(engine.tags.get("Index")).toBe(3);
    expect(engine.tags.get("Total")).toBe(9);
  });

  test("structural branch and parallel nodes OR their child paths while series nodes AND them", async () => {
    const engine = await loaded(
      [
        tag("A", false, "BOOL"),
        tag("B", false, "BOOL"),
        tag("SeriesOut", false, "BOOL"),
        tag("BranchOut", false, "BOOL"),
        tag("ParallelOut", false, "BOOL"),
      ],
      [
        series("and-rung", [
          { id: "and-a", opcode: "xic", args: { tag: "A" } },
          { id: "and-b", opcode: "xic", args: { tag: "B" } },
          { id: "and-out", opcode: "ote", args: { tag: "SeriesOut" } },
        ]),
        series("branch-rung", [
          {
            id: "branch",
            opcode: "branch",
            args: {},
            children: [
              series("branch-a", [{ id: "branch-a-contact", opcode: "xic", args: { tag: "A" } }]),
              series("branch-b", [{ id: "branch-b-contact", opcode: "xic", args: { tag: "B" } }]),
            ],
          },
          { id: "branch-out", opcode: "ote", args: { tag: "BranchOut" } },
        ]),
        series("parallel-rung", [
          {
            id: "parallel",
            opcode: "parallel",
            args: {},
            children: [
              series("parallel-a", [
                { id: "parallel-a-contact", opcode: "xic", args: { tag: "A" } },
              ]),
              series("parallel-b", [
                { id: "parallel-b-contact", opcode: "xic", args: { tag: "B" } },
              ]),
            ],
          },
          { id: "parallel-out", opcode: "ote", args: { tag: "ParallelOut" } },
        ]),
      ],
    );

    await engine.scan();
    expect(engine.tags.get("SeriesOut")).toBe(false);
    expect(engine.tags.get("BranchOut")).toBe(false);
    expect(engine.tags.get("ParallelOut")).toBe(false);

    engine.tags.set("A", true);
    await engine.scan();
    expect(engine.tags.get("SeriesOut")).toBe(false);
    expect(engine.tags.get("BranchOut")).toBe(true);
    expect(engine.tags.get("ParallelOut")).toBe(true);

    engine.tags.set("B", true);
    await engine.scan();
    expect(engine.tags.get("SeriesOut")).toBe(true);
  });

  test("DIV by zero stores SourceA and raises a minor math fault when powered", async () => {
    const engine = await loaded(
      [
        tag("EnableDiv", false, "BOOL"),
        tag("A", 7, "DINT"),
        tag("Zero", 0, "DINT"),
        tag("Out", 0, "DINT"),
      ],
      [
        series("div-rung", [
          { id: "div-contact", opcode: "xic", args: { tag: "EnableDiv" } },
          { id: "div", opcode: "div", args: { a: "A", b: "Zero", dest: "Out" } },
        ]),
      ],
    );

    await engine.scan();
    expect(engine.tags.get("Out")).toBe(0);
    expect(engine.faults.list()).toHaveLength(0);

    engine.tags.set("EnableDiv", true);
    await engine.scan();
    expect(engine.tags.get("Out")).toBe(7);
    expect(engine.controller.mode).toBe("test");
    expect(engine.faults.list()[0]).toMatchObject({
      severity: "minor",
      code: "MATH_DIVIDE_BY_ZERO",
    });
  });

  test("explicit fault instruction faults the controller only when powered", async () => {
    const engine = await loaded(
      [tag("EnableFault", false, "BOOL")],
      [
        series("fault-rung", [
          { id: "fault-contact", opcode: "xic", args: { tag: "EnableFault" } },
          { id: "fault", opcode: "fault", args: { message: "Intentional" } },
        ]),
      ],
    );

    await engine.scan();
    expect(engine.controller.mode).toBe("test");

    engine.tags.set("EnableFault", true);
    await engine.scan();
    expect(engine.controller.mode).toBe("faulted");
  });
});
