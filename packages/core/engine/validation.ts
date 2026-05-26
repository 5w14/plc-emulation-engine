import { addressKey, id, parseTagPath, scopedPath } from "../internal";
import type {
  AoiDefinition,
  Diagnostic,
  InstructionDefinition,
  InstructionNode,
  PlcRoutine,
  PouDefinition,
  ProgramSource,
  TagStore,
} from "../types";

export interface ProgramValidationContext {
  tags: TagStore;
  getInstruction(opcode: string): InstructionDefinition | undefined;
  findPouOrAoi(name?: string): PouDefinition | AoiDefinition | undefined;
  structuralOpcodes: ReadonlySet<string>;
  callOpcodes: ReadonlySet<string>;
}

export function validateProgramSource(
  source: ProgramSource,
  context: ProgramValidationContext,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const add = (
    code: string,
    message: string,
    metadata?: Record<string, unknown>,
    sourceLocation?: Diagnostic["source"],
    severity: Diagnostic["severity"] = "error",
  ): void => {
    diagnostics.push({
      id: id("diagnostic"),
      severity,
      code,
      message,
      metadata,
      source: sourceLocation,
    });
  };
  const seenIds = new Set<string>();
  const tagNames = new Set<string>();
  const checkId = (kind: string, item: { id?: string; name?: string }): void => {
    if (!item.id) return;
    if (seenIds.has(item.id))
      add("DUPLICATE_ID", `Duplicate ${kind} id: ${item.id}`, { kind, id: item.id });
    seenIds.add(item.id);
  };

  for (const task of source.configuration?.resources.flatMap((resource) => resource.tasks) ?? []) {
    checkId("task", task);
    if (!Number.isFinite(task.priority))
      add("INVALID_TASK_PRIORITY", `Task ${task.name} priority must be numeric`, { task });
    if (task.kind === "periodic" && (!Number.isFinite(task.periodMs) || (task.periodMs ?? 0) < 0)) {
      add("INVALID_TASK_PERIOD", `Periodic task ${task.name} requires a non-negative periodMs`, {
        task,
      });
    }
  }

  const tasks = new Set(
    (source.configuration?.resources.flatMap((resource) => resource.tasks) ?? []).flatMap(
      (task) => [task.id, task.name],
    ),
  );
  const programIds = new Set([
    ...(source.programs ?? []).flatMap((program) => [program.id, program.name]),
    ...(source.pous ?? []).flatMap((pou) => [pou.id, pou.name]),
  ]);
  for (const program of source.programs ?? []) checkId("program", program);
  for (const pou of source.pous ?? []) checkId("pou", pou);
  for (const aoi of source.aois ?? []) checkId("aoi", aoi);
  for (const resource of source.configuration?.resources ?? []) {
    checkId("resource", resource);
    for (const instance of resource.programs) {
      checkId("program-instance", instance);
      if (instance.task && !tasks.has(instance.task))
        add(
          "UNKNOWN_TASK",
          `Program instance ${instance.name} references unknown task ${instance.task}`,
          { instance },
        );
      if (!programIds.has(instance.program))
        add(
          "UNKNOWN_PROGRAM",
          `Program instance ${instance.name} references unknown program ${instance.program}`,
          { instance },
        );
    }
  }

  const declareTagName = (
    kind: string,
    tag: { name: string; scope?: unknown; locatedAt?: unknown },
  ): void => {
    const key = scopedPath(tag.name, tag.scope as Parameters<typeof scopedPath>[1]);
    if (tagNames.has(key))
      add("DUPLICATE_TAG", `Duplicate ${kind} tag: ${tag.name}`, { kind, tag });
    tagNames.add(key);
    if (tag.locatedAt) validateDirectAddress(tag.locatedAt, add, { kind, tag });
    try {
      parseTagPath(tag.name);
    } catch {
      add("INVALID_TAG_NAME", `Invalid ${kind} tag name: ${tag.name}`, { kind, tag });
    }
  };
  const configurationGlobals = source.configuration?.globalVariables ?? [];
  const rootTags =
    configurationGlobals === source.tags
      ? configurationGlobals
      : [...configurationGlobals, ...(source.tags ?? [])];
  for (const tag of rootTags) declareTagName("global", tag);
  for (const resource of source.configuration?.resources ?? []) {
    for (const tag of resource.globalVariables ?? []) declareTagName("resource", tag);
  }
  for (const program of source.programs ?? []) {
    for (const variable of program.variables ?? []) declareTagName("program", variable);
  }
  for (const pou of source.pous ?? []) {
    for (const variable of [
      ...(pou.variables ?? []),
      ...(pou.interface.inputs ?? []),
      ...(pou.interface.outputs ?? []),
      ...(pou.interface.inouts ?? []),
      ...(pou.interface.externals ?? []),
      ...(pou.interface.temporaries ?? []),
    ]) {
      declareTagName("pou", variable);
    }
  }
  for (const accessPath of source.configuration?.accessPaths ?? []) {
    if (!accessPath.name)
      add("INVALID_ACCESS_PATH", "Access path is missing a name", { accessPath });
    if (!accessPath.path)
      add("INVALID_ACCESS_PATH", `Access path ${accessPath.name} is missing a path`, {
        accessPath,
      });
  }
  const aliases = (source.metadata?.aliases ?? []) as Array<{ name?: string; target?: string }>;
  for (const alias of aliases) {
    if (!alias.name || !alias.target)
      add("INVALID_ALIAS", "Alias declarations require name and target", { alias });
    else if (!context.tags.has(alias.target))
      add("UNKNOWN_ALIAS_TARGET", `Alias ${alias.name} references unknown tag ${alias.target}`, {
        alias,
      });
  }

  const validateInstruction = (instruction: InstructionNode): void => {
    const definition = context.getInstruction(instruction.opcode);
    if (
      !definition &&
      !context.structuralOpcodes.has(instruction.opcode) &&
      !context.callOpcodes.has(instruction.opcode)
    ) {
      add(
        "UNSUPPORTED_INSTRUCTION",
        `Unsupported instruction: ${instruction.opcode}`,
        { instruction },
        instruction.source,
      );
    }
    for (const diagnostic of definition?.validate?.(instruction.args, {
      source,
      tags: context.tags,
    }) ?? [])
      diagnostics.push(diagnostic);
    if (context.callOpcodes.has(instruction.opcode))
      validateCallInstruction(instruction, context, add);
    for (const child of instruction.children ?? []) validateInstruction(child);
  };

  for (const routine of routinesForSource(source)) {
    checkId("routine", routine);
    for (const network of routine.networks ?? []) {
      checkId("network", network);
      for (const instruction of network.instructions ?? []) validateInstruction(instruction);
      for (const rung of network.rungs ?? []) {
        checkId("rung", rung);
        validateRungInstructionOrder(rung.instructions, add, rung.source);
        for (const instruction of rung.instructions) validateInstruction(instruction);
      }
    }
    for (const rung of routine.rungs ?? []) {
      checkId("rung", rung);
      validateRungInstructionOrder(rung.instructions, add, rung.source);
      for (const instruction of rung.instructions) validateInstruction(instruction);
    }
  }

  return diagnostics;
}

