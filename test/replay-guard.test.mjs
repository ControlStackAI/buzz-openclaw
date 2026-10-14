import assert from "node:assert/strict";
import test from "node:test";

import { createBuzzReplayGuard } from "../src/replay-guard.js";

function fakeClaimableDedupe() {
  const committed = new Set();
  const active = new Map();
  return {
    committed,
    released: [],
    cleared: false,
    async claim(key, { namespace }) {
      const scoped = `${namespace}:${key}`;
      if (committed.has(scoped)) return { kind: "duplicate" };
      if (active.has(scoped)) return { kind: "inflight", pending: active.get(scoped) };
      let resolve;
      const pending = new Promise((r) => (resolve = r));
      active.set(scoped, pending);
      active.set(`${scoped}:resolve`, resolve);
      return { kind: "claimed" };
    },
    async commit(key, { namespace }) {
      const scoped = `${namespace}:${key}`;
      committed.add(scoped);
      active.get(`${scoped}:resolve`)?.(true);
      active.delete(scoped);
      active.delete(`${scoped}:resolve`);
      return true;
    },
    release(key, { namespace, error }) {
      const scoped = `${namespace}:${key}`;
      this.released.push({ scoped, error });
      active.get(`${scoped}:resolve`)?.(false);
      active.delete(scoped);
      active.delete(`${scoped}:resolve`);
    },
    clearMemory() {
      this.cleared = true;
    },
  };
}

test("successful inbound is committed and a reconnect replay is skipped", async () => {
  const dedupe = fakeClaimableDedupe();
  const guard = createBuzzReplayGuard({ dedupe, accountId: "main" });
  let calls = 0;
  assert.equal((await guard.process({ id: "evt-1" }, async () => ++calls)).kind, "processed");
  assert.equal((await guard.process({ id: "evt-1" }, async () => ++calls)).kind, "duplicate");
  assert.equal(calls, 1);
  assert.ok(dedupe.committed.has("main:evt-1"));
});

test("failed inbound is released so a reconnect can retry it", async () => {
  const dedupe = fakeClaimableDedupe();
  const guard = createBuzzReplayGuard({ dedupe, accountId: "main" });
  await assert.rejects(guard.process({ id: "evt-2" }, async () => { throw new Error("dispatch failed"); }));
  assert.equal(dedupe.released.length, 1);
  assert.equal((await guard.process({ id: "evt-2" }, async () => "retried")).kind, "processed");
});

test("concurrent duplicate does not execute a second handler", async () => {
  const dedupe = fakeClaimableDedupe();
  const guard = createBuzzReplayGuard({ dedupe, accountId: "main" });
  let releaseFirst;
  const first = guard.process({ id: "evt-3" }, () => new Promise((r) => (releaseFirst = r)));
  await new Promise((r) => setImmediate(r));
  let duplicateCalls = 0;
  const second = await guard.process({ id: "evt-3" }, async () => ++duplicateCalls);
  assert.equal(second.kind, "inflight");
  assert.equal(duplicateCalls, 0);
  releaseFirst("done");
  await first;
  assert.equal(await second.pending, true);
});

test("shutdown clears only process-local replay memory", () => {
  const dedupe = fakeClaimableDedupe();
  createBuzzReplayGuard({ dedupe, accountId: "main" }).clearMemory();
  assert.equal(dedupe.cleared, true);
});
