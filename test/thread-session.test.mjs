// Thread → session-key contract, mirrored from Slack.
//
// Slack (docs/channels/slack.md, "Threading, sessions, and reply tags"):
//   - channel session  agent:<id>:slack:channel:<chan>
//   - thread replies   ...:thread:<threadTs>
//   - top-level messages stay on the channel session unless the root is
//     expected to start a visible thread, in which case it is SEEDED into the
//     thread session so root + replies share one session.
// Confirmed against this host's real history rather than the doc alone, e.g.
//   agent:main:slack:channel:c0bhp68cdl5:thread:1784404386.491209
// alongside a bare agent:main:slack:channel:c0bhp68cdl5.
//
// Buzz's thread_ts analogue is the NIP-10 root event id.
import test from "node:test";
import assert from "node:assert/strict";

import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { __testing, resolveBuzzThreadRoot, applyBuzzThreadSuffix } from "../src/channel.js";
import { resolveConversationPolicy } from "../src/shared.js";

const CONV = "0198f1c2-9999-aaaa-bbbb-0123456789ab";
const ROOT = "ab".repeat(32);
const PARENT = "ef".repeat(32);

const policyFor = (channelCfg = {}, entry = {}) =>
  resolveConversationPolicy({
    cfg: { channels: { buzz: { ...channelCfg, channels: { [CONV]: { allow: true, ...entry } } } } },
    conversationId: CONV,
  });

test("thread root resolution mirrors Slack's thread_ts rules", () => {
  const ev = { id: "11".repeat(32) };

  // Marked reply: the root marker wins, not the immediate parent.
  assert.equal(
    resolveBuzzThreadRoot({ event: ev, rootId: ROOT, parentId: PARENT, policy: policyFor() }),
    ROOT,
  );
  // One-deep reply carrying only a `reply` marker: parent IS the root.
  assert.equal(
    resolveBuzzThreadRoot({ event: ev, rootId: undefined, parentId: PARENT, policy: policyFor() }),
    PARENT,
  );
  // Top-level under the default replyMode "channel": stays on the conversation
  // session, exactly like an ordinary top-level Slack channel message.
  assert.equal(
    resolveBuzzThreadRoot({ event: ev, rootId: undefined, parentId: undefined, policy: policyFor() }),
    undefined,
  );
  // Top-level under replyMode "thread": seeded, because our answer opens a
  // visible thread on it — Slack's seeding condition.
  assert.equal(
    resolveBuzzThreadRoot({
      event: ev,
      rootId: undefined,
      parentId: undefined,
      policy: policyFor({ replyMode: "thread" }),
    }),
    ev.id,
  );
  // threadSessions:false is a full opt-out, replies included.
  assert.equal(
    resolveBuzzThreadRoot({
      event: ev,
      rootId: ROOT,
      parentId: PARENT,
      policy: policyFor({ threadSessions: false }),
    }),
    undefined,
  );
});

test("thread suffix composes onto whatever base key resolved", () => {
  // Project-bound conversation keeps its declared key as the stem, so a thread
  // is a child of the project session rather than a sibling of it.
  assert.equal(
    applyBuzzThreadSuffix({ sessionKey: "agent:main:project:buzz", threadRoot: ROOT }),
    `agent:main:project:buzz:thread:${ROOT}`,
  );
  assert.equal(
    applyBuzzThreadSuffix({ sessionKey: `agent:main:buzz:channel:${CONV}`, threadRoot: ROOT }),
    `agent:main:buzz:channel:${CONV}:thread:${ROOT}`,
  );
  // No root → untouched. Never fabricate a suffix.
  assert.equal(
    applyBuzzThreadSuffix({ sessionKey: "agent:main:project:buzz", threadRoot: undefined }),
    "agent:main:project:buzz",
  );
});

test("per-conversation replyMode overrides the channel default", () => {
  assert.equal(policyFor().replyMode, "channel");
  assert.equal(policyFor({ replyMode: "thread" }).replyMode, "thread");
  assert.equal(policyFor({ replyMode: "thread" }, { replyMode: "channel" }).replyMode, "channel");
  assert.equal(policyFor().threadSessions, true);
  assert.equal(policyFor({ threadSessions: false }).threadSessions, false);
});

// --- end-to-end through the production inbound path -------------------------

