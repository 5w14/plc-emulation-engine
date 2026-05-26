import {
  createPlcEngine,
  defineProgram,
  loadJsProgram,
  type InstructionDefinition,
  type PlcPlugin,
} from "@plc-emulation/core";

type EdgeCounterArgs = {
  input: string;
  count: string;
  pulse: string;
};

const edgeCounter: InstructionDefinition<EdgeCounterArgs> = {
  opcode: "react.edgeCounter",
  displayName: "Stateful Edge Counter",
  validate(args) {
    const diagnostics = [];
    if (!args.input) diagnostics.push({ severity: "error" as const, code: "MISSING_INPUT" });
    if (!args.count) diagnostics.push({ severity: "error" as const, code: "MISSING_COUNT" });
    if (!args.pulse) diagnostics.push({ severity: "error" as const, code: "MISSING_PULSE" });
    return diagnostics;
  },
  execute(args, context) {
    const previous = context.memory.get<boolean>("previous") ?? false;
    const count = context.memory.get<number>("count") ?? 0;
    const current = Boolean(context.tags.get(args.input));
    const rising = context.power && !previous && current;
    const nextCount = rising ? count + 1 : count;

    context.memory.set("previous", current);
    context.memory.set("count", nextCount);
    context.tags.set(args.pulse, rising);
    context.tags.set(args.count, nextCount);

    return { power: context.power };
  },
  reset(_args, context) {
    context.memory.set("previous", false);
    context.memory.set("count", 0);
  },
};

const reactLikePlugin: PlcPlugin = {
  id: "example/react-like-instructions",
  instructions: [edgeCounter],
};

const source = await loadJsProgram({
  module: {
    default: defineProgram(({ task, program, routine, rung, instruction }) => {
      task("MainTask", () => {
        program("MainProgram", () => {
          routine("MainRoutine", () => {
            rung("Custom edge counter", () => {
              instruction("react.edgeCounter", {
                input: "Start",
                pulse: "Pulse",
                count: "Count",
              } satisfies EdgeCounterArgs);
            });
            rung("Built-in one-shot", () => {
              instruction("ons", { tag: "Start" });
              instruction("ote", { tag: "OnsPulse" });
            });
            rung("Built-in rising trigger", () => {
              instruction("r_trig", { tag: "Start" });
              instruction("ote", { tag: "RTrigPulse" });
            });
            rung("Built-in falling trigger", () => {
              instruction("f_trig", { tag: "Start" });
              instruction("ote", { tag: "FTrigPulse" });
            });
            rung("Built-in on-delay timer", () => {
              instruction("xic", { tag: "Start" });
              instruction("ton", { timer: "StartTimer", pre: 100 });
            });
            rung("Built-in count-up counter", () => {
              instruction("xic", { tag: "Start" });
              instruction("ctu", { counter: "StartCounter", pre: 2 });
            });
            rung("Set-dominant latch", () => {
              instruction("sr", {
                set: "Pulse",
                reset: "ResetLatch",
                dest: "Latched",
              });
            });
          });
        });
      });
    }),
  },
});

source.tags = [
  { name: "Start", type: "BOOL", initialValue: false },
  { name: "Pulse", type: "BOOL", initialValue: false },
  { name: "Count", type: "DINT", initialValue: 0 },
  { name: "OnsPulse", type: "BOOL", initialValue: false },
  { name: "RTrigPulse", type: "BOOL", initialValue: false },
  { name: "FTrigPulse", type: "BOOL", initialValue: false },
  { name: "ResetLatch", type: "BOOL", initialValue: false },
  { name: "Latched", type: "BOOL", initialValue: false },
  {
    name: "StartTimer",
    type: "TIMER",
    initialValue: { PRE: 100, ACC: 0, EN: false, TT: false, DN: false },
  },
  {
    name: "StartCounter",
    type: "COUNTER",
    initialValue: { PRE: 2, ACC: 0, CU: false, CD: false, DN: false },
  },
];

const engine = createPlcEngine();
await engine.plugins.register(reactLikePlugin);
await engine.loadProgram(source);

const inputPattern = [
  { start: false, resetLatch: false, elapsedMs: 0 },
  { start: true, resetLatch: false, elapsedMs: 0 },
  { start: true, resetLatch: false, elapsedMs: 60 },
  { start: true, resetLatch: false, elapsedMs: 40 },
  { start: false, resetLatch: false, elapsedMs: 0 },
  { start: true, resetLatch: false, elapsedMs: 0 },
  { start: false, resetLatch: true, elapsedMs: 0 },
  { start: true, resetLatch: false, elapsedMs: 0 },
];

for (const [index, step] of inputPattern.entries()) {
  engine.clock.advance(step.elapsedMs);
  engine.tags.set("Start", step.start);
  engine.tags.set("ResetLatch", step.resetLatch);
  await engine.scan();

  const timer = engine.tags.get<Record<string, unknown>>("StartTimer");
  const counter = engine.tags.get<Record<string, unknown>>("StartCounter");

  console.log(
    JSON.stringify({
      scan: index + 1,
      nowMs: engine.clock.now(),
      Start: engine.tags.get("Start"),
      Pulse: engine.tags.get("Pulse"),
      Count: engine.tags.get("Count"),
      OnsPulse: engine.tags.get("OnsPulse"),
      RTrigPulse: engine.tags.get("RTrigPulse"),
      FTrigPulse: engine.tags.get("FTrigPulse"),
      Latched: engine.tags.get("Latched"),
      TimerACC: timer.ACC,
      TimerDN: timer.DN,
      CounterACC: counter.ACC,
      CounterDN: counter.DN,
    }),
  );
}