const conditionOpcodes = new Set([
  "afi",
  "cmp",
  "xic",
  "xio",
  "ons",
  "r_trig",
  "f_trig",
  "equ",
  "eq",
  "neq",
  "ne",
  "gt",
  "grt",
  "ge",
  "geq",
  "lt",
  "les",
  "le",
  "leq",
  "lim",
  "limit",
  "meq",
]);

const structuralPathOpcodes = new Set(["branch", "parallel", "series"]);

function validateRungInstructionOrder(
  instructions: InstructionNode[],
  add: (
    code: string,
    message: string,
    metadata?: Record<string, unknown>,
    sourceLocation?: Diagnostic["source"],
    severity?: Diagnostic["severity"],
  ) => void,
  sourceLocation?: Diagnostic["source"],
): void {
  const validatePath = (path: InstructionNode[], pathName: string): InstructionNode | undefined => {
    if (path.length === 0) {
      add(
        "EMPTY_RUNG_PATH",
        `${pathName} has no instructions; empty ladder paths are ignored by the runtime`,
        { path: pathName },
        sourceLocation,
        "warning",
      );
      return undefined;
    }

    let terminal: InstructionNode | undefined;
    for (const [index, instruction] of path.entries()) {
      const isTerminal = index === path.length - 1;
      if (structuralPathOpcodes.has(instruction.opcode)) {
        validateStructural(
          instruction,
          `${pathName}/${instruction.id ?? instruction.opcode}`,
          isTerminal,
        );
      }
      terminal = instruction;
    }

    if (terminal && terminalOpcode(terminal) === "condition") {
      add(
        "CONDITION_TERMINAL",
        `Ladder path ${pathName} ends with condition instruction ${terminal.opcode}; add an action/output instruction after it`,
        { instruction: terminal, path: pathName },
        terminal.source ?? sourceLocation,
        "warning",
      );
    }
    return terminal;
  };

  const validateStructural = (
    instruction: InstructionNode,
    pathName: string,
    validateTerminals: boolean,
  ): void => {
    const children = instruction.children ?? [];
    if (children.length === 0) {
      add(
        "EMPTY_BRANCH",
        `${instruction.opcode} ${instruction.id ?? ""}`.trim() +
          " has no child paths; this is likely a shorted or malformed ladder branch",
        { instruction, path: pathName },
        instruction.source ?? sourceLocation,
        "warning",
      );
      return;
    }

    if (!validateTerminals) return;

    if (instruction.opcode === "series") {
      validatePath(children, pathName);
      return;
    }

    for (const [index, child] of children.entries()) {
      if (child.opcode === "series")
        validatePath(child.children ?? [], `${pathName}/lane-${index}`);
      else validatePath([child], `${pathName}/lane-${index}`);
    }
  };

  validatePath(instructions, "rung");
}

