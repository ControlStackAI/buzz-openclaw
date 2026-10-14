// End-to-end inbound probe: a synthetic Buzz kind:9 event runs through the
// plugin's PRODUCTION deliverInbound with the REAL core resolveAgentRoute, and
// the dispatched MsgContext lands on the declared project session key.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { __testing } from "../src/channel.js";
import { clearProjectsIndexCacheForTest } from "../src/session-map.js";

const CONV = "0198f1c2-9999-aaaa-bbbb-0123456789ab";

function writeFixtureIndex() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "buzz-inbound-"));
  const file = path.join(dir, "index.json");
  fs.writeFileSync(
    file,
    JSON.stringify([
      {
        key: "buzz",
        value: {
          project: "buzz",
          schemaVersion: 1,
          sessionKey: "agent:main:project:buzz",
          channels: [{ platform: "buzz", id: CONV, account: "main" }],
        },
      },
    ]),
  );
  return file;
}

function makeFakeChannelRuntime(captured) {
  return {
    routing: { resolveAgentRoute }, // the REAL router
    session: {
      resolveStorePath: (_store, { agentId }) => `/tmp/fake-store/${agentId}`,
      readSessionUpdatedAt: () => undefined,
      recordSessionMetaFromInbound: async (params) => {
        captured.recordedSessionKey = params.sessionKey;
      },
    },
    reply: {
      resolveEnvelopeFormatOptions: () => ({}),
      formatAgentEnvelope: ({ body }) => body,
      finalizeInboundContext: (ctx) => ctx,
      dispatchReplyWithBufferedBlockDispatcher: async ({ ctx, dispatcherOptions }) => {
        captured.dispatchedCtx = ctx;
        await dispatcherOptions.deliver({ text: "ack from agent" });
      },
    },
  };
}

test("synthetic kind:9 event lands in agent:main:project:buzz with peer routing + reply threading", async () => {
  clearProjectsIndexCacheForTest();
  const humanSk = generateSecretKey();
  const humanPk = getPublicKey(humanSk);
  const agentSk = generateSecretKey();
  const agentPk = getPublicKey(agentSk);

  const cfg = {
    agents: { defaults: {}, list: [{ id: "main", default: true }] },
    bindings: [{ agentId: "main", match: { channel: "buzz", accountId: "main" } }],
    channels: {
      buzz: {
        projectsIndexPath: writeFixtureIndex(),
        allowFrom: [humanPk],
        channels: { [CONV]: { allow: true } },
      },
    },
  };

  const event = finalizeEvent(
    {
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      content: "status update please",
      tags: [["h", CONV], ["p", agentPk]], // explicit mention of the agent
    },
    humanSk,
  );

  const published = [];
  const seenIds = new Set();
  const client = {
    pubkey: agentPk,
    ownEventIds: { has: (id) => seenIds.has(id) },
    publishChannelMessage: async (msg) => {
      published.push(msg);
      return { id: "reply-id" };
    },
    publishTyping: async () => {},
  };
  const captured = {};
  await __testing.deliverInbound({
    event,
    account: { accountId: "main", name: "ALINA" },
    client,
    channelRuntime: makeFakeChannelRuntime(captured),
    getCfg: () => cfg,
    log: undefined,
    fleet: new Set(),
  });

  // Constraint 2, end to end: the dispatched context addresses the declared
  // project session, not agent:main:buzz:channel:<conv>.
  assert.equal(captured.dispatchedCtx.SessionKey, "agent:main:project:buzz");
  assert.equal(captured.recordedSessionKey, "agent:main:project:buzz");
  assert.equal(captured.dispatchedCtx.WasMentioned, true);
  assert.equal(captured.dispatchedCtx.To, `buzz:${CONV}`);
  // Reply went out as kind:9 into the same conversation. Default replyMode is
  // "channel", so a top-level message is answered FLAT — no e-tags. That is
  // what keeps this key on the project session: an e-tagged answer would open
  // a thread, which seeds a `:thread:` session and strands project history.
  assert.equal(published.length, 1);
  assert.equal(published[0].conversationId, CONV);
  assert.deepEqual(published[0].tags.filter((t) => t[0] === "e"), []);
  assert.equal(published[0].tags.some((t) => t[0] === "p"), false);
});

