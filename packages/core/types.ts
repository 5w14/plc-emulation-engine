export type Unsubscribe = () => void;

export interface SourceLocation {
  sourceName?: string;
  line?: number;
  column?: number;
  path?: string;
}

export interface Diagnostic {
  id: string;
  severity: "info" | "warning" | "error";
  code: string;
  message: string;
  source?: SourceLocation;
  related?: SourceLocation[];
  metadata?: Record<string, unknown>;
}

export interface PlcFault {
  id: string;
  severity: "minor" | "major" | "fatal";
  code: string;
  message: string;
  source?: SourceLocation;
  scanNumber?: number;
  recoverable: boolean;
  metadata?: Record<string, unknown>;
}

export type ElementaryType =
  | "BOOL"
  | "SINT"
  | "INT"
  | "DINT"
  | "LINT"
  | "USINT"
  | "UINT"
  | "UDINT"
  | "ULINT"
  | "REAL"
  | "LREAL"
  | "STRING"
  | "WSTRING"
  | "TIME"
  | "DATE"
  | "TIME_OF_DAY"
  | "TOD"
  | "DATE_AND_TIME"
  | "DT"
  | "TIMER"
  | "COUNTER"
  | "CONTROL";

export interface ArrayDimension {
  lower: number;
  upper: number;
}

export type PlcDataTypeRef =
  | ElementaryType
  | { kind: "array"; elementType: PlcDataTypeRef; dimensions: ArrayDimension[] }
  | { kind: "struct"; name?: string; members: Record<string, VariableDeclaration> }
  | { kind: "enum"; name?: string; values: string[] }
  | { kind: "subrange"; baseType: ElementaryType; min: number; max: number }
  | { kind: "udt"; name: string }
  | { kind: "vendor"; name: string };

export type VariableClass =
  | "global"
  | "local"
  | "input"
  | "output"
  | "inout"
  | "external"
  | "temporary";

export type TagScope =
  | { kind: "configuration"; configurationId: string }
  | { kind: "resource"; resourceId: string }
  | { kind: "program"; programId: string }
  | { kind: "routine"; routineId: string }
  | { kind: "pou-instance"; instanceId: string }
  | { kind: "aoi"; instanceId: string };

export interface DirectAddress {
  area: "I" | "Q" | "M";
  size?: "X" | "B" | "W" | "D" | "L";
  address: string;
}

export interface VariableDeclaration<T = unknown> {
  name: string;
  type?: PlcDataTypeRef;
  class?: VariableClass;
  scope?: TagScope;
  initialValue?: T;
  value?: T;
  constant?: boolean;
  retain?: boolean;
  nonRetain?: boolean;
  locatedAt?: DirectAddress;
  readonly?: boolean;
  metadata?: Record<string, unknown>;
}

export interface UdtDefinition {
  name: string;
  members: Record<string, VariableDeclaration>;
  metadata?: Record<string, unknown>;
}

export type TagPath = string;
export type TagPattern = string | RegExp;

export interface AliasTagDeclaration {
  name: string;
  target: TagPath;
  scope?: TagScope;
  type?: PlcDataTypeRef;
}

export interface TagReadOptions {
  scope?: TagScope;
  raw?: boolean;
}

export interface TagWriteOptions {
  scope?: TagScope;
  force?: boolean;
  bypassReadonly?: boolean;
}

export interface ForceOptions {
  scope?: TagScope;
  reason?: string;
}

export interface ForceState {
  path: TagPath;
  value: unknown;
  scope?: TagScope;
  reason?: string;
}

export interface IoForceState {
  address: string;
  value: unknown;
  reason?: string;
}

export interface IoRuntimeSnapshot {
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  memory: Record<string, unknown>;
  forces: {
    inputs: IoForceState[];
    outputs: IoForceState[];
    memory: IoForceState[];
  };
}

export type TagQuality = "good" | "forced" | "uncertain" | "bad" | "uninitialized";

export interface TagQualityState {
  path: TagPath;
  scope?: TagScope;
  quality: TagQuality;
  reason?: string;
}

export interface ResolvedTagRef {
  path: TagPath;
  canonicalPath: TagPath;
  declaration?: VariableDeclaration;
  scope?: TagScope;
  value: unknown;
  forced: boolean;
  quality: TagQuality;
}