function makeRuntime(captured) {
  return {
    routing: { resolveAgentRoute: () => ({ agentId: "main", sessionKey: `agent:main:buzz:channel:${CONV}` }) },
    session: {
      resolveStorePath: () => "/tmp/fake-store/main",
      readSessionUpdatedAt: () => undefined,
      recordSessionMetaFromInbound: async ({ sessionKey }) => {
        captured.recordedSessionKey = sessionKey;
      },
    },
    reply: {
      resolveEnvelopeFormatOptions: () => ({}),
      formatAgentEnvelope: ({ body }) => body,
      finalizeInboundContext: (ctx) => ctx,
      dispatchReplyWithBufferedBlockDispatcher: async ({ ctx, dispatcherOptions }) => {
        captured.dispatchedCtx = ctx;
        await dispatcherOptions.deliver({ text: "ack" });
      },
    },
  };
}

async function run({ tags, channelCfg = {}, ownIds = [] }) {
  const humanSk = generateSecretKey();
  const humanPk = getPublicKey(humanSk);
  const agentSk = generateSecretKey();
  const agentPk = getPublicKey(agentSk);
  const cfg = {
    agents: { defaults: {}, list: [{ id: "main", default: true }] },
    bindings: [{ agentId: "main", match: { channel: "buzz", accountId: "main" } }],
    channels: {
      buzz: { ...channelCfg, allowFrom: [humanPk], channels: { [CONV]: { allow: true } } },
    },
  };
  const event = finalizeEvent(
    {
      kind: 9,
      created_at: Math.floor(Date.now() / 1000),
      content: "question",
      tags: [["h", CONV], ["p", agentPk], ...tags],
    },
    humanSk,
  );
  const published = [];
  const captured = {};
  await __testing.deliverInbound({
    event,
    account: { accountId: "main", name: "ALINA" },
    client: {
      pubkey: agentPk,
      ownEventIds: { has: (id) => ownIds.includes(id) },
      publishChannelMessage: async (m) => {
        published.push(m);
        return { id: "r" };
      },
      publishTyping: async () => {},
    },
    channelRuntime: makeRuntime(captured),
    getCfg: () => cfg,
    fleet: new Set(),
  });
  return { event, captured, published };
}

test("top-level message: conversation session, flat reply", async () => {
  const { captured, published } = await run({ tags: [] });
  assert.equal(captured.dispatchedCtx.SessionKey, `agent:main:buzz:channel:${CONV}`);
  assert.equal(captured.recordedSessionKey, `agent:main:buzz:channel:${CONV}`);
  assert.deepEqual(published[0].tags.filter((t) => t[0] === "e"), []);
});

test("thread reply: isolated thread session, e-tagged reply into that thread", async () => {
  const { event, captured, published } = await run({
    tags: [["e", ROOT, "", "root"], ["e", PARENT, "", "reply"]],
  });
  assert.equal(captured.dispatchedCtx.SessionKey, `agent:main:buzz:channel:${CONV}:thread:${ROOT}`);
  // Even under the default "channel" replyMode, a reply inside a thread stays
  // in that thread — a flat answer would escape it.
  assert.deepEqual(published[0].tags.filter((t) => t[0] === "e"), [
    ["e", ROOT, "", "root"],
    ["e", event.id, "", "reply"],
  ]);
});

test("replyMode thread: top-level is seeded into its own thread session", async () => {
  const { event, captured, published } = await run({ tags: [], channelCfg: { replyMode: "thread" } });
  assert.equal(captured.dispatchedCtx.SessionKey, `agent:main:buzz:channel:${CONV}:thread:${event.id}`);
  assert.deepEqual(published[0].tags.filter((t) => t[0] === "e"), [["e", event.id, "", "reply"]]);
});

test("threadSessions false: thread replies collapse onto the conversation session", async () => {
  const { captured, published } = await run({
    tags: [["e", ROOT, "", "root"], ["e", PARENT, "", "reply"]],
    channelCfg: { threadSessions: false },
  });
  assert.equal(captured.dispatchedCtx.SessionKey, `agent:main:buzz:channel:${CONV}`);
  // Session collapsing must not change where the reply is POSTED — it still
  // belongs in the thread it answers.
  assert.equal(published[0].tags.some((t) => t[0] === "e"), true);
});