test("unlisted author is dropped before routing (author gate)", async () => {
  clearProjectsIndexCacheForTest();
  const strangerSk = generateSecretKey();
  const agentSk = generateSecretKey();
  const agentPk = getPublicKey(agentSk);
  const cfg = {
    agents: { defaults: {}, list: [{ id: "main", default: true }] },
    bindings: [{ agentId: "main", match: { channel: "buzz", accountId: "main" } }],
    channels: {
      buzz: {
        allowFrom: ["ab".repeat(32)], // not the stranger
        channels: { [CONV]: { allow: true } },
      },
    },
  };
  const event = finalizeEvent(
    { kind: 9, created_at: Math.floor(Date.now() / 1000), content: "hi", tags: [["h", CONV], ["p", agentPk]] },
    strangerSk,
  );
  const captured = {};
  await __testing.deliverInbound({
    event,
    account: { accountId: "main" },
    client: { pubkey: agentPk, ownEventIds: { has: () => false }, publishChannelMessage: async () => ({ id: "x" }), publishTyping: async () => {} },
    channelRuntime: makeFakeChannelRuntime(captured),
    getCfg: () => cfg,
    log: undefined,
    fleet: new Set(),
  });
  assert.equal(captured.dispatchedCtx, undefined, "stranger must not reach dispatch");
});

test("un-mentioned channel chatter is skipped; thread reply to the bot is not", async () => {
  clearProjectsIndexCacheForTest();
  const humanSk = generateSecretKey();
  const humanPk = getPublicKey(humanSk);
  const agentSk = generateSecretKey();
  const agentPk = getPublicKey(agentSk);
  const cfg = {
    agents: { defaults: {}, list: [{ id: "main", default: true }] },
    bindings: [{ agentId: "main", match: { channel: "buzz", accountId: "main" } }],
    channels: { buzz: { allowFrom: [humanPk], channels: { [CONV]: { allow: true } } } },
  };
  const mkClient = (ownIds) => ({
    pubkey: agentPk,
    ownEventIds: { has: (id) => ownIds.includes(id) },
    publishChannelMessage: async () => ({ id: "r" }),
    publishTyping: async () => {},
  });

  // Plain chatter, no mention, no reply → skipped.
  const chatter = finalizeEvent(
    { kind: 9, created_at: Math.floor(Date.now() / 1000), content: "just chatting", tags: [["h", CONV]] },
    humanSk,
  );
  const c1 = {};
  await __testing.deliverInbound({
    event: chatter,
    account: { accountId: "main" },
    client: mkClient([]),
    channelRuntime: makeFakeChannelRuntime(c1),
    getCfg: () => cfg,
    fleet: new Set(),
  });
  assert.equal(c1.dispatchedCtx, undefined);

  // Reply to the bot's own message, still no p tag → dispatched (reply_to_bot
  // closes buzz-acp's documented blind spot).
  const botMsgId = "cd".repeat(32);
  const reply = finalizeEvent(
    {
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      content: "and what about the second option?",
      tags: [["h", CONV], ["e", botMsgId, "", "reply"]],
    },
    humanSk,
  );
  const c2 = {};
  await __testing.deliverInbound({
    event: reply,
    account: { accountId: "main" },
    client: mkClient([botMsgId]),
    channelRuntime: makeFakeChannelRuntime(c2),
    getCfg: () => cfg,
    fleet: new Set(),
  });
  assert.ok(c2.dispatchedCtx, "reply_to_bot must reach dispatch");
  // Slack parity: a reply inside a thread gets its own session, suffixed with
  // the thread root — here the bot message being replied to.
  assert.equal(c2.dispatchedCtx.SessionKey, `agent:main:buzz:channel:${CONV}:thread:${botMsgId}`);
});
