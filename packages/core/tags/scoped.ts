import type { TagStore, VariableDeclaration } from "../types";

export class ScopedTagStore implements TagStore {
  constructor(
    private readonly parent: TagStore,
    private readonly local: TagStore,
    private readonly inputBindings: Record<string, string>,
    private readonly outputBindings: Record<string, string>,
  ) {}

  declare<T = unknown>(tag: VariableDeclaration<T>) {
    return this.local.declare(tag);
  }

  declareUdt(definition: Parameters<TagStore["declareUdt"]>[0]): void {
    this.local.declareUdt(definition);
  }

  declareAlias(alias: Parameters<TagStore["declareAlias"]>[0]): void {
    this.local.declareAlias(alias);
  }

  list(scope?: Parameters<TagStore["list"]>[0]) {
    return this.local.list(scope);
  }

  snapshot(options?: Parameters<TagStore["snapshot"]>[0]) {
    return this.local.snapshot(options);
  }

  quality(path: string, scope?: Parameters<TagStore["quality"]>[1]) {
    const bound = this.binding(path);
    return bound ? this.parent.quality(bound, scope) : this.local.quality(path, scope);
  }

  setQuality(
    path: string,
    quality: Parameters<TagStore["setQuality"]>[1],
    reason?: string,
    scope?: Parameters<TagStore["setQuality"]>[3],
  ): void {
    const bound = this.binding(path);
    if (bound) this.parent.setQuality(bound, quality, reason, scope);
    else this.local.setQuality(path, quality, reason, scope);
  }

  restore(snapshot: Parameters<TagStore["restore"]>[0]): void {
    this.local.restore(snapshot);
  }

  force(path: string, value: unknown, options?: Parameters<TagStore["force"]>[2]): void {
    this.local.force(path, value, options);
  }

  unforce(path: string): void {
    this.local.unforce(path);
  }

  listForces() {
    return this.local.listForces();
  }

  subscribe(
    path: Parameters<TagStore["subscribe"]>[0],
    listener: Parameters<TagStore["subscribe"]>[1],
  ) {
    return this.local.subscribe(path, listener);
  }

  has(path: string): boolean {
    return this.local.has(path) || this.parent.has(path) || this.binding(path) !== undefined;
  }

  get<T = unknown>(path: string, _options?: Parameters<TagStore["get"]>[1]): T {
    const bound = this.binding(path);
    if (bound) return this.parent.get<T>(bound);
    if (this.local.has(path)) return this.local.get<T>(path);
    return this.parent.get<T>(path);
  }

  set<T = unknown>(path: string, value: T, _options?: Parameters<TagStore["set"]>[2]): void {
    const bound = this.outputBinding(path);
    if (bound) {
      this.parent.set(bound, value);
      this.local.set(path, value);
    } else if (this.local.has(path) || this.inputBinding(path) === undefined)
      this.local.set(path, value);
  }

  update<T = unknown>(path: string, fn: (current: T) => T): T {
    const next = fn(this.get<T>(path));
    this.set(path, next);
    return next;
  }

  resolve(path: string, _scope?: Parameters<TagStore["resolve"]>[1]) {
    const bound = this.binding(path);
    return bound ? this.parent.resolve(bound) : this.local.resolve(path);
  }

  private binding(path: string): string | undefined {
    return this.inputBinding(path) ?? this.outputBinding(path);
  }

  private inputBinding(path: string): string | undefined {
    return this.boundPath(path, this.inputBindings);
  }

  private outputBinding(path: string): string | undefined {
    return this.boundPath(path, this.outputBindings);
  }

  private boundPath(path: string, bindings: Record<string, string>): string | undefined {
    const exact = bindings[path];
    if (exact) return exact;
    const root = rootTagPath(path);
    const boundRoot = bindings[root];
    return boundRoot ? `${boundRoot}${path.slice(root.length)}` : undefined;
  }
}

function rootTagPath(path: string): string {
  const member = path.indexOf(".");
  const element = path.indexOf("[");
  if (member < 0) return element < 0 ? path : path.slice(0, element);
  if (element < 0) return path.slice(0, member);
  return path.slice(0, Math.min(member, element));
}
