// Constraint 1 probe: the plugin's inbound peer shape routes through the REAL
// core resolveAgentRoute (not a mock) — template: the Slack peer-binding
// verification of 2026-07-30 (/tmp/p0-peer-binding-test.mjs).
import test from "node:test";
import assert from "node:assert/strict";

import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { buildBuzzRoutePeer } from "../src/channel.js";

const CONV = "0198f1c2-aaaa-bbbb-cccc-0123456789ab";
const OTHER = "0198f1c2-dddd-eeee-ffff-0123456789ab";

function cfgWith(bindings) {
  return {
    agents: {
      defaults: {},
      list: [{ id: "main", default: true }, { id: "coder" }],
    },
    bindings,
    channels: { buzz: {} },
  };
}

const peerBinding = {
  agentId: "coder",
  match: { channel: "buzz", accountId: "main", peer: { kind: "channel", id: CONV } },
};
const accountBinding = { agentId: "main", match: { channel: "buzz", accountId: "main" } };

test("peer-bound Buzz conversation routes to the peer-bound agent", () => {
  const route = resolveAgentRoute({
    cfg: cfgWith([peerBinding, accountBinding]),
    channel: "buzz",
    accountId: "main",
    peer: buildBuzzRoutePeer({ conversationId: CONV }),
  });
  assert.equal(route.agentId, "coder");
  assert.equal(route.matchedBy, "binding.peer");
});

test("unbound conversation falls through to the account tier", () => {
  const route = resolveAgentRoute({
    cfg: cfgWith([peerBinding, accountBinding]),
    channel: "buzz",
    accountId: "main",
    peer: buildBuzzRoutePeer({ conversationId: OTHER }),
  });
  assert.equal(route.agentId, "main");
  assert.equal(route.matchedBy, "binding.account");
});

test("ids compare case-sensitively — uppercased id must NOT match", () => {
  const route = resolveAgentRoute({
    cfg: cfgWith([peerBinding, accountBinding]),
    channel: "buzz",
    accountId: "main",
    peer: buildBuzzRoutePeer({ conversationId: CONV.toUpperCase() }),
  });
  assert.equal(route.agentId, "main", "case-mismatched peer id fell through to account tier as expected");
});

test("plugin peer form is verbatim (trim only), kind channel", () => {
  const peer = buildBuzzRoutePeer({ conversationId: `  ${CONV}  ` });
  assert.deepEqual(peer, { kind: "channel", id: CONV });
});

test("session key from an unbound route keeps the buzz channel grammar", () => {
  const route = resolveAgentRoute({
    cfg: cfgWith([accountBinding]),
    channel: "buzz",
    accountId: "main",
    peer: buildBuzzRoutePeer({ conversationId: CONV }),
  });
  assert.equal(route.sessionKey, `agent:main:buzz:channel:${CONV}`);
});
