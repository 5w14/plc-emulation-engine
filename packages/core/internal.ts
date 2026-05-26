import type {
  DirectAddress,
  PlcDataTypeRef,
  TagScope,
  UdtDefinition,
  VariableDeclaration,
} from "./types";

declare function setTimeout(handler: () => void, timeout?: number): unknown;
declare function structuredClone<T>(value: T): T;

export function id(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export function clone<T>(value: T): T {
  if (value === undefined || value === null) return value;
  if (typeof value === "function") return value;
  if (typeof structuredClone === "function") {
    try {
      return structuredClone(value);
    } catch {
      return clonePreservingFunctions(value);
    }
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function clonePreservingFunctions<T>(value: T): T {
  if (value === undefined || value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((entry) => clonePreservingFunctions(entry)) as T;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) output[key] = clonePreservingFunctions(entry);
  return output as T;
}

export function scopeKey(scope?: TagScope): string {
  if (!scope) return "global";
  return JSON.stringify(scope);
}

export function scopedPath(path: string, scope?: TagScope): string {
  return `${scopeKey(scope)}::${path}`;
}

export function addressKey(address: string | DirectAddress): string {
  if (typeof address === "string") return address.startsWith("%") ? address : `%${address}`;
  return `%${address.area}${address.size ?? ""}${address.address}`;
}

export interface PathSegment {
  key: string;
  index?: number;
  indices?: number[];
  indexExpressions?: string[];
}

export function parseTagPath(path: string): PathSegment[] {
  return path.split(".").map((part) => {
    const match = /^([^\[\]]+)(?:\[([^\[\]]+)\])?$/.exec(part);
    if (!match?.[1]) throw new Error(`Invalid tag path: ${path}`);
    if (match[2] === undefined) return { key: match[1] };
    const expressions = match[2].split(",").map((entry) => entry.trim());
    if (expressions.some((entry) => entry.length === 0))
      throw new Error(`Invalid tag path: ${path}`);
    const numeric = expressions.every((entry) => /^-?\d+$/.test(entry));
    const indices = numeric ? expressions.map((entry) => Number(entry)) : undefined;
    return {
      key: match[1],
      index: indices?.[0],
      indices,
      indexExpressions: numeric ? undefined : expressions,
    };
  });
}

export function getNested(root: unknown, segments: PathSegment[]): unknown {
  let current = root;
  for (const segment of segments) {
    if (current === undefined || current === null || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment.key];
    for (const index of segment.indices ?? (segment.index === undefined ? [] : [segment.index])) {
      if (!Array.isArray(current)) throw new Error(`Invalid array index on ${segment.key}`);
      if (index < 0 || index >= current.length)
        throw new Error(`Array index out of range on ${segment.key}`);
      current = current[index];
    }
  }
  return current;
}

export function setNested(
  root: Record<string, unknown>,
  segments: PathSegment[],
  value: unknown,
): unknown {
  let current: Record<string, unknown> = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment) throw new Error("Invalid empty tag path");
    const last = index === segments.length - 1;
    if (last) {
      const indices = segment.indices ?? (segment.index === undefined ? [] : [segment.index]);
      if (indices.length === 0) {
        const previous = current[segment.key];
        current[segment.key] = value;
        return previous;
      }
      let array: unknown = current[segment.key];
      for (let depth = 0; depth < indices.length - 1; depth += 1) {
        const arrayIndex = indices[depth] as number;
        if (!Array.isArray(array)) throw new Error(`Invalid array index on ${segment.key}`);
        if (arrayIndex < 0 || arrayIndex >= array.length)
          throw new Error(`Array index out of range on ${segment.key}`);
        array = array[arrayIndex];
      }
      const finalIndex = indices[indices.length - 1] as number;
      if (!Array.isArray(array)) throw new Error(`Invalid array index on ${segment.key}`);
      if (finalIndex < 0 || finalIndex >= array.length)
        throw new Error(`Array index out of range on ${segment.key}`);
      const previous = array[finalIndex];
      array[finalIndex] = value;
      return previous;
    }

    const indices = segment.indices ?? (segment.index === undefined ? [] : [segment.index]);
    let next = current[segment.key];
    if (indices.length > 0) {
      let array = next;
      for (let depth = 0; depth < indices.length; depth += 1) {
        const arrayIndex = indices[depth] as number;
        if (!Array.isArray(array)) throw new Error(`Invalid array index on ${segment.key}`);
        if (arrayIndex < 0 || arrayIndex >= array.length)
          throw new Error(`Array index out of range on ${segment.key}`);
        if (depth === indices.length - 1) {
          next = array[arrayIndex];
          if (next === undefined || next === null || typeof next !== "object") {
            next = {};
            array[arrayIndex] = next;
          }
        } else {
          array = array[arrayIndex];
        }
      }
    }
    if (next === undefined || next === null || typeof next !== "object") {
      next = {};
      if (segment.index === undefined) current[segment.key] = next;
    }
    current = next as Record<string, unknown>;
  }
  return undefined;
}

export function defaultValueForType(type: unknown): unknown {
  if (type === "BOOL") return false;
  if (type === "TIMER") return { PRE: 0, ACC: 0, EN: false, TT: false, DN: false };
  if (type === "COUNTER")
    return { PRE: 0, ACC: 0, CU: false, CD: false, DN: false, OV: false, UN: false };
  if (type === "CONTROL")
    return { LEN: 0, POS: 0, EN: false, EU: false, DN: false, EM: false, ER: false };
  if (type === "STRING" || type === "WSTRING") return "";
  if (
    type === "DATE" ||
    type === "TIME_OF_DAY" ||
    type === "TOD" ||
    type === "DATE_AND_TIME" ||
    type === "DT"
  )
    return "";
  if (typeof type === "string") return 0;
  if (typeof type === "object" && type && "kind" in type) {
    const typed = type as {
      kind: string;
      elementType?: unknown;
      dimensions?: Array<{ lower: number; upper: number }>;
      members?: Record<string, { type?: unknown; initialValue?: unknown; value?: unknown }>;
      min?: number;
    };
    if (typed.kind === "array") {
      return defaultArrayValue(typed.elementType, typed.dimensions ?? []);
    }
    if (typed.kind === "struct") {
      const output: Record<string, unknown> = {};
      for (const [name, member] of Object.entries(typed.members ?? {})) {
        output[name] = member.value ?? member.initialValue ?? defaultValueForType(member.type);
      }
      return output;
    }
    if (typed.kind === "enum") return (type as { values?: string[] }).values?.[0] ?? "";
    if (typed.kind === "subrange") return typed.min ?? 0;
  }
  return undefined;
}

export function typeForPath(
  declaration: VariableDeclaration | undefined,
  path: string,
  udts: Map<string, UdtDefinition>,
): PlcDataTypeRef | undefined {
  if (!declaration?.type) return undefined;
  let current: PlcDataTypeRef | undefined = declaration.type;
  const [root, ...segments] = parseTagPath(path);
  current = typeAfterIndices(current, indexPlaceholdersForType(root), udts);
  for (const segment of segments) {
    current = unwrapUdt(current, udts);
    if (!current || typeof current === "string") return undefined;
    if (current.kind === "struct") current = current.members[segment.key]?.type;
    current = typeAfterIndices(current, indexPlaceholdersForType(segment), udts);
  }
  return unwrapUdt(current, udts);
}

export function storageSegmentsForPath(
  declaration: VariableDeclaration | undefined,
  path: string,
  udts: Map<string, UdtDefinition>,
  resolveIndex?: (expression: string) => number,
): PathSegment[] {
  const segments = parseTagPath(path);
  if (!declaration?.type)
    return segments.map((segment) => {
      const indices = indicesForSegment(segment, resolveIndex);
      return {
        key: segment.key,
        index: indices[0],
        indices: indices.length > 0 ? indices : undefined,
      };
    });
  let current: PlcDataTypeRef | undefined = declaration.type;
  return segments.map((segment, segmentIndex) => {
    if (segmentIndex > 0) {
      current = unwrapUdt(current, udts);
      if (current && typeof current !== "string" && current.kind === "struct")
        current = current.members[segment.key]?.type;
    }
    const rawIndices = indicesForSegment(segment, resolveIndex);
    const adjusted = adjustArrayIndices(current, rawIndices, udts, segment.key);
    current = typeAfterIndices(current, rawIndices, udts);
    return {
      key: segment.key,
      index: adjusted[0],
      indices: adjusted.length > 0 ? adjusted : undefined,
    };
  });
}

export function normalizeValueForType(value: unknown, type: PlcDataTypeRef | undefined): unknown {
  if (!type || (typeof type === "object" && type.kind === "vendor")) return value;
  if (typeof type === "string") {
    if (type === "BOOL") {
      if (value === undefined || value === null) return false;
      if (typeof value === "number") return value !== 0;
      return value;
    }
    if (type === "STRING" || type === "WSTRING") return stringValue(value);
    const range = numericRange(type);
    if (!range) return value;
    if (value === undefined || value === null) return 0;
    const numeric = typeof value === "boolean" ? NaN : Number(value);
    if (!Number.isFinite(numeric)) return value;
    const converted = range.integer ? bankersRound(numeric) : numeric;
    if (converted < range.min || converted > range.max) return value;
    return converted;
  }
  if (type.kind === "array") {
    if (!Array.isArray(value)) return value;
    const expected = type.dimensions[0]
      ? Math.max(0, type.dimensions[0].upper - type.dimensions[0].lower + 1)
      : value.length;
    return value.slice(0, expected).map((entry) => normalizeValueForType(entry, type.elementType));
  }
  if (type.kind === "struct") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = { ...input };
    for (const [memberName, member] of Object.entries(type.members)) {
      if (Object.prototype.hasOwnProperty.call(input, memberName)) {
        output[memberName] = normalizeValueForType(input[memberName], member.type);
      }
    }
    return output;
  }
  if (type.kind === "subrange") return normalizeValueForType(value, type.baseType);
  return value;
}

