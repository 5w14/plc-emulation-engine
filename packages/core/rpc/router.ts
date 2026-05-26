import type {
  InstructionNode,
  PlcEngine,
  PlcNetwork,
  PlcRoutine,
  RpcContext,
  RpcMethodDefinition,
  RuntimeMessage,
  RuntimeMessageListener,
  RuntimeRpcRouter,
} from "../types";

export class DefaultRuntimeRpcRouter implements RuntimeRpcRouter {
  private methods = new Map<string, RpcMethodDefinition>();
  private notificationListeners = new Set<RuntimeMessageListener>();
  private tagSubscriptions = new Map<string, () => void>();
  private readonly context: RpcContext;

  constructor(engine: PlcEngine) {
    this.context = { engine, router: this };
    this.registerCoreMethods(engine);
  }

  async handle(message: RuntimeMessage): Promise<RuntimeMessage> {
    if (!message.method)
      return { id: message.id, error: { code: -32600, message: "Invalid request" } };
    const method =
      this.methods.get(message.method) ?? this.context.engine.plugins.getRpcMethod(message.method);
    if (!method)
      return {
        id: message.id,
        error: { code: -32601, message: `Unknown method: ${message.method}` },
      };
    try {
      return { id: message.id, result: await method.handler(this.context, message.params) };
    } catch (error) {
      return {
        id: message.id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      };
    }
  }

  register(method: RpcMethodDefinition): void {
    this.methods.set(method.name, method);
  }

  listMethods(): string[] {
    return Array.from(this.methods.keys()).sort();
  }

