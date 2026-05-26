import { asBool, asNumber, clone, typeForPath } from "../internal";
import { id } from "../internal";
import type {
  Diagnostic,
  ElementaryType,
  InstructionContext,
  InstructionDefinition,
  InstructionResult,
  PlcPlugin,
  ValidateContext,
} from "../types";

type TagArg =
  | string
  | {
      tag?: string;
      path?: string;
      dest?: string;
      target?: string;
      source?: string;
      value?: unknown;
      [key: string]: unknown;
    };

function tag(args: TagArg, fallback = "tag"): string {
  if (typeof args === "string") return args;
  const value =
    args[fallback] ??
    args.tag ??
    args.path ??
    args.dest ??
    args.target ??
    args.timer ??
    args.counter;
  if (typeof value !== "string") throw new Error("Instruction requires a tag path");
  return value;
}

function operand(context: InstructionContext, value: unknown): unknown {
  if (typeof value === "string" && context.tags.has(value)) return context.tags.get(value);
  return value;
}

function write(context: InstructionContext, path: string, value: unknown): void {
  context.tags.set(path, coerceForDestination(context, path, value));
}

function raiseMinorFault(context: InstructionContext, code: string, message: string): void {
  context.engine.faults.raise({
    id: id("fault"),
    severity: "minor",
    code,
    message,
    source: context.instruction.source,
    scanNumber: context.scanNumber,
    recoverable: true,
    metadata: { instruction: context.instruction },
  });
}

function coerceForDestination(context: InstructionContext, path: string, value: unknown): unknown {
  const type = typeForDestination(context, path);
  if (!type || typeof type !== "string") return value;
  return coerceLogixValue(value, type as ElementaryType);
}

function typeForDestination(context: InstructionContext, path: string): unknown {
  try {
    const resolved = context.tags.resolve(path);
    const udts = new Map(context.tags.snapshot().udts.map((udt) => [udt.name, udt]));
    return typeForPath(resolved.declaration, path, udts);
  } catch {
    return undefined;
  }
}

const numericTypeRanges: Partial<
  Record<ElementaryType, { min: number; max: number; integer: boolean }>
> = {
  SINT: { min: -128, max: 127, integer: true },
  USINT: { min: 0, max: 255, integer: true },
  INT: { min: -32768, max: 32767, integer: true },
  UINT: { min: 0, max: 65535, integer: true },
  DINT: { min: -2147483648, max: 2147483647, integer: true },
  UDINT: { min: 0, max: 4294967295, integer: true },
  REAL: { min: -3.4028234663852886e38, max: 3.4028234663852886e38, integer: false },
};

function coerceLogixValue(value: unknown, type: ElementaryType): unknown {
  if (type === "BOOL") {
    if (value === undefined || value === null) return false;
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
    throw new Error("Type mismatch: expected BOOL");
  }
  if (type === "STRING" || type === "WSTRING") return logixStringValue(value);
  const range = numericTypeRanges[type];
  if (!range) return value;
  if (value === undefined || value === null) return 0;
  const numeric = typeof value === "boolean" ? NaN : Number(value);
  if (!Number.isFinite(numeric)) return typeof value === "number" ? value : 0;
  const converted = range.integer ? bankersRound(numeric) : numeric;
  if (converted < range.min || converted > range.max)
    throw new Error(`Numeric overflow converting to ${type}`);
  return converted;
}

function bankersRound(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function logixStringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (typeof record.value === "string") return record.value;
    const len = typeof record.LEN === "number" ? record.LEN : undefined;
    if (Array.isArray(record.DATA))
      return record.DATA.slice(0, len)
        .map((entry) => String.fromCharCode(Number(entry) || 0))
        .join("");
  }
  return String(value ?? "");
}

function destination(args: Record<string, unknown>): string {
  const value = args.dest ?? args.destination ?? args.out;
  if (typeof value !== "string") throw new Error("Instruction requires a destination tag");
  return value;
}

function sourceValue(context: InstructionContext, args: Record<string, unknown>): unknown {
  return operand(context, args.source ?? args.src ?? args.value);
}

function lengthValue(context: InstructionContext, args: Record<string, unknown>): number {
  const raw = operand(context, args.length ?? args.len ?? args.count ?? 1);
  const length = Math.trunc(asNumber(raw));
  if (length < 0) throw new Error("Instruction length must be non-negative");
  return length;
}

function indexedPath(path: string, index: number): string {
  const match = /^(.*)\[(-?\d+)\]$/.exec(path);
  if (match?.[1] && match[2] !== undefined) return `${match[1]}[${Number(match[2]) + index}]`;
  return index === 0 ? path : `${path}[${index}]`;
}

function fileElementPath(path: string, index: number): string {
  const match = /^(.*)\[(-?\d+)\]$/.exec(path);
  if (match?.[1] && match[2] !== undefined) return `${match[1]}[${Number(match[2]) + index}]`;
  return `${path}[${index}]`;
}

function copyFile(args: Record<string, unknown>, context: InstructionContext): InstructionResult {
  if (!context.power) return { power: false };
  const source = args.source ?? args.src;
  const dest = destination(args);
  const length = lengthValue(context, args);
  if (typeof source !== "string") {
    write(context, dest, clone(source));
    return { power: context.power, value: source };
  }
  const sourceRoot = context.tags.get(source);
  if (length <= 1 || !Array.isArray(sourceRoot)) {
    const value = context.tags.get(source);
    write(context, dest, value);
    return { power: context.power, value };
  }
  for (let index = 0; index < length; index += 1) {
    write(context, fileElementPath(dest, index), context.tags.get(fileElementPath(source, index)));
  }
  return { power: context.power };
}

