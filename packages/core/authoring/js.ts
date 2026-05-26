import { id } from "../internal";
import type {
  AoiDefinition,
  FunctionBlockBuilderApi,
  InstructionNode,
  PlcNetwork,
  PlcProgramUnit,
  PlcRoutine,
  PlcTask,
  PouDefinition,
  ProgramBuilderApi,
  ProgramFactory,
  ProgramModule,
  ProgramSource,
  TagPath,
  VariableDeclaration,
} from "../types";

interface BuildState {
  source: ProgramSource;
  currentTask?: PlcTask;
  currentProgram?: PlcProgramUnit;
  currentRoutine?: PlcRoutine;
  currentNetwork?: PlcNetwork;
  currentRung?: { instructions: InstructionNode[] };
}

export function defineProgram(factory: ProgramFactory): ProgramFactory {
  return factory;
}

export async function loadIrProgram(source: ProgramSource): Promise<ProgramSource> {
  return source;
}

export async function loadJsProgram(input: {
  module: ProgramModule;
  sourceName?: string;
}): Promise<ProgramSource> {
  const entry = input.module.default ?? input.module.program;
  if (!entry) throw new Error("Program module must export default or program");
  if (typeof entry !== "function") return entry;
  const state: BuildState = {
    source: {
      name: input.sourceName ?? "JS Program",
      tasks: [],
      programs: [],
      pous: [],
      tags: [],
      aois: [],
    },
  };
  const result = await entry(createBuilder(state));
  return result ?? state.source;
}

export async function loadJsProgramFromUrl(input: {
  url: string | { toString(): string };
  importModule?: (url: string) => Promise<ProgramModule>;
}): Promise<ProgramSource> {
  const url = String(input.url);
  const importModule =
    input.importModule ?? ((specifier: string) => import(specifier) as Promise<ProgramModule>);
  return loadJsProgram({ module: await importModule(url), sourceName: url });
}

function createBuilder(state: BuildState): ProgramBuilderApi {
  const instruction = <TArgs>(opcode: string, args: TArgs): void => {
    const node = { id: id(opcode), opcode, args };
    if (state.currentRung) state.currentRung.instructions.push(node);
    else if (state.currentNetwork) {
      state.currentNetwork.instructions ??= [];
      state.currentNetwork.instructions.push(node);
    } else {
      throw new Error("Instruction must be declared inside a rung or network");
    }
  };
  const routineEntry = Object.assign(
    (name: string, build: () => void): void => {
      if (!state.currentProgram) throw new Error("routine() must be called inside program()");
      const routine = {
        id: id("routine"),
        name,
        language: "ladder",
        rungs: [],
      } satisfies PlcRoutine;
      state.currentProgram.routines?.push(routine);
      const previous = state.currentRoutine;
      state.currentRoutine = routine;
      build();
      state.currentRoutine = previous;
    },
    {
      scan(name: string, scan: NonNullable<PlcRoutine["scan"]>): void {
        if (!state.currentProgram)
          throw new Error("routine.scan() must be called inside program()");
        state.currentProgram.routines?.push({ id: id("routine"), name, language: "js", scan });
      },
    },
  );

  return {
    task(name, build) {
      const task = { id: id("task"), name, kind: "continuous", priority: 10 } satisfies PlcTask;
      state.source.tasks?.push(task);
      const previous = state.currentTask;
      state.currentTask = task;
      build();
      state.currentTask = previous;
    },
    program(name, build) {
      const program = {
        id: id("program"),
        name,
        routines: [],
        variables: [],
      } satisfies PlcProgramUnit;
      state.source.programs?.push(program);
      const previous = state.currentProgram;
      state.currentProgram = program;
      build();
      state.currentProgram = previous;
    },
    routine: routineEntry,
    rung(name, build) {
      if (!state.currentRoutine && !state.currentNetwork)
        throw new Error("rung() must be called inside routine() or network()");
      const rung = { id: id("rung"), name, instructions: [] };
      const previous = state.currentRung;
      state.currentRung = rung;
      build();
      state.currentRung = previous;
      if (state.currentNetwork) {
        state.currentNetwork.rungs ??= [];
        state.currentNetwork.rungs.push(rung);
      } else {
        state.currentRoutine?.rungs?.push(rung);
      }
    },
    network(name, build) {
      if (!state.currentRoutine) throw new Error("network() must be called inside routine()");
      const network = { id: id("network"), name, instructions: [], rungs: [] } satisfies PlcNetwork;
      state.currentRoutine.networks ??= [];
      state.currentRoutine.networks.push(network);
      const previous = state.currentNetwork;
      state.currentNetwork = network;
      build();
      state.currentNetwork = previous;
    },
    functionBlock(name, build) {
      state.source.pous?.push(buildFunctionBlock(name, build));
    },
    xic(path: TagPath) {
      instruction("xic", { tag: path });
    },
    xio(path: TagPath) {
      instruction("xio", { tag: path });
    },
    ons(path: TagPath, options?: { edge?: "rising" | "falling" | "both"; storage?: TagPath }) {
      instruction("ons", { tag: path, ...options });
    },
    ote(path: TagPath) {
      instruction("ote", { tag: path });
    },
    otl(path: TagPath) {
      instruction("otl", { tag: path });
    },
    otu(path: TagPath) {
      instruction("otu", { tag: path });
    },
    instruction,
  };
}