export function validateValueForType(value: unknown, type: PlcDataTypeRef | undefined): void {
  if (!type || (typeof type === "object" && type.kind === "vendor")) return;
  if (typeof type === "string") {
    if (type === "BOOL" && typeof value !== "boolean")
      throw new Error(`Type mismatch: expected BOOL`);
    if ((type === "STRING" || type === "WSTRING") && typeof value !== "string")
      throw new Error(`Type mismatch: expected ${type}`);
    if (
      ["DATE", "TIME_OF_DAY", "TOD", "DATE_AND_TIME", "DT"].includes(type) &&
      !(typeof value === "string" || typeof value === "number" || value instanceof Date)
    )
      throw new Error(`Type mismatch: expected ${type}`);
    if (type === "TIME" && (typeof value !== "number" || !Number.isFinite(value)))
      throw new Error(`Type mismatch: expected TIME`);
    if (type === "REAL" || type === "LREAL") validateReal(value, type);
    if (integerRanges[type]) validateInteger(value, type);
    if (type === "TIMER") validateStructuredControl(value, type, ["PRE", "ACC", "EN", "TT", "DN"]);
    if (type === "COUNTER")
      validateStructuredControl(value, type, ["PRE", "ACC", "CU", "CD", "DN"]);
    if (type === "CONTROL") validateStructuredControl(value, type, ["LEN", "POS", "EN", "DN"]);
    return;
  }
  if (type.kind === "enum" && !type.values.includes(String(value)))
    throw new Error(`Range violation: ${String(value)} is not in enum ${type.name ?? ""}`.trim());
  if (type.kind === "subrange") {
    validateValueForType(value, type.baseType);
    if (typeof value !== "number") throw new Error(`Type mismatch: expected ${type.baseType}`);
    if (value < type.min || value > type.max)
      throw new Error(`Range violation: ${value} outside ${type.min}..${type.max}`);
  }
  if (type.kind === "array") validateArrayValue(value, type, type.dimensions, 0);
  if (type.kind === "struct") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(`Type mismatch: expected struct ${type.name ?? ""}`.trim());
    for (const [memberName, member] of Object.entries(type.members)) {
      if (Object.prototype.hasOwnProperty.call(value, memberName))
        validateValueForType((value as Record<string, unknown>)[memberName], member.type);
    }
  }
}

