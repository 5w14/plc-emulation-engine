import { expect, test } from "bun:test";

test("core source has no Node, Bun server, WebSocket server, L5X, or XML parser imports", async () => {
  const files = [
    "packages/core/index.ts",
    "packages/core/types.ts",
    "packages/core/internal.ts",
    "packages/core/engine/engine.ts",
    "packages/core/engine/clock.ts",
    "packages/core/engine/memory.ts",
    "packages/core/authoring/js.ts",
    "packages/core/debug/debugger.ts",
    "packages/core/faults/stores.ts",
    "packages/core/instructions/builtin.ts",
    "packages/core/io/runtime.ts",
    "packages/core/plugins/registry.ts",
    "packages/core/rpc/router.ts",
    "packages/core/tags/store.ts",
  ];
  const source = (await Promise.all(files.map((file) => Bun.file(file).text()))).join("\n");

  expect(source).not.toMatch(/from\s+["'](?:fs|path|net|http|https|ws|node:|bun:)/);
  expect(source).not.toMatch(
    /parseL5X|loadL5X|parsePLCopenXml|XMLParser|WebSocketServer|Bun\.serve/,
  );
});

test("engine can be constructed in browser-like and worker-like global shapes", async () => {
  const module = await import("@plc-emulation/core");
  const browserEngine = module.createPlcEngine({ target: "browser" });
  const workerEngine = module.createPlcEngine({ target: "worker" });

  expect(browserEngine.controller.mode).toBe("test");
  expect(workerEngine.controller.mode).toBe("test");
});

test("core entry bundles for browser target without Node polyfills", async () => {
  const result = await Bun.build({
    entrypoints: ["./packages/core/index.ts"],
    target: "browser",
    format: "esm",
    minify: false,
  });

  expect(result.success).toBe(true);
  expect(result.logs).toHaveLength(0);
  const bundled = await result.outputs[0]?.text();
  expect(bundled).toBeDefined();
  expect(bundled ?? "").not.toMatch(/node:|require\(["']fs|Bun\.serve|WebSocketServer/);
});
