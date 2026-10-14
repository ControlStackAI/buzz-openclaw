// Constraint 2 probe: a bound conversation addresses the DECLARED project
// session key (agent:<id>:project:<slug> from the projects index) instead of
// minting agent:<id>:buzz:channel:<conv>. Runs the plugin's production
// resolveBuzzSessionKey against the real resolveAgentRoute.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { buildBuzzRoutePeer, resolveBuzzSessionKey } from "../src/channel.js";
import { clearProjectsIndexCacheForTest } from "../src/session-map.js";

const CONV = "0198f1c2-1111-2222-3333-0123456789ab";
const UNBOUND = "0198f1c2-4444-5555-6666-0123456789ab";

// Fixture mirrors ~/.openclaw/projects/index.json (csa.projects schemaVersion 1),
// with a buzz channel entry the way the generator would emit it.
const fixtureIndex = [
  {
    key: "nix-openclaw",
    value: {
      project: "nix-openclaw",
      schemaVersion: 1,
      sessionKey: "agent:main:project:nix-openclaw",
      channels: [
        { platform: "slack", id: "C0BHP68CDL5", account: "default" },
        { platform: "buzz", id: CONV, account: "main" },
      ],
    },
  },
];

function writeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buzz-index-"));
  const file = path.join(dir, "index.json");
  fs.writeFileSync(file, JSON.stringify(fixtureIndex));
  return file;
}

function makeCfg({ indexPath, conversationEntry }) {
  return {
    agents: { defaults: {}, list: [{ id: "main", default: true }] },
    bindings: [{ agentId: "main", match: { channel: "buzz", accountId: "main" } }],
    channels: {
      buzz: {
        projectsIndexPath: indexPath,
        allowFrom: ["a".repeat(64)],
        channels: { [CONV]: conversationEntry ?? { allow: true }, [UNBOUND]: { allow: true } },
      },
    },
  };
}

function routeFor(cfg, conversationId) {
  return resolveAgentRoute({
    cfg,
    channel: "buzz",
    accountId: "main",
    peer: buildBuzzRoutePeer({ conversationId }),
  });
}

test("bound conversation lands on agent:main:project:<slug> via the projects index", () => {
  clearProjectsIndexCacheForTest();
  const cfg = makeCfg({ indexPath: writeFixture() });
  const route = routeFor(cfg, CONV);
  const { sessionKey, declaredSource } = resolveBuzzSessionKey({ cfg, route, conversationId: CONV });
  assert.equal(sessionKey, "agent:main:project:nix-openclaw");
  assert.equal(declaredSource, "index:nix-openclaw");
});

test("explicit channels.<conv>.sessionKey wins over the index", () => {
  clearProjectsIndexCacheForTest();
  const cfg = makeCfg({
    indexPath: writeFixture(),
    conversationEntry: { allow: true, sessionKey: "agent:main:project:buzz" },
  });
  const route = routeFor(cfg, CONV);
  const { sessionKey, declaredSource } = resolveBuzzSessionKey({ cfg, route, conversationId: CONV });
  assert.equal(sessionKey, "agent:main:project:buzz");
  assert.equal(declaredSource, "config.sessionKey");
});

test("channels.<conv>.project slug resolves through the index record", () => {
  clearProjectsIndexCacheForTest();
  const cfg = makeCfg({
    indexPath: writeFixture(),
    conversationEntry: { allow: true, project: "nix-openclaw" },
  });
  const route = routeFor(cfg, CONV);
  const { sessionKey, declaredSource } = resolveBuzzSessionKey({ cfg, route, conversationId: CONV });
  assert.equal(sessionKey, "agent:main:project:nix-openclaw");
  assert.equal(declaredSource, "config.project:nix-openclaw");
});

test("project session preserves the routed agent identity", () => {
  clearProjectsIndexCacheForTest();
  const cfg = makeCfg({
    indexPath: writeFixture(),
    conversationEntry: { allow: true, project: "nix-openclaw" },
  });
  cfg.agents.list.push({ id: "coder" });
  cfg.bindings = [{ agentId: "coder", match: { channel: "buzz", accountId: "coder" } }];
  const route = resolveAgentRoute({
    cfg,
    channel: "buzz",
    accountId: "coder",
    peer: buildBuzzRoutePeer({ conversationId: CONV }),
  });
  const { sessionKey, declaredSource } = resolveBuzzSessionKey({ cfg, route, conversationId: CONV });
  assert.equal(route.agentId, "coder");
  assert.equal(sessionKey, "agent:coder:project:nix-openclaw");
  assert.equal(declaredSource, "config.project:nix-openclaw");
});

test("unbound conversation falls back to the buzz channel session key", () => {
  clearProjectsIndexCacheForTest();
  const cfg = makeCfg({ indexPath: writeFixture() });
  const route = routeFor(cfg, UNBOUND);
  const { sessionKey, declaredSource } = resolveBuzzSessionKey({ cfg, route, conversationId: UNBOUND });
  assert.equal(sessionKey, `agent:main:buzz:channel:${UNBOUND}`);
  assert.equal(declaredSource, undefined);
});

test("invalid declared key is rejected and falls back", () => {
  clearProjectsIndexCacheForTest();
  const cfg = makeCfg({
    indexPath: writeFixture(),
    conversationEntry: { allow: true, sessionKey: "not-a-session-key" },
  });
  // Invalid explicit key is ignored; conversation is still index-bound, so the
  // index mapping applies.
  const route = routeFor(cfg, CONV);
  const { sessionKey } = resolveBuzzSessionKey({ cfg, route, conversationId: CONV });
  assert.equal(sessionKey, "agent:main:project:nix-openclaw");
});

test("missing index file degrades to route session key", () => {
  clearProjectsIndexCacheForTest();
  const cfg = makeCfg({ indexPath: "/nonexistent/index.json" });
  const route = routeFor(cfg, CONV);
  const { sessionKey } = resolveBuzzSessionKey({ cfg, route, conversationId: CONV });
  assert.equal(sessionKey, `agent:main:buzz:channel:${CONV}`);
});