export interface TagRef<T = unknown> extends ResolvedTagRef {
  get(): T;
  set(value: T): void;
}

export interface TagChangeEvent {
  path: TagPath;
  value: unknown;
  previous: unknown;
  scope?: TagScope;
}

export type TagListener = (event: TagChangeEvent) => void;

export interface SnapshotOptions {
  includeDiagnostics?: boolean;
  includeRetainedOnly?: boolean;
}

export interface TagSnapshot {
  values: Record<string, unknown>;
  declarations: VariableDeclaration[];
  aliases: AliasTagDeclaration[];
  udts: UdtDefinition[];
  forces: ForceState[];
  quality: TagQualityState[];
}

export interface TagStore {
  declare<T = unknown>(tag: VariableDeclaration<T>): TagRef<T>;
  declareUdt(definition: UdtDefinition): void;
  declareAlias(alias: AliasTagDeclaration): void;
  list(scope?: TagScope): ResolvedTagRef[];
  has(path: TagPath, scope?: TagScope): boolean;
  get<T = unknown>(path: TagPath, options?: TagReadOptions): T;
  set<T = unknown>(path: TagPath, value: T, options?: TagWriteOptions): void;
  update<T = unknown>(path: TagPath, fn: (current: T) => T): T;
  resolve(path: TagPath, scope?: TagScope): ResolvedTagRef;
  quality(path: TagPath, scope?: TagScope): TagQualityState;
  setQuality(path: TagPath, quality: TagQuality, reason?: string, scope?: TagScope): void;
  snapshot(options?: SnapshotOptions): TagSnapshot;
  restore(snapshot: TagSnapshot): void;
  force(path: TagPath, value: unknown, options?: ForceOptions): void;
  unforce(path: TagPath): void;
  listForces(): ForceState[];
  subscribe(path: TagPath | TagPattern, listener: TagListener): Unsubscribe;
}

export interface RoutineParameter {
  name: string;
  type?: PlcDataTypeRef;
  direction?: "input" | "output" | "inout";
}

export interface InstructionNode<TArgs = unknown> {
  id?: string;
  opcode: string;
  args: TArgs;
  children?: InstructionNode[];
  source?: SourceLocation;
  metadata?: Record<string, unknown>;
}

export interface PlcRung {
  id?: string;
  number?: number;
  name?: string;
  comment?: string;
  enabled?: boolean;
  instructions: InstructionNode[];
  source?: SourceLocation;
  metadata?: Record<string, unknown>;
}

export interface PlcNetwork {
  id?: string;
  name?: string;
  enabled?: boolean;
  instructions?: InstructionNode[];
  rungs?: PlcRung[];
  source?: SourceLocation;
  metadata?: Record<string, unknown>;
}

export interface PlcRoutine {
  id?: string;
  name: string;
  language: "ld" | "ladder" | "js" | "st" | "fbd" | "sfc" | "il" | "custom";
  rungs?: PlcRung[];
  networks?: PlcNetwork[];
  parameters?: RoutineParameter[];
  scan?: ImperativeScanFunction;
  metadata?: Record<string, unknown>;
}

export type PouKind = "program" | "function" | "function-block" | "aoi";

export interface PouInterface {
  inputs?: VariableDeclaration[];
  outputs?: VariableDeclaration[];
  inouts?: VariableDeclaration[];
  externals?: VariableDeclaration[];
  temporaries?: VariableDeclaration[];
}

export interface PouBody {
  language: "ld" | "fbd" | "st" | "sfc" | "il" | "js" | "custom";
  networks?: PlcNetwork[];
  routines?: PlcRoutine[];
  statements?: unknown;
  graph?: unknown;
  custom?: unknown;
}

export interface PouDefinition {
  id?: string;
  name: string;
  kind: PouKind;
  interface: PouInterface;
  body: PouBody;
  variables?: VariableDeclaration[];
  metadata?: Record<string, unknown>;
}

export interface AoiParameter {
  name: string;
  type?: PlcDataTypeRef;
  direction: "input" | "output" | "inout";
  required?: boolean;
  defaultValue?: unknown;
}

export interface AoiDefinition {
  id?: string;
  name: string;
  parameters: AoiParameter[];
  localTags?: VariableDeclaration[];
  routines: PlcRoutine[];
  metadata?: Record<string, unknown>;
}

