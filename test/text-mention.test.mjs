// Inbound plain-text mention fallback — upstream block/buzz#2663 gap 5 (#2603).
//
// The Buzz desktop's @-selector only offers desktop-managed agents, so a human
// addressing an EXTERNAL agent types plain text and the event carries no p tag
// (field reports on #2663 show exactly this: tags=[["h", …]] only). These tests
// run the PRODUCTION deliverInbound over such an event and assert it reaches the
// agent — and, critically, that the looser matching does not widen the gate.
import test from "node:test";
import assert from "node:assert/strict";

import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";
import { finalizeEvent, generateSecretKey, getPublicKey } from "nostr-tools/pure";
import { __testing, textMentionsSelf, selfMentionNames } from "../src/channel.js";
import { clearProjectsIndexCacheForTest } from "../src/session-map.js";

const CONV = "0198f1c2-7777-cccc-dddd-0123456789ab";

function makeFakeChannelRuntime(captured) {
  return {
    routing: { resolveAgentRoute },
    session: {
      resolveStorePath: (_store, { agentId }) => `/tmp/fake-store/${agentId}`,
      readSessionUpdatedAt: () => undefined,
      recordSessionMetaFromInbound: async () => {},
    },
    reply: {
      resolveEnvelopeFormatOptions: () => ({}),
      formatAgentEnvelope: ({ body }) => body,
      finalizeInboundContext: (ctx) => ctx,
      dispatchReplyWithBufferedBlockDispatcher: async ({ ctx }) => {
        captured.dispatchedCtx = ctx;
      },
    },
  };
}

/** Run one event through production deliverInbound; return what got dispatched. */
async function runInbound({ content, tags, humanSk, agentPk, account, channelCfg }) {
  clearProjectsIndexCacheForTest();
  const cfg = {
    agents: { defaults: {}, list: [{ id: "main", default: true }] },
    bindings: [{ agentId: "main", match: { channel: "buzz", accountId: "main" } }],
    channels: {
      buzz: {
        allowFrom: [getPublicKey(humanSk)],
        channels: { [CONV]: { allow: true } },
        ...channelCfg,
      },
    },
  };
  const event = finalizeEvent(
    { kind: 9, created_at: Math.floor(Date.now() / 1000), content, tags: tags ?? [["h", CONV]] },
    humanSk,
  );
  const captured = {};
  await __testing.deliverInbound({
    event,
    account: account ?? { accountId: "main", name: "ALINA" },
    client: {
      pubkey: agentPk,
      ownEventIds: { has: () => false },
      publishChannelMessage: async () => ({ id: "reply-id" }),
      publishTyping: async () => {},
    },
    channelRuntime: makeFakeChannelRuntime(captured),
    getCfg: () => cfg,
    log: undefined,
    fleet: new Set(),
  });
  return captured;
}

function keys() {
  const humanSk = generateSecretKey();
  const agentPk = getPublicKey(generateSecretKey());
  return { humanSk, agentPk };
}

test("reproduces the upstream gap: a desktop-shaped mention carries no p tag", async () => {
  // Guard the premise. If this ever fails, the desktop started emitting p tags
  // for external agents (#2603 fixed) and the fallback can be reconsidered.
  const { humanSk, agentPk } = keys();
  const event = finalizeEvent(
    { kind: 9, created_at: 1, content: "@ALINA u there?", tags: [["h", CONV]] },
    humanSk,
  );
  assert.equal(event.tags.some((t) => t[0] === "p"), false);
  assert.equal(
    textMentionsSelf({ text: event.content, names: selfMentionNames({ account: { accountId: "main", name: "ALINA" }, cfg: {} }) }),
    true,
  );
  assert.ok(agentPk);
});

test("plain-text @ALINA with NO p tag reaches the agent", async () => {
  const { humanSk, agentPk } = keys();
  const captured = await runInbound({ content: "@ALINA status please", humanSk, agentPk });
  assert.ok(captured.dispatchedCtx, "event should have been dispatched");
  assert.equal(captured.dispatchedCtx.WasMentioned, true);
});

test("case-insensitive and mid-sentence, but not a bare-name substring", async () => {
  const { humanSk, agentPk } = keys();
  assert.ok((await runInbound({ content: "hey @alina can you look", humanSk, agentPk })).dispatchedCtx);
  // No @ sigil: prose *about* the agent must not steer it.
  assert.equal((await runInbound({ content: "ALINA built this earlier", humanSk, agentPk })).dispatchedCtx, undefined);
  // Longer name starting with ours must not match (boundary rule).
  assert.equal((await runInbound({ content: "@ALINAbot ping", humanSk, agentPk })).dispatchedCtx, undefined);
});

test("matches accountId and configured aliases, not another account's name", async () => {
  const { humanSk, agentPk } = keys();
  const account = { accountId: "forge", name: "FORGE" };
  const channelCfg = { accounts: { forge: { mentionAliases: ["forge-bot"] } } };
  assert.ok((await runInbound({ content: "@forge-bot build it", humanSk, agentPk, account, channelCfg })).dispatchedCtx);
  assert.ok((await runInbound({ content: "@forge build it", humanSk, agentPk, account, channelCfg })).dispatchedCtx);
  // A different agent's name must not wake this account.
  assert.equal(
    (await runInbound({ content: "@ATLAS plan it", humanSk, agentPk, account, channelCfg })).dispatchedCtx,
    undefined,
  );
});

