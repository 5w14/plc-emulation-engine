#!/usr/bin/env bun
import { createPlcEngine, type PlcEngine, type ProgramSource } from "@plc-emulation/core";
import { startBunRuntimeServer } from "../../server/src/index";

export interface CliIo {
  stdout(message: string): void;
  stderr(message: string): void;
  readText(path: string): Promise<string>;
}

export interface CliResult {
  exitCode: number;
  engine?: PlcEngine;
  value?: unknown;
}

export async function runCli(argv: string[], io: CliIo = defaultIo): Promise<CliResult> {
  const [command = "help", ...args] = argv;
  try {
    if (command === "help" || command === "--help" || command === "-h") {
      io.stdout(helpText());
      return { exitCode: 0 };
    }
    if (command === "info") {
      io.stdout(
        JSON.stringify({ package: "@plc-emulation/cli", core: "@plc-emulation/core" }, null, 2),
      );
      return { exitCode: 0 };
    }

    const options = parseArgs(args);
    const engine = createPlcEngine();
    const source = options.program ? await loadProgramSource(options.program, io) : undefined;
    if (source) await engine.loadProgram(source);

    if (command === "scan") {
      const scans = Number(options.scans ?? "1");
      let result: unknown;
      for (let index = 0; index < scans; index += 1) result = await engine.scan();
      io.stdout(JSON.stringify({ result, tags: engine.tags.snapshot().values }, null, 2));
      return { exitCode: 0, engine, value: result };
    }

    if (command === "run") {
      const handle = await engine.run({
        maxScans: Number(options.scans ?? "1"),
        intervalMs: Number(options.interval ?? "0"),
      });
      await handle.done;
      io.stdout(
        JSON.stringify(
          { scanNumber: engine.controller.scanNumber, tags: engine.tags.snapshot().values },
          null,
          2,
        ),
      );
      return { exitCode: 0, engine };
    }

    if (command === "tag:get") {
      requireProgram(options);
      const path = requireOption(options, "tag");
      const value = engine.tags.get(path);
      io.stdout(JSON.stringify({ path, value }, null, 2));
      return { exitCode: 0, engine, value };
    }

    if (command === "tag:set") {
      requireProgram(options);
      const path = requireOption(options, "tag");
      const value = parseJsonValue(requireOption(options, "value"));
      engine.tags.set(path, value);
      io.stdout(JSON.stringify({ path, value: engine.tags.get(path) }, null, 2));
      return { exitCode: 0, engine, value };
    }

    if (command === "snapshot") {
      requireProgram(options);
      const snapshot = engine.snapshot();
      io.stdout(JSON.stringify(snapshot, null, 2));
      return { exitCode: 0, engine, value: snapshot };
    }

    if (command === "serve") {
      requireProgram(options);
      const server = startBunRuntimeServer({
        engine,
        port: Number(options.port ?? "0"),
        hostname: options.host,
      });

      // Start EtherNet/IP CIP server if port is specified
      let eipHandle: { url: string; stop(): Promise<void> } | undefined;
      if (options["eip-port"] !== undefined) {
        const { startEipServer } = await import("../../eip/src/index.ts");
        eipHandle = startEipServer({
          engine,
          port: Number(options["eip-port"]) || 44818,
          hostname: options["eip-host"] ?? "0.0.0.0",
          debug: options["eip-debug"] === "true",
        });
      }

      io.stdout(JSON.stringify({ url: server.url, eipUrl: eipHandle?.url }, null, 2));
      await new Promise<void>(() => undefined);
      return { exitCode: 0, engine, value: { server, eip: eipHandle } };
    }

    throw new Error(`Unknown command: ${command}`);
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return { exitCode: 1 };
  }
}

export async function loadProgramSource(
  path: string,
  io: CliIo = defaultIo,
): Promise<ProgramSource> {
  return JSON.parse(await io.readText(path)) as ProgramSource;
}

function parseArgs(args: string[]): Record<string, string | undefined> {
  const output: Record<string, string | undefined> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg?.startsWith("--")) continue;
    const key = arg.slice(2);
    const inline = key.split("=");
    if (inline.length === 2 && inline[0]) output[inline[0]] = inline[1];
    else output[key] = args[index + 1]?.startsWith("--") ? "true" : args[++index];
  }
  return output;
}

function requireProgram(options: Record<string, string | undefined>): void {
  if (!options.program) throw new Error("--program is required");
}

function requireOption(options: Record<string, string | undefined>, key: string): string {
  const value = options[key];
  if (value === undefined) throw new Error(`--${key} is required`);
  return value;
}

function parseJsonValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function helpText(): string {
  return [
    "plc-emulation <command> [options]",
    "",
    "Commands:",
    "  info",
    "  scan --program program.json [--scans 1]",
    "  run --program program.json [--scans 1] [--interval 0]",
    "  tag:get --program program.json --tag MotorRunning",
    "  tag:set --program program.json --tag StartPB --value true",
    "  snapshot --program program.json",
    "  serve --program program.json [--host 127.0.0.1] [--port 0] [--eip-port 44818] [--eip-host 0.0.0.0]",
  ].join("\n");
}

const defaultIo: CliIo = {
  stdout(message) {
    console.log(message);
  },
  stderr(message) {
    console.error(message);
  },
  async readText(path) {
    if (path === "-") {
      const chunks: Uint8Array[] = [];
      for await (const chunk of Bun.stdin.stream()) chunks.push(chunk);
      return new TextDecoder().decode(Buffer.concat(chunks));
    }
    return Bun.file(path).text();
  },
};

if (import.meta.main) {
  const result = await runCli(Bun.argv.slice(2));
  if (result.exitCode !== 0) process.exit(result.exitCode);
}
