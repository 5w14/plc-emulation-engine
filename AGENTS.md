# AGENTS.md

This repo is a TypeScript/Bun workspace for PLC emulation packages.

## Packages

- `packages/core`: `@plc-emulation/core`
  Browser-safe PLC runtime core: IR types, tag store, scan engine, scheduler,
  debugger, faults, plugins, I/O image, JS authoring, and environment-neutral RPC.
- `packages/server`: `@plc-emulation/server`
  Server adapters for core RPC, including HTTP JSON-RPC and Bun WebSocket wiring.
- `packages/client`: `@plc-emulation/client`
  Runtime RPC client helpers, memory transport, and WebSocket transport.
- `packages/cli`: `@plc-emulation/cli`
  Bun CLI wrapper for loading IR JSON, scanning/running, tag operations,
  snapshots, and starting the server adapter.
- `packages/protocols`: `@plc-emulation/protocols`
  Protocol/device facades over core APIs: Modbus-style device, MQTT tag bridge,
  EtherNet/IP-style tag service, OPC UA-style address-space facade.

## Hard Boundaries

- Core must stay browser-compatible.
- Core must not import `fs`, `path`, `net`, `http`, `https`, `ws`, `node:*`,
  Bun server APIs, WebSocket server libraries, L5X parsers, or XML parsers.
- L5X and PLCopen XML importers are separate future packages that output
  core `ProgramSource`; do not parse them in core.
- Server, CLI, protocol, and client-specific host APIs belong in `packages/*`,
  not in `src/`.
- Editor workflows, online edit authoring, diagram editing, and round-tripping
  are outside this repo’s current runtime-core scope.

## Keeping It Working

- Use `bun run check` before finishing changes.
- Core browser safety is covered by `tests/browser-boundary.test.ts`.
- Package behavior is covered by `tests/packages/*`.
- Add tests for new runtime behavior, especially scan execution, snapshots,
  debug events, RPC methods, plugin behavior, and package boundaries.
- Preserve environment-neutral APIs in core; expose host integrations via
  `RuntimeTransport`, `RuntimeRpcRouter`, `PluginRegistry`, `IoRuntime`, and
  `TagStore`.
- Keep protocol adapters dependency-light and layered over core interfaces.
- Keep package imports local and explicit; avoid adding server dependencies to core.
- If adding instructions, register them through plugins and include validate,
  prescan/postscan/reset hooks where relevant.
- If adding data model fields, ensure snapshots, restore, debug/RPC inspection,
  and tests are updated together.