function terminalOpcode(instruction: InstructionNode): "condition" | "action" {
  const opcode = instruction.opcode.toLowerCase();
  if (conditionOpcodes.has(opcode)) return "condition";
  if (opcode === "series") {
    const children = instruction.children ?? [];
    return children.length > 0 && terminalOpcode(children[children.length - 1]!) === "condition"
      ? "condition"
      : "action";
  }
  if (opcode === "branch" || opcode === "parallel") return "action";
  return "action";
}

function validateDirectAddress(
  value: unknown,
  add: (
    code: string,
    message: string,
    metadata?: Record<string, unknown>,
    sourceLocation?: Diagnostic["source"],
  ) => void,
  metadata: Record<string, unknown>,
): void {
  try {
    const key = addressKey(value as Parameters<typeof addressKey>[0]);
    if (!/^%[IQM](?:[XBWDLM])?.+$/i.test(key))
      add("INVALID_DIRECT_ADDRESS", `Invalid direct address: ${key}`, metadata);
  } catch {
    add("INVALID_DIRECT_ADDRESS", "Invalid direct address declaration", metadata);
  }
}

function validateCallInstruction(
  instruction: InstructionNode,
  context: ProgramValidationContext,
  add: (
    code: string,
    message: string,
    metadata?: Record<string, unknown>,
    sourceLocation?: Diagnostic["source"],
  ) => void,
): void {
  const args = instruction.args as { definition?: string; parameters?: Record<string, string> };
  const definition = context.findPouOrAoi(args.definition);
  if (!definition) {
    add(
      "UNKNOWN_CALL_DEFINITION",
      `Call ${instruction.id} references unknown definition ${args.definition ?? ""}`.trim(),
      { instruction },
      instruction.source,
    );
    return;
  }
  const parameters = args.parameters ?? {};
  if ("parameters" in definition) {
    for (const parameter of definition.parameters) {
      const bound = parameters[parameter.name];
      if (parameter.required && !bound && parameter.defaultValue === undefined) {
        add(
          "MISSING_REQUIRED_PARAMETER",
          `Call ${instruction.id} is missing required parameter ${parameter.name}`,
          { instruction, parameter },
          instruction.source,
        );
      }
      if (bound && !context.tags.has(bound)) {
        add(
          "UNKNOWN_PARAMETER_TAG",
          `Call ${instruction.id} parameter ${parameter.name} references unknown tag ${bound}`,
          { instruction, parameter },
          instruction.source,
        );
      }
    }
    return;
  }
  for (const variable of [
    ...(definition.interface.inputs ?? []),
    ...(definition.interface.outputs ?? []),
    ...(definition.interface.inouts ?? []),
  ]) {
    const bound = parameters[variable.name];
    if (bound && !context.tags.has(bound)) {
      add(
        "UNKNOWN_PARAMETER_TAG",
        `Call ${instruction.id} parameter ${variable.name} references unknown tag ${bound}`,
        { instruction, variable },
        instruction.source,
      );
    }
  }
}

function routinesForSource(source: ProgramSource): PlcRoutine[] {
  return [
    ...(source.programs ?? []).flatMap((program) => program.routines ?? []),
    ...(source.pous ?? []).flatMap((pou) => [
      ...(pou.body.routines ?? []),
      ...(pou.body.networks
        ? [
            {
              id: `${pou.id}:body`,
              name: pou.name,
              language: pou.body.language,
              networks: pou.body.networks,
            } satisfies PlcRoutine,
          ]
        : []),
    ]),
    ...(source.aois ?? []).flatMap((aoi) => aoi.routines),
  ];
}
