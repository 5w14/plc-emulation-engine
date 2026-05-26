import {
  clone,
  defaultValueForType,
  getNested,
  normalizeValueForType,
  parseTagPath,
  scopedPath,
  setNested,
  storageSegmentsForPath,
  typeForPath,
  validateValueForType,
} from "../internal";
import type {
  AliasTagDeclaration,
  ForceOptions,
  ForceState,
  ResolvedTagRef,
  SnapshotOptions,
  TagChangeEvent,
  TagListener,
  TagPath,
  TagPattern,
  TagQuality,
  TagQualityState,
  TagReadOptions,
  TagRef,
  TagScope,
  TagSnapshot,
  TagStore,
  UdtDefinition,
  VariableDeclaration,
} from "../types";

interface Subscriber {
  pattern: TagPath | TagPattern;
  listener: TagListener;
}

export class InMemoryTagStore implements TagStore {
  private roots = new Map<string, Record<string, unknown>>();
  private declarations = new Map<string, VariableDeclaration>();
  private aliases = new Map<string, AliasTagDeclaration>();
  private udts = new Map<string, UdtDefinition>();
  private forces = new Map<string, ForceState>();
  private qualityByPath = new Map<string, TagQualityState>();
  private subscribers = new Set<Subscriber>();
  private readonly emit?: (
    name: "tag:read" | "tag:write" | "tag:change" | "force:apply" | "force:remove",
    payload: unknown,
  ) => void;
  private readonly onRuntimeError?: (error: Error, metadata?: Record<string, unknown>) => void;

  constructor(
    options: {
      emit?: (
        name: "tag:read" | "tag:write" | "tag:change" | "force:apply" | "force:remove",
        payload: unknown,
      ) => void;
      onRuntimeError?: (error: Error, metadata?: Record<string, unknown>) => void;
    } = {},
  ) {
    this.emit = options.emit;
    this.onRuntimeError = options.onRuntimeError;
  }

  declare<T = unknown>(tag: VariableDeclaration<T>): TagRef<T> {
    const scope = tag.scope;
    const key = scopedPath(tag.name, scope);
    const value = tag.value ?? tag.initialValue ?? defaultValueForType(tag.type);
    this.declarations.set(key, clone(tag) as VariableDeclaration);
    if (!this.valueExists(tag.name, scope)) {
      this.set(tag.name, value, { scope, bypassReadonly: true });
    }
    this.setQuality(tag.name, value === undefined ? "uninitialized" : "good", undefined, scope);
    return {
      ...this.resolve(tag.name, scope),
      get: () => this.get<T>(tag.name, { scope }),
      set: (next: T) => this.set(tag.name, next, { scope }),
    };
  }

  declareUdt(definition: UdtDefinition): void {
    this.udts.set(definition.name, clone(definition));
  }

  declareAlias(alias: AliasTagDeclaration): void {
    this.aliases.set(scopedPath(alias.name, alias.scope), clone(alias));
  }

  list(scope?: TagScope): ResolvedTagRef[] {
    const root = this.root(scope);
    return Object.keys(root).map((path) => this.resolve(path, scope));
  }

  has(path: TagPath, scope?: TagScope): boolean {
    const canonical = this.resolveAlias(path, scope);
    return this.declarationFor(canonical, scope) !== undefined;
  }

  get<T = unknown>(path: TagPath, options: TagReadOptions = {}): T {
    const scope = options.scope;
    const canonical = this.resolveAlias(path, scope);
    const declaration = this.declarationFor(canonical, scope);
    if (!declaration) this.fail(new Error(`Unknown tag: ${canonical}`), { path: canonical, scope });
    const segments = storageSegmentsForPath(declaration, canonical, this.udts, (expression) =>
      this.resolveIndexExpression(expression, scope),
    );
    const force = this.forces.get(scopedPath(canonical, scope));
    let value: unknown;
    try {
      value = force && !options.raw ? force.value : getNested(this.root(scope), segments);
    } catch (error) {
      this.fail(error, { path: canonical, scope });
    }
    this.emit?.("tag:read", { path: canonical, scope, value });
    return clone(value) as T;
  }