const integerRanges: Record<string, { min: number; max: number; unsigned?: boolean }> = {
  SINT: { min: -128, max: 127 },
  INT: { min: -32768, max: 32767 },
  DINT: { min: -2147483648, max: 2147483647 },
  LINT: { min: Number.MIN_SAFE_INTEGER, max: Number.MAX_SAFE_INTEGER },
  USINT: { min: 0, max: 255, unsigned: true },
  UINT: { min: 0, max: 65535, unsigned: true },
  UDINT: { min: 0, max: 4294967295, unsigned: true },
  ULINT: { min: 0, max: Number.MAX_SAFE_INTEGER, unsigned: true },
};

function validateInteger(value: unknown, type: string): void {
  const range = integerRanges[type];
  if (!range) throw new Error(`Type mismatch: expected ${type}`);
  if (typeof value !== "number" || !Number.isInteger(value))
    throw new Error(`Type mismatch: expected ${type}`);
  if (value < range.min || value > range.max)
    throw new Error(`Range violation: ${value} outside ${range.min}..${range.max}`);
}

function validateReal(value: unknown, type: string): void {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error(`Type mismatch: expected ${type}`);
}

function validateStructuredControl(value: unknown, type: string, keys: string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`Type mismatch: expected ${type}`);
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(value, key))
      throw new Error(`Type mismatch: expected ${type}.${key}`);
  }
}