function fillFile(args: Record<string, unknown>, context: InstructionContext): InstructionResult {
  if (!context.power) return { power: false };
  const dest = destination(args);
  const length = lengthValue(context, args);
  const value = sourceValue(context, args);
  if (length <= 1) {
    const current = context.tags.has(dest) ? context.tags.get(dest) : undefined;
    write(context, dest, fillValue(current, value));
    return { power: context.power, value };
  }
  for (let index = 0; index < length; index += 1)
    write(context, fileElementPath(dest, index), value);
  return { power: context.power, value };
}

function fillValue(current: unknown, value: unknown): unknown {
  if (Array.isArray(current)) return current.map((entry) => fillValue(entry, value));
  if (current && typeof current === "object")
    return Object.fromEntries(
      Object.entries(current).map(([key, entry]) => [key, fillValue(entry, value)]),
    );
  if (typeof current === "boolean") {
    if (typeof value === "boolean") return value;
    if (typeof value === "number") return value !== 0;
  }
  return value;
}

type Token =
  | { kind: "number"; value: number }
  | { kind: "identifier"; value: string }
  | { kind: "operator"; value: string }
  | { kind: "paren"; value: "(" | ")" };

function evaluateExpression(expression: unknown, context: InstructionContext): number {
  if (typeof expression === "number") return expression;
  if (typeof expression !== "string") return asNumber(operand(context, expression));
  const tokens = tokenizeExpression(expression);
  let position = 0;

  const peek = () => tokens[position];
  const consume = () => tokens[position++];
  const parsePrimary = (): number => {
    const token = consume();
    if (!token) throw new Error("Unexpected end of expression");
    if (token.kind === "number") return token.value;
    if (token.kind === "identifier") return asNumber(operand(context, token.value));
    if (token.kind === "operator" && token.value === "-") return -parsePrimary();
    if (token.kind === "paren" && token.value === "(") {
      const value = parseAddSub();
      const close = consume();
      if (close?.kind !== "paren" || close.value !== ")") throw new Error("Unclosed expression");
      return value;
    }
    throw new Error("Unexpected expression token");
  };
  const operatorIs = (values: string[]): boolean => {
    const token = peek();
    return token?.kind === "operator" && values.includes(token.value);
  };
  const parsePower = (): number => {
    let value = parsePrimary();
    while (operatorIs(["**"])) {
      consume();
      value = value ** parsePrimary();
    }
    return value;
  };
  const parseMulDiv = (): number => {
    let value = parsePower();
    while (operatorIs(["*", "/", "%"])) {
      const operator = consume() as { kind: "operator"; value: string };
      const right = parsePower();
      if (operator.value === "*") value *= right;
      else if (operator.value === "/") value /= right;
      else value %= right;
    }
    return value;
  };
  const parseAddSub = (): number => {
    let value = parseMulDiv();
    while (operatorIs(["+", "-"])) {
      const operator = consume() as { kind: "operator"; value: string };
      const right = parseMulDiv();
      value = operator.value === "+" ? value + right : value - right;
    }
    return value;
  };
  const result = parseAddSub();
  if (position !== tokens.length) throw new Error("Unexpected expression input");
  if (!Number.isFinite(result)) throw new Error("Math overflow");
  return result;
}

function tokenizeExpression(expression: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  while (index < expression.length) {
    const char = expression[index];
    if (!char) break;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    const number = /^\d+(?:\.\d+)?/.exec(expression.slice(index));
    if (number?.[0]) {
      tokens.push({ kind: "number", value: Number(number[0]) });
      index += number[0].length;
      continue;
    }
    const identifier = readIdentifier(expression, index);
    if (identifier) {
      const value = identifier.value;
      tokens.push({ kind: "identifier", value });
      index = identifier.end;
      continue;
    }
    const two = expression.slice(index, index + 2);
    if (two === "**") {
      tokens.push({ kind: "operator", value: two });
      index += 2;
      continue;
    }
    if ("+-*/%".includes(char)) tokens.push({ kind: "operator", value: char });
    else if (char === "(" || char === ")") tokens.push({ kind: "paren", value: char });
    else throw new Error(`Invalid expression token: ${char}`);
    index += 1;
  }
  return tokens;
}

function readIdentifier(
  expression: string,
  start: number,
): { value: string; end: number } | undefined {
  const first = expression[start];
  if (!first || !/[A-Za-z_]/.test(first)) return undefined;
  let index = start + 1;
  let bracketDepth = 0;
  while (index < expression.length) {
    const char = expression[index];
    if (!char) break;
    if (char === "[") bracketDepth += 1;
    if (char === "]") bracketDepth -= 1;
    if (bracketDepth <= 0 && /[+\-*/%()]/.test(char)) break;
    if (bracketDepth <= 0 && /\s/.test(char)) break;
    if (!/[A-Za-z0-9_.\[\],+\-\s]/.test(char)) break;
    index += 1;
  }
  return { value: expression.slice(start, index), end: index };
}