test("textMention:false restores strict p-tag-only gating", async () => {
  const { humanSk, agentPk } = keys();
  assert.equal(
    (await runInbound({ content: "@ALINA ping", humanSk, agentPk, channelCfg: { textMention: false } })).dispatchedCtx,
    undefined,
  );
  // Per-conversation override wins over the channel default.
  assert.equal(
    (
      await runInbound({
        content: "@ALINA ping",
        humanSk,
        agentPk,
        channelCfg: { channels: { [CONV]: { allow: true, textMention: false } } },
      })
    ).dispatchedCtx,
    undefined,
  );
});

test("the fallback does not bypass the author gate or the conversation allowlist", async () => {
  const { agentPk } = keys();
  const strangerSk = generateSecretKey();
  // Author not in allowFrom: text mention must NOT let them in.
  clearProjectsIndexCacheForTest();
  const cfg = {
    agents: { defaults: {}, list: [{ id: "main", default: true }] },
    bindings: [{ agentId: "main", match: { channel: "buzz", accountId: "main" } }],
    channels: { buzz: { allowFrom: ["ab".repeat(32)], channels: { [CONV]: { allow: true } } } },
  };
  const event = finalizeEvent(
    { kind: 9, created_at: Math.floor(Date.now() / 1000), content: "@ALINA do it", tags: [["h", CONV]] },
    strangerSk,
  );
  const captured = {};
  await __testing.deliverInbound({
    event,
    account: { accountId: "main", name: "ALINA" },
    client: {
      pubkey: agentPk,
      ownEventIds: { has: () => false },
      publishChannelMessage: async () => ({ id: "x" }),
      publishTyping: async () => {},
    },
    channelRuntime: makeFakeChannelRuntime(captured),
    getCfg: () => cfg,
    log: undefined,
    fleet: new Set(),
  });
  assert.equal(captured.dispatchedCtx, undefined, "author gate must still fail closed");

  // Unlisted conversation: same.
  const other = await runInbound({
    content: "@ALINA do it",
    humanSk: generateSecretKey(),
    agentPk,
    channelCfg: { channels: {} },
  });
  assert.equal(other.dispatchedCtx, undefined, "conversation allowlist must still fail closed");
});

test("desktop @-autocomplete shape: ['mention', pubkey] with no p tag counts as a real mention", async () => {
  // Captured verbatim from the live relay 2026-07-31: the Buzz desktop composer
  // emits a `mention` tag, not a `p` tag, when a human picks an agent from
  // @-autocomplete. This must be treated as a genuine mention.
  const humanSk = generateSecretKey();
  const agentSk = generateSecretKey();
  const agentPk = getPublicKey(agentSk);
  const captured = await runInbound({
    content: "@ALINA are you onhline?",
    tags: [["h", CONV], ["mention", agentPk]],
    humanSk,
    agentPk,
    // Prove it is the tag doing the work, not the text fallback.
    channelCfg: { textMention: false },
  });
  assert.ok(captured.dispatchedCtx, "mention-tagged event must reach the agent");
  assert.equal(captured.dispatchedCtx.WasMentioned, true);
});

test("a mention tag naming someone else does not wake us", async () => {
  const humanSk = generateSecretKey();
  const agentPk = getPublicKey(generateSecretKey());
  const someoneElse = getPublicKey(generateSecretKey());
  const captured = await runInbound({
    content: "@BUMBLE ping",
    tags: [["h", CONV], ["mention", someoneElse]],
    humanSk,
    agentPk,
    channelCfg: { textMention: false },
  });
  assert.equal(captured.dispatchedCtx, undefined);
});

test("sender is identified by kind:0 display name, with pubkey fallback", async () => {
  // The NO_REPLY on 2026-07-31 came from an envelope whose author was a raw
  // 64-hex string. Resolve it to a human name so the agent knows who is asking.
  const humanSk = generateSecretKey();
  const agentPk = getPublicKey(generateSecretKey());

  async function run(resolveProfileName) {
    clearProjectsIndexCacheForTest();
    const cfg = {
      agents: { defaults: {}, list: [{ id: "main", default: true }] },
      bindings: [{ agentId: "main", match: { channel: "buzz", accountId: "main" } }],
      channels: { buzz: { allowFrom: [getPublicKey(humanSk)], channels: { [CONV]: { allow: true } } } },
    };
    const event = finalizeEvent(
      { kind: 9, created_at: Math.floor(Date.now() / 1000), content: "@ALINA ping", tags: [["h", CONV]] },
      humanSk,
    );
    const captured = {};
    await __testing.deliverInbound({
      event,
      account: { accountId: "main", name: "ALINA" },
      client: {
        pubkey: agentPk,
        ownEventIds: { has: () => false },
        resolveProfileName,
        publishChannelMessage: async () => ({ id: "r" }),
        publishTyping: async () => {},
      },
      channelRuntime: makeFakeChannelRuntime(captured),
      getCfg: () => cfg,
      log: undefined,
      fleet: new Set(),
    });
    return captured.dispatchedCtx;
  }

  const named = await run(async () => "matthew");
  assert.equal(named.SenderName, "matthew");

  // No profile on the relay → short pubkey, never a crash.
  const anon = await run(async () => undefined);
  assert.match(anon.SenderName, /^[0-9a-f]{8}…[0-9a-f]{4}$/);

  // A failing lookup must not take the message down.
  const broken = await run(async () => {
    throw new Error("relay timeout");
  });
  assert.ok(broken, "a profile lookup failure must not drop the message");
  assert.match(broken.SenderName, /^[0-9a-f]{8}…[0-9a-f]{4}$/);
});
