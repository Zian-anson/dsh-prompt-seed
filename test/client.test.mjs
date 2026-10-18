import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import vm from "node:vm";

test("client module: declares and injects session services", async () => {
  const source = await readFile(new URL("../lib/client.js", import.meta.url), "utf8");
  let loaded;
  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(record) { loaded = record; },
      },
    },
    console,
  };
  vm.runInNewContext(source, sandbox);
  assert.equal(loaded.id, "dsh-prompt-seed");
  assert.equal(loaded.factory(() => ({ createElement: () => null })).inject.join(","), "slots,sessions,uiWorkspace");

  let dependencies;
  let mounted = false;
  const ctx = {
    effect(fn) { fn(); return () => {}; },
    inject(deps, callback) {
      dependencies = deps;
      callback({
        slots: {
          inject() { mounted = true; },
          register() { return () => {}; },
        },
        sessions: { create: async () => ({ sessionId: "s1" }), using: async () => ({ ok: true }) },
        uiWorkspace: { openSession() {} },
      });
    },
  };
  loaded.factory(() => ({ createElement: () => null })).apply(ctx);
  assert.equal(dependencies.join(","), "slots,sessions,uiWorkspace");
  assert.equal(mounted, true);
  assert.match(source, /data-client-version/);
  assert.match(source, /CLIENT_VERSION = '0\.19\.2'/);
});