function systemValue(args: Record<string, unknown>, context: InstructionContext): unknown {
  const className = String(args.class ?? args.className ?? args.object ?? "").toLowerCase();
  const attribute = String(args.attribute ?? args.attributeName ?? args.attr ?? "").toLowerCase();
  if (className === "program") {
    if (attribute === "lastscantime") return 0;
    if (attribute === "name") return findLastStackFrame(context.stack, "program")?.name ?? "";
  }
  if (className === "task") {
    const taskFrame = findLastStackFrame(context.stack, "task");
    const taskName =
      typeof (args.instance ?? args.instanceName ?? args.objectName ?? args.name) === "string"
        ? String(args.instance ?? args.instanceName ?? args.objectName ?? args.name)
        : undefined;
    const task = context.engine
      .inspect()
      .scheduler.find(
        (entry) =>
          (taskName && (entry.task.id === taskName || entry.task.name === taskName)) ||
          (!taskName && taskFrame && entry.task.id === taskFrame.id),
      )?.task;
    if (attribute === "name") return task?.name ?? taskFrame?.name ?? "";
    if (attribute === "id" || attribute === "instance") return task?.id ?? taskFrame?.id ?? "";
    if (attribute === "rate") return task?.kind === "periodic" ? (task.periodMs ?? 0) : 0;
    if (attribute === "priority") return task?.priority ?? 0;
    if (attribute === "watchdog") return task?.watchdogMs ?? 0;
  }
  if (className === "controller" || className === "wallclocktime") {
    if (attribute === "datetime" || attribute === "currentvalue") return context.clock.now();
    if (attribute === "mode") return context.engine.controller.mode;
    if (attribute === "scannumber") return context.scanNumber;
  }
  if (className === "faultlog" || className === "fault") {
    if (attribute === "count") return context.engine.faults.list().length;
    if (attribute === "minorfaultbits" || attribute === "majorfaultbits")
      return context.engine.faults.list().length > 0 ? 1 : 0;
  }
  if (className === "module") {
    const instance = args.instance ?? args.instanceName ?? args.objectName ?? args.name;
    const moduleValue =
      typeof instance === "string" && context.tags.has(instance)
        ? context.tags.get(instance)
        : undefined;
    if (attribute === "faultcode") return moduleFaulted(moduleValue) ? 1 : 0;
    if (attribute === "entryfault") return moduleFaulted(moduleValue) ? 1 : 0;
    if (attribute === "mode") return 0;
  }
  throw new Error(
    `Unsupported GSV attribute: ${String(args.class ?? args.className)}.${String(
      args.attribute ?? args.attributeName,
    )}`,
  );
}

function moduleFaulted(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") return value.toLowerCase() === "true" || value !== "0";
  if (value && typeof value === "object" && "MajorFault" in value)
    return moduleFaulted((value as { MajorFault?: unknown }).MajorFault);
  if (value && typeof value === "object" && "FaultCode" in value)
    return moduleFaulted((value as { FaultCode?: unknown }).FaultCode);
  return false;
}

function findLastStackFrame(
  stack: InstructionContext["stack"],
  kind: InstructionContext["stack"][number]["kind"],
): InstructionContext["stack"][number] | undefined {
  for (let index = stack.length - 1; index >= 0; index -= 1) {
    const frame = stack[index];
    if (frame?.kind === kind) return frame;
  }
  return undefined;
}

function diagnostic(code: string, message: string): Diagnostic {
  return { id: id("diagnostic"), severity: "error", code, message };
}

function validateTagArg(args: TagArg, context: ValidateContext, fallback = "tag"): Diagnostic[] {
  try {
    const path = tag(args, fallback);
    return context.tags.has(path)
      ? []
      : [diagnostic("UNKNOWN_TAG", `Instruction references unknown tag ${path}`)];
  } catch (error) {
    return [
      diagnostic("INVALID_ARGUMENTS", error instanceof Error ? error.message : String(error)),
    ];
  }
}

function validateDestination(
  args: Record<string, unknown>,
  context: ValidateContext,
): Diagnostic[] {
  const destination = args.dest ?? args.out;
  if (typeof destination !== "string")
    return [diagnostic("INVALID_ARGUMENTS", "Instruction requires dest/out tag")];
  return context.tags.has(destination)
    ? []
    : [diagnostic("UNKNOWN_TAG", `Instruction references unknown destination tag ${destination}`)];
}

function validateBinaryArgs(args: Record<string, unknown>, context: ValidateContext): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (args.a === undefined && args.sourceA === undefined && args.in1 === undefined)
    diagnostics.push(diagnostic("INVALID_ARGUMENTS", "Instruction requires a/sourceA/in1"));
  if (args.b === undefined && args.sourceB === undefined && args.in2 === undefined)
    diagnostics.push(diagnostic("INVALID_ARGUMENTS", "Instruction requires b/sourceB/in2"));
  diagnostics.push(...validateDestination(args, context));
  return diagnostics;
}

function binaryNumber(
  opcode: string,
  operation: (a: number, b: number) => number,
): InstructionDefinition<Record<string, unknown>> {
  return {
    opcode,
    validate(args, context) {
      return validateBinaryArgs(args, context);
    },
    execute(args, context) {
      if (!context.power) return { power: false };
      const result = operation(
        asNumber(operand(context, args.a ?? args.sourceA ?? args.in1)),
        asNumber(operand(context, args.b ?? args.sourceB ?? args.in2)),
      );
      if (!Number.isFinite(result)) throw new Error("Math overflow");
      const destination = args.dest ?? args.out;
      if (typeof destination === "string") write(context, destination, result);
      return { power: context.power, value: result };
    },
  };
}

function comparison(
  opcode: string,
  compare: (a: number, b: number) => boolean,
): InstructionDefinition<Record<string, unknown>> {
  return {
    opcode,
    validate(args) {
      const diagnostics: Diagnostic[] = [];
      if (args.a === undefined && args.sourceA === undefined)
        diagnostics.push(diagnostic("INVALID_ARGUMENTS", "Comparison requires a/sourceA"));
      if (args.b === undefined && args.sourceB === undefined)
        diagnostics.push(diagnostic("INVALID_ARGUMENTS", "Comparison requires b/sourceB"));
      return diagnostics;
    },
    execute(args, context) {
      return {
        power:
          context.power &&
          compare(
            asNumber(operand(context, args.a ?? args.sourceA)),
            asNumber(operand(context, args.b ?? args.sourceB)),
          ),
      };
    },
  };
}

function edge(
  opcode: string,
  detect: (previous: boolean, current: boolean) => boolean,
): InstructionDefinition<TagArg> {
  return {
    opcode,
    validate(args, context) {
      return validateTagArg(args, context);
    },
    execute(args, context) {
      const path = tag(args);
      const current = asBool(context.tags.get(path));
      const previous = context.memory.get<boolean>("previous") ?? false;
      context.memory.set("previous", current);
      return { power: context.power && detect(previous, current) };
    },
  };
}

