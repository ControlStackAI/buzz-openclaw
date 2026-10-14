import test from "node:test";
import assert from "node:assert/strict";
import plugin from "../index.js";
import setup from "../setup-entry.js";
import { getBuzzRuntime } from "../runtime.js";

test("plugin registers its channel against the actual SDK", () => {
  const runtime = { synthetic: true };
  let registered;
  plugin.register({ runtime, registerChannel: (channel) => { registered = channel; } });
  assert.equal(registered.plugin.id, "buzz");
  assert.equal(getBuzzRuntime(), runtime);
});

test("setup entry loads through the SDK export", () => {
  assert.ok(setup);
});
