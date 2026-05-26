import type {
  DebugSink,
  InstructionDefinition,
  LanguagePlugin,
  PlcPlugin,
  PluginRegistry,
  PluginRuntimeTarget,
  PluginSetupContext,
  RpcMethodDefinition,
} from "../types";

export class DefaultPluginRegistry implements PluginRegistry {
  private plugins = new Map<string, PlcPlugin>();
  private instructions = new Map<string, InstructionDefinition>();
  private languages = new Map<string, LanguagePlugin>();
  private rpcMethods = new Map<string, RpcMethodDefinition>();
  private debugSinks = new Map<string, DebugSink>();
  private setupContext?: PluginSetupContext;

  constructor(private readonly target: PluginRuntimeTarget = "core") {}

  async register(
    plugin: PlcPlugin,
    options: { overrideInstructions?: boolean } = {},
  ): Promise<void> {
    if (plugin.target && !plugin.target.includes("core") && !plugin.target.includes(this.target)) {
      throw new Error(`Plugin ${plugin.id} is incompatible with ${this.target}`);
    }
    if (this.plugins.has(plugin.id)) throw new Error(`Duplicate plugin: ${plugin.id}`);
    for (const instruction of plugin.instructions ?? []) {
      if (this.instructions.has(instruction.opcode) && !options.overrideInstructions)
        throw new Error(`Duplicate instruction opcode: ${instruction.opcode}`);
      this.instructions.set(instruction.opcode, instruction);
    }
    for (const language of plugin.languages ?? []) this.languages.set(language.language, language);
    for (const method of plugin.rpcMethods ?? []) this.rpcMethods.set(method.name, method);
    for (const sink of plugin.debugSinks ?? []) this.debugSinks.set(sink.id, sink);
    this.plugins.set(plugin.id, plugin);
    if (this.setupContext) {
      for (const device of plugin.devices ?? [])
        this.setupContext.engine.io.attachDevice(device.create());
    }
    if (plugin.setup) {
      if (!this.setupContext) throw new Error(`Plugin ${plugin.id} requires setup context`);
      await plugin.setup(this.setupContext);
    }
  }

  list(): PlcPlugin[] {
    return Array.from(this.plugins.values());
  }

  getInstruction(opcode: string): InstructionDefinition | undefined {
    return this.instructions.get(opcode);
  }

  getLanguage(language: string): LanguagePlugin | undefined {
    return this.languages.get(language);
  }

  getRpcMethod(name: string): RpcMethodDefinition | undefined {
    return this.rpcMethods.get(name);
  }

  getDebugSinks(): DebugSink[] {
    return Array.from(this.debugSinks.values());
  }

  setSetupContext(context: PluginSetupContext): void {
    this.setupContext = context;
  }
}