export interface PlcProgramUnit {
  id?: string;
  name: string;
  pou?: string;
  routines?: PlcRoutine[];
  variables?: VariableDeclaration[];
  metadata?: Record<string, unknown>;
}

export interface ProgramInstance {
  id?: string;
  name: string;
  program: string;
  task?: string;
  metadata?: Record<string, unknown>;
}

export interface AccessPathDeclaration {
  name: string;
  path: TagPath;
  metadata?: Record<string, unknown>;
}

export interface PlcTask {
  id?: string;
  name: string;
  kind: "continuous" | "periodic" | "event";
  priority: number;
  periodMs?: number;
  watchdogMs?: number;
  inhibited?: boolean;
}

export interface PlcResource {
  id?: string;
  name: string;
  tasks: PlcTask[];
  programs: ProgramInstance[];
  globalVariables?: VariableDeclaration[];
}

export interface PlcConfiguration {
  id?: string;
  name: string;
  resources: PlcResource[];
  globalVariables?: VariableDeclaration[];
  accessPaths?: AccessPathDeclaration[];
}

export interface ProgramSource {
  id?: string;
  name: string;
  configuration?: PlcConfiguration;
  tasks?: PlcTask[];
  programs?: PlcProgramUnit[];
  pous?: PouDefinition[];
  tags?: VariableDeclaration[];
  udts?: UdtDefinition[];
  aois?: AoiDefinition[];
  diagnostics?: Diagnostic[];
  metadata?: Record<string, unknown>;
}

export interface LoadedProgram {
  id: string;
  name: string;
  source: ProgramSource;
  loadedAt: number;
}

export interface PlcConfigurationRuntime {
  current?: PlcConfiguration;
  loadedPrograms: LoadedProgram[];
}

export type ControllerMode =
  | "program"
  | "run"
  | "remote-program"
  | "remote-run"
  | "test"
  | "paused"
  | "faulted";

export interface ControllerRuntime {
  mode: ControllerMode;
  scanNumber: number;
  reason?: string;
  setMode(mode: ControllerMode): void;
  clearFaults(): void;
}

export interface PlcClock {
  now(): number;
  highResTime(): number;
  advance(ms: number): void;
  useRealTime(): void;
  useVirtualTime(startMs?: number): void;
  snapshot(): ClockSnapshot;
  restore(snapshot: ClockSnapshot): void;
}

export interface ClockSnapshot {
  mode: "real" | "virtual";
  nowMs: number;
}

export interface InstructionMemory {
  get<T = unknown>(key: string): T | undefined;
  set<T = unknown>(key: string, value: T): void;
  delete(key: string): void;
  snapshot(): Record<string, unknown>;
  restore(snapshot: Record<string, unknown>): void;
}

export interface ExecutionFrame {
  kind: "task" | "program" | "pou" | "routine" | "network" | "rung" | "instruction" | "fb" | "aoi";
  id: string;
  name?: string;
}

export interface InstructionContext {
  engine: PlcEngine;
  tags: TagStore;
  io: IoRuntime;
  clock: PlcClock;
  control: InstructionExecutionControl;
  memory: InstructionMemory;
  scanNumber: number;
  power: boolean;
  instruction: InstructionNode;
  stack: ExecutionFrame[];
  call?: FunctionBlockCallContext;
}

export interface InstructionExecutionControl {
  jumpToSubroutine(nameOrId: string): Promise<void>;
  jumpToLabel(label: string): void;
  returnFromRoutine(): void;
}

export interface FunctionBlockCallContext {
  definition: PouDefinition | AoiDefinition;
  instance: string;
  parameters: Record<string, unknown>;
}

export interface FunctionBlockInstanceInspection {
  instance: string;
  definitionId: string;
  definitionName: string;
  kind: "function" | "function-block" | "aoi";
  parameters: Record<string, string>;
  memory: Record<string, unknown>;
}

export interface ValidateContext {
  source: ProgramSource;
  tags: TagStore;
}

export interface InstructionResult {
  power?: boolean;
  value?: unknown;
  done?: boolean;
  jump?: string;
}

export interface InstructionDefinition<TArgs = unknown> {
  opcode: string;
  displayName?: string;
  validate?(args: TArgs, context: ValidateContext): Diagnostic[];
  prescan?(args: TArgs, context: InstructionContext): void | Promise<void>;
  execute(args: TArgs, context: InstructionContext): InstructionResult | Promise<InstructionResult>;
  postscan?(args: TArgs, context: InstructionContext): void | Promise<void>;
  reset?(args: TArgs, context: InstructionContext): void | Promise<void>;
}