function validateArrayValue(
  value: unknown,
  type: Extract<PlcDataTypeRef, { kind: "array" }>,
  dimensions: Array<{ lower: number; upper: number }>,
  depth: number,
): void {
  if (!Array.isArray(value)) throw new Error("Type mismatch: expected array");
  const dimension = dimensions[depth];
  if (!dimension) return;
  const expectedLength = Math.max(0, dimension.upper - dimension.lower + 1);
  if (value.length !== expectedLength)
    throw new Error(
      `Range violation: array length ${value.length} outside expected ${expectedLength}`,
    );
  if (depth === dimensions.length - 1) {
    for (const entry of value) validateValueForType(entry, type.elementType);
    return;
  }
  for (const entry of value) validateArrayValue(entry, type, dimensions, depth + 1);
}

function defaultArrayValue(
  elementType: unknown,
  dimensions: Array<{ lower: number; upper: number }>,
  depth = 0,
): unknown[] {
  const dimension = dimensions[depth] ?? { lower: 0, upper: -1 };
  const length = Math.max(0, dimension.upper - dimension.lower + 1);
  return Array.from({ length }, () =>
    depth === dimensions.length - 1
      ? defaultValueForType(elementType)
      : defaultArrayValue(elementType, dimensions, depth + 1),
  );
}

function typeAfterIndices(
  type: PlcDataTypeRef | undefined,
  indices: number[],
  udts: Map<string, UdtDefinition>,
): PlcDataTypeRef | undefined {
  const current = unwrapUdt(type, udts);
  if (indices.length === 0) return current;
  if (!current || typeof current === "string" || current.kind !== "array") return undefined;
  if (indices.length >= current.dimensions.length) return unwrapUdt(current.elementType, udts);
  return { ...current, dimensions: current.dimensions.slice(indices.length) };
}

function indexPlaceholdersForType(segment: PathSegment | undefined): number[] {
  if (!segment) return [];
  const count =
    segment.indices?.length ??
    (segment.index === undefined ? undefined : 1) ??
    segment.indexExpressions?.length ??
    0;
  return Array.from({ length: count }, () => 0);
}

function indicesForSegment(
  segment: PathSegment,
  resolveIndex?: (expression: string) => number,
): number[] {
  if (segment.indices) return segment.indices;
  if (segment.index !== undefined) return [segment.index];
  if (!segment.indexExpressions) return [];
  if (!resolveIndex)
    throw new Error(`Invalid tag path: ${segment.key}[${segment.indexExpressions.join(",")}]`);
  return segment.indexExpressions.map((expression) => resolveIndex(expression));
}

function adjustArrayIndices(
  type: PlcDataTypeRef | undefined,
  indices: number[],
  udts: Map<string, UdtDefinition>,
  segmentKey: string,
): number[] {
  if (indices.length === 0) return [];
  const current = unwrapUdt(type, udts);
  if (!current || typeof current === "string" || current.kind !== "array") return indices;
  return indices.map((index, depth) => {
    const dimension = current.dimensions[depth];
    if (!dimension) throw new Error(`Invalid array index on ${segmentKey}`);
    return index - dimension.lower;
  });
}

function unwrapUdt(
  type: PlcDataTypeRef | undefined,
  udts: Map<string, UdtDefinition>,
): PlcDataTypeRef | undefined {
  if (type && typeof type !== "string" && type.kind === "udt") {
    const udt = udts.get(type.name);
    return udt ? { kind: "struct", name: udt.name, members: udt.members } : type;
  }
  return type;
}

export function asBool(value: unknown): boolean {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "" || normalized === "false" || normalized === "0") return false;
    const numeric = Number(normalized);
    if (Number.isFinite(numeric)) return numeric !== 0;
    return normalized === "true";
  }
  return false;
}

export function asNumber(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function numericRange(type: string): { min: number; max: number; integer: boolean } | undefined {
  switch (type) {
    case "SINT":
      return { min: -128, max: 127, integer: true };
    case "USINT":
      return { min: 0, max: 255, integer: true };
    case "INT":
      return { min: -32768, max: 32767, integer: true };
    case "UINT":
      return { min: 0, max: 65535, integer: true };
    case "DINT":
      return { min: -2147483648, max: 2147483647, integer: true };
    case "UDINT":
      return { min: 0, max: 4294967295, integer: true };
    case "REAL":
      return { min: -3.4028234663852886e38, max: 3.4028234663852886e38, integer: false };
    default:
      return undefined;
  }
}

function bankersRound(value: number): number {
  const floor = Math.floor(value);
  const fraction = value - floor;
  if (fraction < 0.5) return floor;
  if (fraction > 0.5) return floor + 1;
  return floor % 2 === 0 ? floor : floor + 1;
}

function stringValue(value: unknown): string {
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

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