export function createCoreInstructionPlugin(): PlcPlugin {
  const instructions: InstructionDefinition[] = [
    {
      opcode: "xic",
      validate: validateTagArg,
      execute(args: TagArg, context) {
        return { power: context.power && asBool(context.tags.get(tag(args))) };
      },
    },
    {
      opcode: "xio",
      validate: validateTagArg,
      execute(args: TagArg, context) {
        return { power: context.power && !asBool(context.tags.get(tag(args))) };
      },
    },
    {
      opcode: "afi",
      execute() {
        return { power: false };
      },
    },
    {
      opcode: "ote",
      validate: validateTagArg,
      execute(args: TagArg, context) {
        write(context, tag(args), context.power);
        return { power: context.power };
      },
      prescan(args: TagArg, context) {
        write(context, tag(args), false);
      },
    },
    {
      opcode: "otl",
      validate: validateTagArg,
      execute(args: TagArg, context) {
        if (context.power) write(context, tag(args), true);
        return { power: context.power };
      },
    },
    {
      opcode: "otu",
      validate: validateTagArg,
      execute(args: TagArg, context) {
        if (context.power) write(context, tag(args), false);
        return { power: context.power };
      },
    },
    {
      opcode: "ons",
      validate(args: TagArg, context) {
        return validateTagArg(
          args,
          context,
          typeof args === "object" && args.storage ? "storage" : "tag",
        );
      },
      execute(args: TagArg, context) {
        if (typeof args === "object" && args.storage === undefined && args.tag !== undefined) {
          const current = asBool(context.tags.get(tag(args)));
          const previous = context.memory.get<boolean>("previous") ?? false;
          context.memory.set("previous", current);
          return { power: context.power && !previous && current };
        }
        const storage = tag(args, "storage");
        const previous = asBool(context.tags.get(storage));
        write(context, storage, context.power);
        return { power: context.power && !previous };
      },
      prescan(args: TagArg, context) {
        write(context, tag(args, "storage"), true);
      },
    },
    edge("r_trig", (previous, current) => !previous && current),
    edge("f_trig", (previous, current) => previous && !current),
    {
      opcode: "osf",
      validate(args: Record<string, unknown>, context) {
        const diagnostics: Diagnostic[] = [];
        const storage = args.storage ?? args.storageBit ?? args.tag;
        const output = args.output ?? args.outputBit ?? args.out;
        if (typeof storage !== "string")
          diagnostics.push(diagnostic("INVALID_ARGUMENTS", "OSF requires storage bit"));
        else if (!context.tags.has(storage))
          diagnostics.push(
            diagnostic("UNKNOWN_TAG", `OSF storage references unknown tag ${storage}`),
          );
        if (output !== undefined && typeof output !== "string")
          diagnostics.push(diagnostic("INVALID_ARGUMENTS", "OSF output bit must be a tag"));
        else if (typeof output === "string" && !context.tags.has(output))
          diagnostics.push(
            diagnostic("UNKNOWN_TAG", `OSF output references unknown tag ${output}`),
          );
        return diagnostics;
      },
      execute(args: Record<string, unknown>, context) {
        const storage = String(args.storage ?? args.storageBit ?? args.tag);
        const output = args.output ?? args.outputBit ?? args.out;
        const previous = asBool(context.tags.get(storage));
        const pulse = previous && !context.power;
        write(context, storage, context.power);
        if (typeof output === "string") {
          write(context, output, pulse);
          return { power: context.power };
        }
        return { power: pulse };
      },
      prescan(args: Record<string, unknown>, context) {
        const storage = args.storage ?? args.storageBit ?? args.tag;
        if (typeof storage === "string") write(context, storage, false);
        const output = args.output ?? args.outputBit ?? args.out;
        if (typeof output === "string") write(context, output, false);
      },
    },
    {
      opcode: "ton",
      validate(args: Record<string, unknown>, context) {
        return validateTagArg(args as TagArg, context, "timer");
      },
      execute(args: Record<string, unknown>, context) {
        const path = tag(args as TagArg, "timer");
        const timer = {
          PRE: 0,
          ACC: 0,
          EN: false,
          TT: false,
          DN: false,
          ...(context.tags.get<Record<string, unknown>>(path) ?? {}),
        };
        const now = context.clock.now();
        const last = context.memory.get<number>("last") ?? now;
        const previousPower = context.memory.get<boolean>("previousPower") ?? false;
        const pre = asNumber(args.pre ?? args.PRE ?? timer.PRE);
        if (pre < 0 || asNumber(timer.ACC) < 0)
          throw new Error("Timer PRE and ACC must be non-negative");
        const acc =
          !context.power || !previousPower
            ? 0
            : Math.min(pre, asNumber(timer.ACC) + Math.max(0, now - last));
        const done = context.power && acc >= pre;
        context.memory.set("last", now);
        context.memory.set("previousPower", context.power);
        write(context, path, {
          ...timer,
          PRE: pre,
          ACC: acc,
          EN: context.power,
          TT: context.power && !done,
          DN: done,
        });
        return { power: context.power, done };
      },
      reset(args: Record<string, unknown>, context) {
        const path = tag(args as TagArg, "timer");
        write(context, path, {
          PRE: asNumber(args.pre ?? args.PRE),
          ACC: 0,
          EN: false,
          TT: false,
          DN: false,
        });
      },
    },
    {
      opcode: "tof",
      validate(args: Record<string, unknown>, context) {
        return validateTagArg(args as TagArg, context, "timer");
      },
      execute(args: Record<string, unknown>, context) {
        const path = tag(args as TagArg, "timer");
        const timer = {
          PRE: 0,
          ACC: 0,
          EN: false,
          TT: false,
          DN: false,
          ...(context.tags.get<Record<string, unknown>>(path) ?? {}),
        };
        const now = context.clock.now();
        const last = context.memory.get<number>("last") ?? now;
        const previousPower = context.memory.get<boolean>("previousPower") ?? false;
        const pre = asNumber(args.pre ?? args.PRE ?? timer.PRE);
        if (pre < 0 || asNumber(timer.ACC) < 0)
          throw new Error("Timer PRE and ACC must be non-negative");
        const timing = !context.power && (previousPower || asBool(timer.TT) || asBool(timer.DN));
        const acc =
          context.power || !timing
            ? 0
            : previousPower
              ? 0
              : Math.min(pre, asNumber(timer.ACC) + Math.max(0, now - last));
        const done = context.power || (timing && acc < pre);
        context.memory.set("last", now);
        context.memory.set("previousPower", context.power);
        write(context, path, {
          ...timer,
          PRE: pre,
          ACC: acc,
          EN: context.power,
          TT: !context.power && done,
          DN: done,
        });
        return { power: context.power, done };
      },
      reset(args: Record<string, unknown>, context) {
        const path = tag(args as TagArg, "timer");
        write(context, path, {
          PRE: asNumber(args.pre ?? args.PRE),
          ACC: 0,
          EN: false,
          TT: false,
          DN: false,
        });
      },
    },
    {
      opcode: "tp",
      validate(args: Record<string, unknown>, context) {
        return validateTagArg(args as TagArg, context, "timer");
      },
      execute(args: Record<string, unknown>, context) {
        const path = tag(args as TagArg, "timer");
        const timer = {
          PRE: 0,
          ACC: 0,
          EN: false,
          TT: false,
          DN: false,
          ...(context.tags.get<Record<string, unknown>>(path) ?? {}),
        };
        const now = context.clock.now();
        const previousPower = context.memory.get<boolean>("previousPower") ?? false;
        let start = context.memory.get<number>("start");
        if (context.power && !previousPower) start = now;
        const pre = asNumber(args.pre ?? args.PRE ?? timer.PRE);
        if (pre < 0 || asNumber(timer.ACC) < 0)
          throw new Error("Timer PRE and ACC must be non-negative");
        const acc = start === undefined ? 0 : Math.min(pre, Math.max(0, now - start));
        const pulse = start !== undefined && acc < pre;
        context.memory.set("previousPower", context.power);
        context.memory.set("start", pulse ? start : undefined);
        write(context, path, {
          ...timer,
          PRE: pre,
          ACC: acc,
          EN: pulse,
          TT: pulse,
          DN: !pulse && acc >= pre,
        });
        return { power: context.power && pulse };
      },
      reset(args: Record<string, unknown>, context) {
        const path = tag(args as TagArg, "timer");
        write(context, path, {
          PRE: asNumber(args.pre ?? args.PRE),
          ACC: 0,
          EN: false,
          TT: false,
          DN: false,
        });
      },
    },
    {
      opcode: "ctu",
      validate(args: Record<string, unknown>, context) {
        return validateTagArg(args as TagArg, context, "counter");
      },
      execute(args: Record<string, unknown>, context) {
        const path = tag(args as TagArg, "counter");
        const counter = {
          PRE: 0,
          ACC: 0,
          CU: false,
          CD: false,
          DN: false,
          ...(context.tags.get<Record<string, unknown>>(path) ?? {}),
        };
        const previous = context.memory.get<boolean>("previous") ?? false;
        const acc = context.power && !previous ? asNumber(counter.ACC) + 1 : asNumber(counter.ACC);
        context.memory.set("previous", context.power);
        write(context, path, {
          ...counter,
          ACC: acc,
          PRE: asNumber(args.pre ?? counter.PRE),
          CU: context.power,
          DN: acc >= asNumber(args.pre ?? counter.PRE),
        });
        return { power: context.power };
      },
      prescan(args: Record<string, unknown>, context) {
        const path = tag(args as TagArg, "counter");
        context.memory.set("previous", true);
        const counter = context.tags.get<Record<string, unknown>>(path) ?? {};
        write(context, path, { ...counter, CU: true });
      },
      reset(args: Record<string, unknown>, context) {
        const path = tag(args as TagArg, "counter");
        write(context, path, {
          PRE: asNumber(args.pre),
          ACC: 0,
          CU: false,
          CD: false,
          DN: false,
          OV: false,
          UN: false,
        });
      },
    },
    {
      opcode: "ctd",
      validate(args: Record<string, unknown>, context) {
        return validateTagArg(args as TagArg, context, "counter");
      },
      execute(args: Record<string, unknown>, context) {
        const path = tag(args as TagArg, "counter");
        const counter = {
          PRE: 0,
          ACC: 0,
          CU: false,
          CD: false,
          DN: false,
          ...(context.tags.get<Record<string, unknown>>(path) ?? {}),
        };
        const previous = context.memory.get<boolean>("previous") ?? false;
        const acc = context.power && !previous ? asNumber(counter.ACC) - 1 : asNumber(counter.ACC);
        context.memory.set("previous", context.power);
        write(context, path, {
          ...counter,
          ACC: acc,
          CD: context.power,
          DN: acc >= asNumber(args.pre ?? counter.PRE),
          UN: acc < 0,
        });
        return { power: context.power };
      },
      prescan(args: Record<string, unknown>, context) {
        const path = tag(args as TagArg, "counter");
        context.memory.set("previous", true);
        const counter = context.tags.get<Record<string, unknown>>(path) ?? {};
        write(context, path, { ...counter, CD: true });
      },
      reset(args: Record<string, unknown>, context) {
        const path = tag(args as TagArg, "counter");
        write(context, path, {
          PRE: asNumber(args.pre),
          ACC: 0,
          CU: false,
          CD: false,
          DN: false,
          OV: false,
          UN: false,
        });
      },
    },
    {
      opcode: "ctud",
      validate(args: Record<string, unknown>, context) {
        return validateTagArg(args as TagArg, context, "counter");
      },
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const path = tag(args as TagArg, "counter");
        const up = asBool(operand(context, args.up ?? args.cu));
        const down = asBool(operand(context, args.down ?? args.cd));
        const counter = {
          PRE: 0,
          ACC: 0,
          ...(context.tags.get<Record<string, unknown>>(path) ?? {}),
        };
        const previousUp = context.memory.get<boolean>("up") ?? false;
        const previousDown = context.memory.get<boolean>("down") ?? false;
        let acc = asNumber(counter.ACC);
        if (up && !previousUp) acc += 1;
        if (down && !previousDown) acc -= 1;
        context.memory.set("up", up);
        context.memory.set("down", down);
        write(context, path, {
          ...counter,
          ACC: acc,
          CU: up,
          CD: down,
          DN: acc >= asNumber(args.pre ?? counter.PRE),
          UN: acc < 0,
        });
        return { power: context.power };
      },
      reset(args: Record<string, unknown>, context) {
        const path = tag(args as TagArg, "counter");
        write(context, path, {
          PRE: asNumber(args.pre),
          ACC: 0,
          CU: false,
          CD: false,
          DN: false,
          OV: false,
          UN: false,
        });
      },
    },
    {
      opcode: "res",
      validate: validateTagArg,
      execute(args: TagArg, context) {
        if (!context.power) return { power: false };
        const path = tag(args);
        const value = context.tags.get<Record<string, unknown>>(path);
        write(context, path, {
          ...value,
          ACC: 0,
          EN: false,
          TT: false,
          DN: false,
          CU: false,
          CD: false,
        });
        return { power: true };
      },
    },
    {
      opcode: "sr",
      validate(args: Record<string, unknown>, context) {
        return typeof args.dest === "string" && context.tags.has(args.dest)
          ? []
          : [diagnostic("INVALID_ARGUMENTS", "SR requires known dest tag")];
      },
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const set = asBool(operand(context, args.set ?? args.S));
        const reset = asBool(operand(context, args.reset ?? args.R));
        const current =
          args.current ??
          (typeof args.dest === "string" && context.tags.has(args.dest) ? args.dest : undefined);
        const value = set || (!reset && asBool(operand(context, current)));
        if (typeof args.dest === "string") write(context, args.dest, value);
        return { power: context.power && value };
      },
    },
    {
      opcode: "rs",
      validate(args: Record<string, unknown>, context) {
        return typeof args.dest === "string" && context.tags.has(args.dest)
          ? []
          : [diagnostic("INVALID_ARGUMENTS", "RS requires known dest tag")];
      },
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const set = asBool(operand(context, args.set ?? args.S));
        const reset = asBool(operand(context, args.reset ?? args.R));
        const current =
          args.current ??
          (typeof args.dest === "string" && context.tags.has(args.dest) ? args.dest : undefined);
        const value = !reset && (set || asBool(operand(context, current)));
        if (typeof args.dest === "string") write(context, args.dest, value);
        return { power: context.power && value };
      },
    },
    comparison("equ", (a, b) => a === b),
    comparison("neq", (a, b) => a !== b),
    comparison("gt", (a, b) => a > b),
    comparison("ge", (a, b) => a >= b),
    comparison("lt", (a, b) => a < b),
    comparison("le", (a, b) => a <= b),
    binaryNumber("add", (a, b) => a + b),
    binaryNumber("sub", (a, b) => a - b),
    binaryNumber("mul", (a, b) => a * b),
    {
      opcode: "div",
      validate(args: Record<string, unknown>, context) {
        return validateBinaryArgs(args, context);
      },
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const divisor = asNumber(operand(context, args.b ?? args.sourceB ?? args.in2));
        const dividend = asNumber(operand(context, args.a ?? args.sourceA ?? args.in1));
        if (divisor === 0) {
          raiseMinorFault(context, "MATH_DIVIDE_BY_ZERO", "DIV SourceB is zero");
          if (typeof (args.dest ?? args.out) === "string")
            write(context, (args.dest ?? args.out) as string, dividend);
          return { power: context.power, value: dividend };
        }
        const result = dividend / divisor;
        if (!Number.isFinite(result)) throw new Error("Math overflow");
        if (typeof (args.dest ?? args.out) === "string")
          write(context, (args.dest ?? args.out) as string, result);
        return { power: context.power, value: result };
      },
    },
    {
      opcode: "mod",
      validate(args: Record<string, unknown>, context) {
        return validateBinaryArgs(args, context);
      },
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const divisor = asNumber(operand(context, args.b ?? args.sourceB ?? args.in2));
        if (divisor === 0) throw new Error("Divide by zero");
        const result = asNumber(operand(context, args.a ?? args.sourceA ?? args.in1)) % divisor;
        if (typeof (args.dest ?? args.out) === "string")
          write(context, (args.dest ?? args.out) as string, result);
        return { power: context.power, value: result };
      },
    },
    {
      opcode: "mov",
      validate(args: Record<string, unknown>, context) {
        return validateDestination(args, context);
      },
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const value = operand(context, args.source ?? args.src ?? args.value);
        if (typeof (args.dest ?? args.out) === "string")
          write(context, (args.dest ?? args.out) as string, value);
        return { power: context.power, value };
      },
    },
    {
      opcode: "cop",
      validate(args: Record<string, unknown>, context) {
        return validateDestination(args, context);
      },
      execute: copyFile,
    },
    {
      opcode: "cps",
      validate(args: Record<string, unknown>, context) {
        return validateDestination(args, context);
      },
      execute: copyFile,
    },
    {
      opcode: "fll",
      validate(args: Record<string, unknown>, context) {
        return validateDestination(args, context);
      },
      execute: fillFile,
    },
    {
      opcode: "cos",
      validate(args: Record<string, unknown>, context) {
        return validateDestination(args, context);
      },
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const value = Math.cos(asNumber(sourceValue(context, args)));
        if (!Number.isFinite(value)) throw new Error("Math overflow");
        write(context, destination(args), value);
        return { power: context.power, value };
      },
    },
    {
      opcode: "cpt",
      validate(args: Record<string, unknown>, context) {
        return validateDestination(args, context);
      },
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const value = evaluateExpression(args.expression ?? args.expr ?? args.source, context);
        write(context, destination(args), value);
        return { power: context.power, value };
      },
    },
    {
      opcode: "btd",
      validate(args: Record<string, unknown>, context) {
        const dest = args.dest ?? args.destination;
        return typeof dest === "string" && context.tags.has(dest)
          ? []
          : [diagnostic("INVALID_ARGUMENTS", "BTD requires known destination tag")];
      },
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const source = asNumber(operand(context, args.source));
        const dest = destination(args);
        const current = asNumber(context.tags.get(dest));
        const sourceBit = Math.trunc(
          asNumber(operand(context, args.sourceBit ?? args.source_bit ?? 0)),
        );
        const destBit = Math.trunc(asNumber(operand(context, args.destBit ?? args.dest_bit ?? 0)));
        const length = Math.max(0, Math.trunc(asNumber(operand(context, args.length ?? 1))));
        const widthMask = length >= 32 ? 0xffffffff : (1 << length) - 1;
        const field = ((source >>> sourceBit) & widthMask) << destBit;
        const clearMask = ~(widthMask << destBit);
        const value = (current & clearMask) | field;
        write(context, dest, value);
        return { power: context.power, value };
      },
    },
    {
      opcode: "concat",
      validate(args: Record<string, unknown>, context) {
        return typeof (args.dest ?? args.destination ?? args.out) === "string" &&
          context.tags.has((args.dest ?? args.destination ?? args.out) as string)
          ? []
          : [diagnostic("INVALID_ARGUMENTS", "CONCAT requires known destination string tag")];
      },
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const value =
          logixStringValue(operand(context, args.sourceA ?? args.a ?? args.in1 ?? args.arg1)) +
          logixStringValue(operand(context, args.sourceB ?? args.b ?? args.in2 ?? args.arg2));
        write(context, destination(args), value);
        return { power: context.power, value };
      },
    },
    {
      opcode: "sel",
      validate(args: Record<string, unknown>, context) {
        return validateDestination(args, context);
      },
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const value = asBool(operand(context, args.g ?? args.selector))
          ? operand(context, args.in1)
          : operand(context, args.in0);
        if (typeof args.dest === "string") write(context, args.dest, value);
        return { power: context.power, value };
      },
    },
    {
      opcode: "mux",
      validate(args: Record<string, unknown>, context) {
        const diagnostics = validateDestination(args, context);
        if (!Array.isArray(args.inputs))
          diagnostics.push(diagnostic("INVALID_ARGUMENTS", "MUX requires inputs array"));
        return diagnostics;
      },
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const inputs = Array.isArray(args.inputs) ? args.inputs : [];
        const value = operand(context, inputs[asNumber(operand(context, args.index))]);
        if (typeof args.dest === "string") write(context, args.dest, value);
        return { power: context.power, value };
      },
    },
    {
      opcode: "min",
      validate(args: Record<string, unknown>, context) {
        return validateDestination(args, context);
      },
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const values = (Array.isArray(args.values) ? args.values : [args.a, args.b]).map((value) =>
          asNumber(operand(context, value)),
        );
        const result = Math.min(...values);
        if (typeof args.dest === "string") write(context, args.dest, result);
        return { power: context.power, value: result };
      },
    },
    {
      opcode: "max",
      validate(args: Record<string, unknown>, context) {
        return validateDestination(args, context);
      },
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const values = (Array.isArray(args.values) ? args.values : [args.a, args.b]).map((value) =>
          asNumber(operand(context, value)),
        );
        const result = Math.max(...values);
        if (typeof args.dest === "string") write(context, args.dest, result);
        return { power: context.power, value: result };
      },
    },
    {
      opcode: "limit",
      validate(args: Record<string, unknown>, context) {
        return validateDestination(args, context);
      },
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const value = asNumber(operand(context, args.value ?? args.in));
        const result = Math.min(
          asNumber(operand(context, args.max)),
          Math.max(asNumber(operand(context, args.min)), value),
        );
        if (typeof args.dest === "string") write(context, args.dest, result);
        return { power: context.power, value: result };
      },
    },
    {
      opcode: "dcs",
      validate(args: Record<string, unknown>, context) {
        const diagnostics: Diagnostic[] = [];
        for (const [label, value] of [
          ["channelA", args.channelA],
          ["channelB", args.channelB],
          ["output", args.output ?? args.dest],
        ] as const) {
          if (typeof value !== "string")
            diagnostics.push(diagnostic("INVALID_ARGUMENTS", `DCS requires ${label} tag`));
          else if (!context.tags.has(value))
            diagnostics.push(
              diagnostic("UNKNOWN_TAG", `DCS ${label} references unknown tag ${value}`),
            );
        }
        if (typeof args.status === "string" && !context.tags.has(args.status))
          diagnostics.push(
            diagnostic("UNKNOWN_TAG", `DCS status references unknown tag ${args.status}`),
          );
        return diagnostics;
      },
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const channelA = asBool(operand(context, args.channelA));
        const channelB = asBool(operand(context, args.channelB));
        const equivalent = String(args.inputType ?? "")
          .toLowerCase()
          .includes("equivalent");
        const activeLow = String(args.inputType ?? "")
          .toLowerCase()
          .includes("low");
        const healthy = equivalent ? channelA === channelB : channelA !== channelB;
        const active = activeLow ? !channelA && !channelB : channelA && channelB;
        const value = healthy && active;
        const output = args.output ?? args.dest;
        if (typeof output === "string") write(context, output, value);
        if (typeof args.status === "string") write(context, args.status, value);
        if (typeof args.control === "string") {
          write(context, `${args.control}.ChannelA`, channelA);
          write(context, `${args.control}.ChannelB`, channelB);
          write(context, `${args.control}.Output1`, value);
          write(context, `${args.control}.FaultPresent`, !healthy);
        }
        return { power: context.power, value };
      },
    },
    {
      opcode: "series",
      execute(_args, context) {
        return { power: context.power };
      },
    },
    {
      opcode: "branch",
      execute(_args, context) {
        return { power: context.power };
      },
    },
    {
      opcode: "parallel",
      execute(_args, context) {
        return { power: context.power };
      },
    },
    {
      opcode: "function.call",
      execute(_args, context) {
        return { power: context.power };
      },
    },
    {
      opcode: "fb.call",
      execute(_args, context) {
        return { power: context.power };
      },
    },
    {
      opcode: "jsr",
      validate(args: Record<string, unknown>) {
        const target = args.routine ?? args.name ?? args.target;
        return typeof target === "string"
          ? []
          : [diagnostic("INVALID_ARGUMENTS", "JSR requires routine/name/target")];
      },
      async execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const target = args.routine ?? args.name ?? args.target;
        if (typeof target !== "string") throw new Error("JSR requires a routine name or id");
        await context.control.jumpToSubroutine(target);
        return { power: context.power };
      },
    },
    {
      opcode: "for",
      validate(args: Record<string, unknown>, context) {
        const diagnostics: Diagnostic[] = [];
        if (typeof (args.routine ?? args.name ?? args.target) !== "string")
          diagnostics.push(diagnostic("INVALID_ARGUMENTS", "FOR requires routine/name/target"));
        if (typeof args.index !== "string")
          diagnostics.push(diagnostic("INVALID_ARGUMENTS", "FOR requires index tag"));
        else if (!context.tags.has(args.index))
          diagnostics.push(
            diagnostic("UNKNOWN_TAG", `FOR index references unknown tag ${args.index}`),
          );
        return diagnostics;
      },
      async execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const routine = args.routine ?? args.name ?? args.target;
        if (typeof routine !== "string") throw new Error("FOR requires a routine name or id");
        if (typeof args.index !== "string") throw new Error("FOR requires an index tag");
        const initial = Math.trunc(asNumber(operand(context, args.initial ?? args.init ?? 0)));
        const terminal = Math.trunc(
          asNumber(operand(context, args.terminal ?? args.to ?? args.end)),
        );
        const step = Math.trunc(asNumber(operand(context, args.step ?? 1)));
        if (step === 0) throw new Error("FOR step must not be zero");
        let iterations = 0;
        for (let value = initial; step > 0 ? value <= terminal : value >= terminal; value += step) {
          if (iterations++ > 10_000) throw new Error("FOR iteration limit exceeded");
          context.tags.set(args.index, value);
          await context.control.jumpToSubroutine(routine);
        }
        return { power: context.power };
      },
    },
    {
      opcode: "sbr",
      execute(_args, context) {
        return { power: context.power };
      },
    },
    {
      opcode: "ret",
      execute(_args, context) {
        if (context.power) context.control.returnFromRoutine();
        return { power: context.power, done: context.power };
      },
    },
    {
      opcode: "tnd",
      execute(_args, context) {
        if (context.power) context.control.returnFromRoutine();
        return { power: context.power, done: context.power };
      },
    },
    {
      opcode: "jmp",
      validate(args: Record<string, unknown>) {
        return typeof (args.label ?? args.name ?? args.target) === "string"
          ? []
          : [diagnostic("INVALID_ARGUMENTS", "JMP requires label/name/target")];
      },
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const label = args.label ?? args.name ?? args.target;
        if (typeof label !== "string") throw new Error("JMP requires a label");
        context.control.jumpToLabel(label);
        return { power: context.power };
      },
    },
    {
      opcode: "lbl",
      validate(args: Record<string, unknown>) {
        return typeof (args.label ?? args.name ?? args.target) === "string"
          ? []
          : [diagnostic("INVALID_ARGUMENTS", "LBL requires label/name/target")];
      },
      execute(_args, context) {
        return { power: context.power };
      },
    },
    {
      opcode: "gsv",
      validate(args: Record<string, unknown>, context) {
        return validateDestination(args, context);
      },
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const value = systemValue(args, context);
        write(context, destination(args), value);
        return { power: context.power, value };
      },
    },
    {
      opcode: "ssv",
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        context.memory.set(
          `ssv:${String(args.class)}:${String(args.instance)}:${String(args.attribute)}`,
          operand(context, args.source),
        );
        return { power: context.power };
      },
    },
    {
      opcode: "fault",
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        throw new Error(String(args.message ?? args.code ?? "User fault"));
      },
    },
    {
      opcode: "nop",
      execute(_args, context) {
        return { power: context.power };
      },
    },
  ];

  for (const type of [
    "bool",
    "sint",
    "int",
    "dint",
    "lint",
    "usint",
    "uint",
    "udint",
    "ulint",
    "real",
    "lreal",
    "string",
  ]) {
    instructions.push({
      opcode: `to_${type}`,
      validate(args: Record<string, unknown>, context) {
        return validateDestination(args, context);
      },
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const raw = operand(context, args.source ?? args.value);
        const value =
          type === "bool" ? asBool(raw) : type === "string" ? String(raw ?? "") : Number(raw);
        if (typeof args.dest === "string") write(context, args.dest, value);
        return { power: context.power, value };
      },
    });
    instructions.push({
      opcode: `to.${type}`,
      validate(args: Record<string, unknown>, context) {
        return validateDestination(args, context);
      },
      execute(args: Record<string, unknown>, context) {
        if (!context.power) return { power: false };
        const raw = operand(context, args.source ?? args.value);
        const value =
          type === "bool" ? asBool(raw) : type === "string" ? String(raw ?? "") : Number(raw);
        if (typeof args.dest === "string") write(context, args.dest, value);
        return { power: context.power, value };
      },
    });
  }

  return {
    id: "@plc-emulation/core/instructions",
    version: "0.1.0",
    target: ["core", "browser", "worker", "node", "bun"],
    instructions,
  };
}