export interface IoImage {
  get<T = unknown>(address: string | DirectAddress): T;
  set<T = unknown>(address: string | DirectAddress, value: T): void;
  has(address: string | DirectAddress): boolean;
  snapshot(): Record<string, unknown>;
  restore(snapshot: Record<string, unknown>): void;
  force(address: string | DirectAddress, value: unknown, reason?: string): void;
  unforce(address: string | DirectAddress): void;
  listForces(): IoForceState[];
}

export interface DeviceRegistry {
  list(): EmulatedDevice[];
  get(id: string): EmulatedDevice | undefined;
}

export interface EmulatedDevice {
  id: string;
  updateInputs?(io: IoRuntime): void | Promise<void>;
  commitOutputs?(io: IoRuntime): void | Promise<void>;
}

export interface IoRuntime {
  inputs: IoImage;
  outputs: IoImage;
  memory: IoImage;
  devices: DeviceRegistry;
  updateInputs(): Promise<void>;
  commitOutputs(): Promise<void>;
  attachDevice(device: EmulatedDevice): void;
  snapshot(): IoRuntimeSnapshot;
  restore(snapshot: IoRuntimeSnapshot): void;
}

export type DebugEventName =
  | "scan:start"
  | "scan:end"
  | "task:start"
  | "task:end"
  | "program:start"
  | "program:end"
  | "pou:start"
  | "pou:end"
  | "routine:start"
  | "routine:end"
  | "network:start"
  | "network:end"
  | "rung:start"
  | "rung:end"
  | "instruction:before"
  | "instruction:after"
  | "instruction:error"
  | "fb:before"
  | "fb:after"
  | "fb:error"
  | "tag:read"
  | "tag:write"
  | "tag:change"
  | "io:input-update"
  | "io:output-commit"
  | "force:apply"
  | "force:remove"
  | "fault:raise"
  | "fault:clear"
  | "breakpoint:hit"
  | "trace:emit";

export interface DebugEvent {
  name: DebugEventName;
  scanNumber: number;
  timestamp: number;
  stack?: ExecutionFrame[];
  payload?: unknown;
}

export type DebugListener = (event: DebugEvent) => void;

export type BreakpointInput =
  | { kind: "instruction"; instructionId: string }
  | { kind: "tag"; path: TagPath; access?: "read" | "write" | "change" }
  | { kind: "boundary"; boundary: ExecutionFrame["kind"]; id: string };

export interface Breakpoint {
  id: string;
  input: BreakpointInput;
  enabled: boolean;
}

export interface WatchInput {
  path: TagPath;
}

export interface Watch {
  id: string;
  input: WatchInput;
  value: unknown;
}

export interface TraceInput {
  path: TagPath;
  everyScans?: number;
}

export interface Trace {
  id: string;
  input: TraceInput;
  samples: Array<{ scanNumber: number; timestamp: number; value: unknown }>;
}

export interface StepResult {
  event?: DebugEvent;
  stack: ExecutionFrame[];
  resumed?: boolean;
}

export interface PlcDebugger {
  addBreakpoint(input: BreakpointInput): Breakpoint;
  removeBreakpoint(id: string): void;
  listBreakpoints(): Breakpoint[];
  addWatch(input: WatchInput): Watch;
  removeWatch(id: string): void;
  trace(input: TraceInput): Trace;
  removeTrace(id: string): void;
  step(
    mode:
      | "scan"
      | "task"
      | "program"
      | "routine"
      | "network"
      | "rung"
      | "instruction"
      | "into-fb"
      | "over-fb"
      | "into-aoi"
      | "over-aoi",
  ): Promise<StepResult>;
  continue(): Promise<void>;
  on(event: DebugEventName, listener: DebugListener): Unsubscribe;
  emit(event: DebugEvent): void;
  snapshot(): DebugSnapshot;
  restore(snapshot: DebugSnapshot): void;
}

export interface DebugSnapshot {
  breakpoints: Breakpoint[];
  watches: Watch[];
  traces: Trace[];
  lastEvent?: DebugEvent;
}

export interface DiagnosticStore {
  add(diagnostic: Diagnostic): void;
  list(): Diagnostic[];
  clear(): void;
}