  onNotification(listener: RuntimeMessageListener) {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  notify(message: RuntimeMessage): void {
    for (const listener of this.notificationListeners) void listener(message);
  }

  private registerCoreMethods(engine: PlcEngine): void {
    const add = (name: string, handler: RpcMethodDefinition["handler"]): void =>
      this.register({ name, handler });
    add("engine.info", () => ({
      name: "@plc-emulation/core",
      browserSafe: true,
      methods: this.listMethods(),
    }));
    add("engine.mode.get", () => engine.controller.mode);
    add("engine.mode.set", (_context, params) => {
      engine.controller.setMode((params as { mode: typeof engine.controller.mode }).mode);
      return engine.controller.mode;
    });
    add("engine.loadProgram", (_context, params) =>
      engine.loadProgram((params as { source: Parameters<typeof engine.loadProgram>[0] }).source),
    );
    add("engine.replaceProgram", (_context, params) => {
      const typed = params as {
        programId: string;
        source: Parameters<typeof engine.loadProgram>[0];
      };
      return engine.replaceProgram(typed.programId, typed.source);
    });
    add("engine.unloadProgram", (_context, params) =>
      engine.unloadProgram((params as { programId: string }).programId),
    );
    add("engine.prescan", () => engine.prescan());
    add("engine.scan", (_context, params) =>
      engine.scan(params as Parameters<typeof engine.scan>[0]),
    );
    add("engine.run", (_context, params) => engine.run(params as Parameters<typeof engine.run>[0]));
    add("engine.reset", (_context, params) =>
      engine.reset(params as Parameters<typeof engine.reset>[0]),
    );
    add("engine.pause", (_context, params) =>
      engine.pause((params as { reason?: string } | undefined)?.reason),
    );
    add("engine.resume", () => engine.resume());
    add("engine.stop", (_context, params) =>
      engine.stop((params as { reason?: string } | undefined)?.reason),
    );
    add("engine.snapshot", () => engine.snapshot());
    add("engine.restore", (_context, params) =>
      engine.restore((params as { snapshot: Parameters<typeof engine.restore>[0] }).snapshot),
    );
    add("engine.inspect", () => engine.inspect());
    add(
      "tasks.list",
      () => engine.configuration.current?.resources.flatMap((resource) => resource.tasks) ?? [],
    );
    add("tasks.state", () => engine.inspect().scheduler);
    add("tasks.trigger", (_context, params) => {
      const typed = params as { taskId?: string; task?: string; count?: number };
      engine.triggerEventTask(typed.taskId ?? typed.task ?? "", typed.count);
      return true;
    });
    add("tasks.inhibit", (_context, params) => {
      const typed = params as { taskId?: string; task?: string; inhibited?: boolean };
      return engine.setTaskInhibited(typed.taskId ?? typed.task ?? "", typed.inhibited ?? true);
    });
    add("tasks.enable", (_context, params) => {
      const typed = params as { taskId?: string; task?: string };
      return engine.setTaskInhibited(typed.taskId ?? typed.task ?? "", false);
    });
    add("programs.list", () => engine.configuration.loadedPrograms);
    add("pous.list", () =>
      engine.configuration.loadedPrograms.flatMap((program) => program.source.pous ?? []),
    );
    add("routines.list", () =>
      engine.configuration.loadedPrograms.flatMap((program) => [
        ...(program.source.programs ?? []).flatMap((unit) => unit.routines ?? []),
        ...(program.source.pous ?? []).flatMap((pou) => pou.body.routines ?? []),
        ...(program.source.aois ?? []).flatMap((aoi) => aoi.routines),
      ]),
    );
    add("networks.list", () =>
      engine.configuration.loadedPrograms.flatMap((program) => [
        ...(program.source.programs ?? []).flatMap((unit) =>
          (unit.routines ?? []).flatMap((routine) => routine.networks ?? []),
        ),
        ...(program.source.pous ?? []).flatMap((pou) => [
          ...(pou.body.networks ?? []),
          ...(pou.body.routines ?? []).flatMap((routine) => routine.networks ?? []),
        ]),
        ...(program.source.aois ?? []).flatMap((aoi) =>
          aoi.routines.flatMap((routine) => routine.networks ?? []),
        ),
      ]),
    );
    add("rungs.list", () =>
      engine.configuration.loadedPrograms.flatMap((program) =>
        (program.source.programs ?? []).flatMap((unit) =>
          (unit.routines ?? []).flatMap((routine) => [
            ...(routine.rungs ?? []),
            ...(routine.networks ?? []).flatMap((network) => network.rungs ?? []),
          ]),
        ),
      ),
    );
    add("instructions.get", (_context, params) => {
      const id = (params as { id: string }).id;
      return allInstructions(engine).find((instruction) => instruction.id === id);
    });
    add("instructions.list", () => allInstructions(engine));
    add("tags.list", () => engine.tags.list());
    add("tags.read", (_context, params) => engine.tags.get((params as { path: string }).path));
    add("tags.write", (_context, params) => {
      const typed = params as { path: string; value: unknown };
      engine.tags.set(typed.path, typed.value);
      return true;
    });
    add("tags.declare", (_context, params) =>
      engine.tags.declare((params as { tag: Parameters<typeof engine.tags.declare>[0] }).tag),
    );
    add("tags.snapshot", () => engine.tags.snapshot());
    add("tags.restore", (_context, params) =>
      engine.tags.restore(
        (params as { snapshot: Parameters<typeof engine.tags.restore>[0] }).snapshot,
      ),
    );
    add("tags.force", (_context, params) => {
      const typed = params as { path: string; value: unknown };
      engine.tags.force(typed.path, typed.value);
      return true;
    });
    add("tags.unforce", (_context, params) => {
      engine.tags.unforce((params as { path: string }).path);
      return true;
    });
    add("tags.forces.list", () => engine.tags.listForces());
    add("tags.subscribe", (_context, params) => {
      const typed = params as { path: string };
      const subscriptionId = `tag-sub-${this.tagSubscriptions.size + 1}`;
      const unsubscribe = engine.tags.subscribe(typed.path, (event) => {
        this.notify({ method: "tags.change", params: { subscriptionId, event } });
      });
      this.tagSubscriptions.set(subscriptionId, unsubscribe);
      return { subscriptionId };
    });
    add("tags.unsubscribe", (_context, params) => {
      const subscriptionId = (params as { subscriptionId: string }).subscriptionId;
      this.tagSubscriptions.get(subscriptionId)?.();
      return this.tagSubscriptions.delete(subscriptionId);
    });
    add("io.inputs.read", (_context, params) =>
      engine.io.inputs.get((params as { address: string }).address),
    );
    add("io.inputs.write", (_context, params) => {
      const typed = params as { address: string; value: unknown };
      engine.io.inputs.set(typed.address, typed.value);
      return true;
    });
    add("io.inputs.force", (_context, params) => {
      const typed = params as { address: string; value: unknown; reason?: string };
      engine.io.inputs.force(typed.address, typed.value, typed.reason);
      return true;
    });
    add("io.inputs.unforce", (_context, params) => {
      engine.io.inputs.unforce((params as { address: string }).address);
      return true;
    });
    add("io.outputs.read", (_context, params) =>
      engine.io.outputs.get((params as { address: string }).address),
    );
    add("io.outputs.write", (_context, params) => {
      const typed = params as { address: string; value: unknown };
      engine.io.outputs.set(typed.address, typed.value);
      return true;
    });
    add("io.outputs.force", (_context, params) => {
      const typed = params as { address: string; value: unknown; reason?: string };
      engine.io.outputs.force(typed.address, typed.value, typed.reason);
      return true;
    });
    add("io.outputs.unforce", (_context, params) => {
      engine.io.outputs.unforce((params as { address: string }).address);
      return true;
    });
    add("io.memory.read", (_context, params) =>
      engine.io.memory.get((params as { address: string }).address),
    );
    add("io.memory.write", (_context, params) => {
      const typed = params as { address: string; value: unknown };
      engine.io.memory.set(typed.address, typed.value);
      return true;
    });
    add("io.memory.force", (_context, params) => {
      const typed = params as { address: string; value: unknown; reason?: string };
      engine.io.memory.force(typed.address, typed.value, typed.reason);
      return true;
    });
    add("io.memory.unforce", (_context, params) => {
      engine.io.memory.unforce((params as { address: string }).address);
      return true;
    });
    add("io.forces.list", () => ({
      inputs: engine.io.inputs.listForces(),
      outputs: engine.io.outputs.listForces(),
      memory: engine.io.memory.listForces(),
    }));
    add("io.snapshot", () => engine.io.snapshot());
    add("io.restore", (_context, params) => {
      engine.io.restore((params as { snapshot: Parameters<typeof engine.io.restore>[0] }).snapshot);
      return true;
    });
    add("io.devices.list", () => engine.io.devices.list());
    add("debug.breakpoints.add", (_context, params) =>
      engine.debugger.addBreakpoint(params as Parameters<typeof engine.debugger.addBreakpoint>[0]),
    );
    add("debug.breakpoints.remove", (_context, params) =>
      engine.debugger.removeBreakpoint((params as { id: string }).id),
    );
    add("debug.breakpoints.list", () => engine.debugger.listBreakpoints());
    add("debug.step", (_context, params) =>
      engine.debugger.step((params as { mode: Parameters<typeof engine.debugger.step>[0] }).mode),
    );
    add("debug.continue", () => engine.debugger.continue());
    add("debug.trace.add", (_context, params) =>
      engine.debugger.trace(params as Parameters<typeof engine.debugger.trace>[0]),
    );
    add("debug.trace.remove", (_context, params) =>
      engine.debugger.removeTrace((params as { id: string }).id),
    );
    add("debug.watch.add", (_context, params) =>
      engine.debugger.addWatch(params as Parameters<typeof engine.debugger.addWatch>[0]),
    );
    add("debug.watch.remove", (_context, params) =>
      engine.debugger.removeWatch((params as { id: string }).id),
    );
    add("debug.inspect", () => engine.inspect());
    add("faults.list", () => engine.faults.list());
    add("faults.clear", (_context, params) => {
      engine.faults.clear((params as { id?: string } | undefined)?.id);
      return true;
    });
    add("diagnostics.list", () => engine.diagnostics.list());
    add("plugins.list", () => engine.plugins.list());
    add("metrics.scan", () => engine.scanMetrics());
    add("metrics.scan.reset", () => {
      engine.resetScanMetrics();
      return true;
    });
  }
}

export function createRuntimeRpcRouter(engine: PlcEngine): RuntimeRpcRouter {
  return new DefaultRuntimeRpcRouter(engine);
}

function collectInstructions(routines: PlcRoutine[]): InstructionNode[] {
  return routines.flatMap((routine) => [
    ...(routine.rungs ?? []).flatMap((rung) => flattenInstructions(rung.instructions)),
    ...(routine.networks ?? []).flatMap((network) => collectNetworkInstructions(network)),
  ]);
}

function allInstructions(engine: PlcEngine): InstructionNode[] {
  return engine.configuration.loadedPrograms.flatMap((loaded) =>
    collectInstructions([
      ...(loaded.source.programs ?? []).flatMap((unit) => unit.routines ?? []),
      ...(loaded.source.pous ?? []).flatMap((pou) => [
        ...(pou.body.routines ?? []),
        {
          id: `${pou.id}:body`,
          name: pou.name,
          language: pou.body.language,
          networks: pou.body.networks,
        } as PlcRoutine,
      ]),
      ...(loaded.source.aois ?? []).flatMap((aoi) => aoi.routines),
    ]),
  );
}

function collectNetworkInstructions(network: PlcNetwork): InstructionNode[] {
  return [
    ...(network.instructions ?? []).flatMap((instruction) => flattenInstructions([instruction])),
    ...(network.rungs ?? []).flatMap((rung) => flattenInstructions(rung.instructions)),
  ];
}

function flattenInstructions(instructions: InstructionNode[]): InstructionNode[] {
  return instructions.flatMap((instruction) => [
    instruction,
    ...flattenInstructions(instruction.children ?? []),
  ]);
}