function buildFunctionBlock(
  name: string,
  build: (api: FunctionBlockBuilderApi) => void,
): PouDefinition {
  const inputs: VariableDeclaration[] = [];
  const outputs: VariableDeclaration[] = [];
  const inouts: VariableDeclaration[] = [];
  const variables: VariableDeclaration[] = [];
  const networks: PlcNetwork[] = [];
  const state: { currentNetwork?: PlcNetwork; currentRung?: { instructions: InstructionNode[] } } =
    {};
  const instruction = <TArgs>(opcode: string, args: TArgs): void => {
    const node = { id: id(opcode), opcode, args };
    if (state.currentRung) state.currentRung.instructions.push(node);
    else if (state.currentNetwork) {
      state.currentNetwork.instructions ??= [];
      state.currentNetwork.instructions.push(node);
    } else {
      throw new Error("Instruction must be declared inside a function block rung or network");
    }
  };

  build({
    input(name, type) {
      inputs.push({ name, type, class: "input" });
    },
    output(name, type) {
      outputs.push({ name, type, class: "output" });
    },
    inout(name, type) {
      inouts.push({ name, type, class: "inout" });
    },
    local(name, type, initialValue) {
      variables.push({ name, type, initialValue, class: "local" });
    },
    network(name, builder) {
      const network = { id: id("network"), name, instructions: [], rungs: [] } satisfies PlcNetwork;
      networks.push(network);
      const previous = state.currentNetwork;
      state.currentNetwork = network;
      builder();
      state.currentNetwork = previous;
    },
    rung(name, builder) {
      const rung = { id: id("rung"), name, instructions: [] };
      const previous = state.currentRung;
      state.currentRung = rung;
      builder();
      state.currentRung = previous;
      if (!state.currentNetwork) throw new Error("functionBlock rung() must be inside network()");
      state.currentNetwork.rungs ??= [];
      state.currentNetwork.rungs.push(rung);
    },
    xic(path) {
      instruction("xic", { tag: path });
    },
    xio(path) {
      instruction("xio", { tag: path });
    },
    ote(path) {
      instruction("ote", { tag: path });
    },
    instruction,
  });

  return {
    id: id("fb"),
    name,
    kind: "function-block",
    interface: { inputs, outputs, inouts },
    variables,
    body: { language: "ld", networks },
  };
}

export function aoiFromFunctionBlock(definition: PouDefinition): AoiDefinition {
  return {
    id: definition.id,
    name: definition.name,
    parameters: [
      ...(definition.interface.inputs ?? []).map((variable) => ({
        name: variable.name,
        type: variable.type,
        direction: "input" as const,
      })),
      ...(definition.interface.outputs ?? []).map((variable) => ({
        name: variable.name,
        type: variable.type,
        direction: "output" as const,
      })),
      ...(definition.interface.inouts ?? []).map((variable) => ({
        name: variable.name,
        type: variable.type,
        direction: "inout" as const,
      })),
    ],
    localTags: definition.variables,
    routines: definition.body.routines ?? [],
    metadata: definition.metadata,
  };
}