export interface FaultStore {
  raise(fault: PlcFault): void;
  list(): PlcFault[];
  clear(id?: string): void;
  snapshot(): PlcFault[];
  restore(faults: PlcFault[]): void;
}

export type PluginRuntimeTarget = "core" | "browser" | "worker" | "node" | "bun" | "server";

export interface LanguagePlugin {
  language: string;
  execute?: (body: unknown, context: InstructionContext) => void | Promise<void>;
}

export interface ProgramLoader {
  id: string;
  load(input: unknown): Promise<ProgramSource>;
}

export interface DeviceDefinition {
  id: string;
  create(): EmulatedDevice;
}

export interface DebugSink {
  id: string;
  emit(event: DebugEvent): void | Promise<void>;
}

export interface TagCodec {
  id: string;
}

export interface RpcMethodDefinition {
  name: string;
  handler(context: RpcContext, params: unknown): unknown | Promise<unknown>;
}

export interface PluginSetupContext {
  engine: PlcEngine;
  registry: PluginRegistry;
}

export interface PlcPlugin {
  id: string;
  version?: string;
  target?: PluginRuntimeTarget[];
  instructions?: InstructionDefinition[];
  languages?: LanguagePlugin[];
  programLoaders?: ProgramLoader[];
  devices?: DeviceDefinition[];
  debugSinks?: DebugSink[];
  tagCodecs?: TagCodec[];
  rpcMethods?: RpcMethodDefinition[];
  setup?(context: PluginSetupContext): void | Promise<void>;
}

export interface PluginRegistry {
  register(plugin: PlcPlugin, options?: { overrideInstructions?: boolean }): Promise<void> | void;
  list(): PlcPlugin[];
  getInstruction(opcode: string): InstructionDefinition | undefined;
  getLanguage(language: string): LanguagePlugin | undefined;
  getRpcMethod(name: string): RpcMethodDefinition | undefined;
  getDebugSinks(): DebugSink[];
}