  set<T = unknown>(
    path: TagPath,
    value: T,
    options: { scope?: TagScope; force?: boolean; bypassReadonly?: boolean } = {},
  ): void {
    const scope = options.scope;
    const canonical = this.resolveAlias(path, scope);
    const key = scopedPath(canonical, scope);
    if (this.forces.has(key) && !options.force) return;
    const root = this.root(scope);
    const declaration = this.declarationFor(canonical, scope);
    if (!declaration) this.fail(new Error(`Unknown tag: ${canonical}`), { path: canonical, scope });
    const segments = storageSegmentsForPath(declaration, canonical, this.udts, (expression) =>
      this.resolveIndexExpression(expression, scope),
    );
    if (!options.bypassReadonly && (declaration?.readonly || declaration?.constant))
      this.fail(new Error(`Tag is readonly: ${canonical}`), { path: canonical, scope });
    const targetType = typeForPath(declaration, canonical, this.udts);
    const normalizedValue = normalizeValueForType(value, targetType);
    try {
      validateValueForType(normalizedValue, targetType);
    } catch (error) {
      this.fail(error, { path: canonical, scope });
    }
    let previous: unknown;
    try {
      previous = getNested(root, segments);
      setNested(root, segments, clone(normalizedValue));
    } catch (error) {
      this.fail(error, { path: canonical, scope });
    }
    this.setQuality(canonical, options.force ? "forced" : "good", undefined, scope);
    this.emit?.("tag:write", { path: canonical, scope, value: normalizedValue, previous });
    if (previous !== normalizedValue)
      this.notify({ path: canonical, scope, value: normalizedValue, previous });
  }

  update<T = unknown>(path: TagPath, fn: (current: T) => T): T {
    const next = fn(this.get<T>(path));
    this.set(path, next);
    return next;
  }

  resolve(path: TagPath, scope?: TagScope): ResolvedTagRef {
    const canonicalPath = this.resolveAlias(path, scope);
    const key = scopedPath(canonicalPath, scope);
    return {
      path,
      canonicalPath,
      declaration: this.declarations.get(
        scopedPath(canonicalPath.split(".")[0] ?? canonicalPath, scope),
      ),
      scope,
      value: this.get(canonicalPath, { scope, raw: true }),
      forced: this.forces.has(key),
      quality: this.quality(canonicalPath, scope).quality,
    };
  }

  quality(path: TagPath, scope?: TagScope): TagQualityState {
    const canonical = this.resolveAlias(path, scope);
    return clone(
      this.qualityByPath.get(scopedPath(canonical, scope)) ?? {
        path: canonical,
        scope,
        quality: "uninitialized",
      },
    );
  }

  setQuality(path: TagPath, quality: TagQuality, reason?: string, scope?: TagScope): void {
    const canonical = this.resolveAlias(path, scope);
    this.qualityByPath.set(scopedPath(canonical, scope), {
      path: canonical,
      scope,
      quality,
      reason,
    });
  }

  snapshot(options: SnapshotOptions = {}): TagSnapshot {
    const values: Record<string, unknown> = {};
    if (options.includeRetainedOnly) {
      for (const declaration of this.declarations.values()) {
        if (!declaration.retain || declaration.nonRetain) continue;
        const scope = declaration.scope;
        const scopeId = scope ? JSON.stringify(scope) : "global";
        values[scopeId] ??= {};
        (values[scopeId] as Record<string, unknown>)[declaration.name] = this.get(
          declaration.name,
          { scope, raw: true },
        );
      }
    } else {
      for (const [scope, root] of this.roots.entries()) {
        values[scope] = clone(root);
      }
    }
    const declarations = Array.from(this.declarations.values()).filter((declaration) => {
      if (!options.includeRetainedOnly) return true;
      return declaration.retain === true;
    });
    return {
      values,
      declarations: clone(declarations),
      aliases: clone(Array.from(this.aliases.values())),
      udts: clone(Array.from(this.udts.values())),
      forces: this.listForces(),
      quality: clone(Array.from(this.qualityByPath.values())),
    };
  }

  restore(snapshot: TagSnapshot): void {
    this.roots = new Map(
      Object.entries(clone(snapshot.values)).map(([key, value]) => [
        key,
        value as Record<string, unknown>,
      ]),
    );
    this.declarations = new Map(
      snapshot.declarations.map((declaration) => [
        scopedPath(declaration.name, declaration.scope),
        clone(declaration),
      ]),
    );
    this.aliases = new Map(
      snapshot.aliases.map((alias) => [scopedPath(alias.name, alias.scope), clone(alias)]),
    );
    this.udts = new Map(snapshot.udts.map((udt) => [udt.name, clone(udt)]));
    this.forces = new Map(
      snapshot.forces.map((force) => [scopedPath(force.path, force.scope), clone(force)]),
    );
    this.qualityByPath = new Map(
      (snapshot.quality ?? []).map((quality) => [
        scopedPath(quality.path, quality.scope),
        clone(quality),
      ]),
    );
  }

  force(path: TagPath, value: unknown, options: ForceOptions = {}): void {
    const canonical = this.resolveAlias(path, options.scope);
    const force = {
      path: canonical,
      value: clone(value),
      scope: options.scope,
      reason: options.reason,
    };
    this.forces.set(scopedPath(canonical, options.scope), force);
    this.set(canonical, value, { scope: options.scope, force: true });
    this.setQuality(canonical, "forced", options.reason, options.scope);
    this.emit?.("force:apply", force);
  }

  unforce(path: TagPath): void {
    for (const [key, force] of this.forces.entries()) {
      if (force.path === path) {
        this.forces.delete(key);
        this.setQuality(force.path, "good", undefined, force.scope);
        this.emit?.("force:remove", force);
      }
    }
  }

  listForces(): ForceState[] {
    return clone(Array.from(this.forces.values()));
  }

  subscribe(path: TagPath | TagPattern, listener: TagListener): () => void {
    const subscriber = { pattern: path, listener };
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  private valueExists(path: TagPath, scope?: TagScope): boolean {
    const canonical = this.resolveAlias(path, scope);
    const first = parseTagPath(canonical)[0]?.key;
    return first !== undefined && Object.prototype.hasOwnProperty.call(this.root(scope), first);
  }

  private root(scope?: TagScope): Record<string, unknown> {
    const key = scope ? JSON.stringify(scope) : "global";
    let root = this.roots.get(key);
    if (!root) {
      root = {};
      this.roots.set(key, root);
    }
    return root;
  }

  private resolveAlias(path: TagPath, scope?: TagScope): TagPath {
    const alias = this.aliases.get(scopedPath(path, scope)) ?? this.aliases.get(scopedPath(path));
    return alias ? alias.target : path;
  }

  private declarationFor(path: TagPath, scope?: TagScope): VariableDeclaration | undefined {
    const root = parseTagPath(path)[0]?.key ?? path;
    return (
      this.declarations.get(scopedPath(path, scope)) ??
      this.declarations.get(scopedPath(path)) ??
      this.declarations.get(scopedPath(root, scope)) ??
      this.declarations.get(scopedPath(root))
    );
  }

  private resolveIndexExpression(expression: string, scope?: TagScope): number {
    if (/^-?\d+$/.test(expression)) return Number(expression);
    const match = /^(.+?)(?:\s*([+-])\s*(\d+))?$/.exec(expression);
    if (!match?.[1]) throw new Error(`Invalid tag index expression: ${expression}`);
    const value = this.get(match[1], { scope });
    if (typeof value !== "number" || !Number.isInteger(value))
      throw new Error(`Invalid tag index expression: ${expression}`);
    const offset = match[2] && match[3] ? Number(`${match[2]}${match[3]}`) : 0;
    return value + offset;
  }

  private fail(error: unknown, metadata?: Record<string, unknown>): never {
    const typed = error instanceof Error ? error : new Error(String(error));
    this.onRuntimeError?.(typed, metadata);
    throw typed;
  }

  private notify(event: TagChangeEvent): void {
    this.emit?.("tag:change", event);
    for (const subscriber of this.subscribers) {
      if (this.matches(subscriber.pattern, event.path)) subscriber.listener(clone(event));
    }
  }

  private matches(pattern: TagPath | TagPattern, path: string): boolean {
    if (pattern instanceof RegExp) return pattern.test(path);
    return pattern === path || pattern === "*" || path.startsWith(`${pattern}.`);
  }
}