export interface RuntimeMessage {
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export type RuntimeMessageListener = (message: RuntimeMessage) => void | Promise<void>;

export interface RuntimeTransportContext {
  router: RuntimeRpcRouter;
  engine: PlcEngine;
}

export interface RuntimeTransport {
  id: string;
  start?(context: RuntimeTransportContext): void | Promise<void>;
  stop?(): void | Promise<void>;
  send?(message: RuntimeMessage): void | Promise<void>;
  onMessage(listener: RuntimeMessageListener): Unsubscribe;
}

export interface RuntimeRpcRouter {
  handle(message: RuntimeMessage): Promise<RuntimeMessage>;
  register(method: RpcMethodDefinition): void;
  listMethods(): string[];
  onNotification?(listener: RuntimeMessageListener): Unsubscribe;
  notify?(message: RuntimeMessage): void;
}

export interface RpcContext {
  engine: PlcEngine;
  router: RuntimeRpcRouter;
}

export interface PrescanOptions {
  programId?: string;
}

export interface ResetOptions {
  retain?: boolean;
  resetClock?: boolean;
  mode?: ControllerMode;
}

export interface ScanOptions {
  suppressOutputs?: boolean;
  tasks?: string[];
}

export interface ScanResult {
  scanNumber: number;
  startedAt: number;
  endedAt: number;
  durationMs: number;
  tasks: Array<{ id: string; name: string; durationMs: number }>;
  faults: PlcFault[];
  diagnostics: Diagnostic[];
}

export interface ScanMetricsSnapshot {
  totalScans: number;
  totalDurationNs: number;
  averageDurationNs: number;
  minDurationNs: number;
  maxDurationNs: number;
  lastScan: {
    scanNumber: number;
    startedAt: number;
    endedAt: number;
    durationMs: number;
    durationNs: number;
    tasks: Array<{ id: string; name: string; durationMs: number }>;
  } | null;
  recent: Array<{ scanNumber: number; durationNs: number; startedAt: number }>;
}

export interface RunOptions {
  intervalMs?: number;
  maxScans?: number;
  signal?: { aborted: boolean };
}

export interface RunHandle {
  stop(reason?: string): void;
  readonly running: boolean;
  done: Promise<void>;
}

export interface RuntimeSnapshot {
  tags: TagSnapshot;
  faults: PlcFault[];
  diagnostics: Diagnostic[];
  instructionMemory: Record<string, Record<string, unknown>>;
  fbMemory: Record<string, Record<string, unknown>>;
  fbInstances: Record<string, Omit<FunctionBlockInstanceInspection, "memory">>;
  io: IoRuntimeSnapshot;
  scheduler: Record<string, unknown>;
  clock: ClockSnapshot;
  controller: { mode: ControllerMode; scanNumber: number; reason?: string };
  debug: DebugSnapshot;
  programs: LoadedProgram[];
  configuration?: PlcConfiguration;
}

export interface RuntimeInspection {
  stack: ExecutionFrame[];
  instructionMemory: Record<string, Record<string, unknown>>;
  functionBlockMemory: Record<string, Record<string, unknown>>;
  functionBlockInstances: FunctionBlockInstanceInspection[];
  scheduler: Array<{ task: PlcTask; lastRun?: number; pendingEvents: number; due: boolean }>;
}

export interface PlcEngine {
  readonly configuration: PlcConfigurationRuntime;
  readonly controller: ControllerRuntime;
  readonly tags: TagStore;
  readonly io: IoRuntime;
  readonly debugger: PlcDebugger;
  readonly plugins: PluginRegistry;
  readonly diagnostics: DiagnosticStore;
  readonly faults: FaultStore;
  readonly clock: PlcClock;
  loadProgram(source: ProgramSource): Promise<LoadedProgram>;
  replaceProgram(programId: string, source: ProgramSource): Promise<LoadedProgram>;
  unloadProgram(programId: string): Promise<void>;
  prescan(options?: PrescanOptions): Promise<void>;
  scan(options?: ScanOptions): Promise<ScanResult>;
  run(options?: RunOptions): Promise<RunHandle>;
  reset(options?: ResetOptions): Promise<void>;
  pause(reason?: string): void;
  resume(): void;
  stop(reason?: string): void;
  snapshot(options?: SnapshotOptions): RuntimeSnapshot;
  restore(snapshot: RuntimeSnapshot): void;
  inspect(): RuntimeInspection;
  triggerEventTask(taskIdOrName: string, count?: number): void;
  setTaskInhibited(taskIdOrName: string, inhibited: boolean): PlcTask;
  scanMetrics(): ScanMetricsSnapshot;
  resetScanMetrics(): void;
  attachTransport(transport: RuntimeTransport): Unsubscribe;
}

export interface ImperativeScanContext {
  tags: TagStore;
  memory: InstructionMemory;
  engine: PlcEngine;
  clock: PlcClock;
}

export type ImperativeScanFunction = (context: ImperativeScanContext) => void | Promise<void>;

export interface ProgramModule {
  default?: ProgramFactory | ProgramSource;
  program?: ProgramFactory | ProgramSource;
}

export type ProgramFactory = (
  builder: ProgramBuilderApi,
) => void | ProgramSource | Promise<void | ProgramSource>;

export interface ProgramBuilderApi {
  task(name: string, build: () => void): void;
  program(name: string, build: () => void): void;
  routine: RoutineBuilderEntry;
  rung(name: string, build: () => void): void;
  network(name: string, build: () => void): void;
  functionBlock(name: string, build: (api: FunctionBlockBuilderApi) => void): void;
  xic(path: TagPath): void;
  xio(path: TagPath): void;
  ons(path: TagPath, options?: { edge?: "rising" | "falling" | "both"; storage?: TagPath }): void;
  ote(path: TagPath): void;
  otl(path: TagPath): void;
  otu(path: TagPath): void;
  instruction<TArgs = unknown>(opcode: string, args: TArgs): void;
}

export interface RoutineBuilderEntry {
  (name: string, build: () => void): void;
  scan(name: string, scan: ImperativeScanFunction): void;
}

export interface FunctionBlockBuilderApi {
  input(name: string, type?: PlcDataTypeRef): void;
  output(name: string, type?: PlcDataTypeRef): void;
  inout(name: string, type?: PlcDataTypeRef): void;
  local(name: string, type?: PlcDataTypeRef, initialValue?: unknown): void;
  network(name: string, build: () => void): void;
  rung(name: string, build: () => void): void;
  xic(path: TagPath): void;
  xio(path: TagPath): void;
  ote(path: TagPath): void;
  instruction<TArgs = unknown>(opcode: string, args: TArgs): void;
}
