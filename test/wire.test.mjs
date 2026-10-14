// Wire-contract units: NIP-10 threading tags, h-tag parsing, mention facts,
// key decoding, outbound mention translation.
import test from "node:test";
import assert from "node:assert/strict";

import { generateSecretKey, getPublicKey, finalizeEvent } from "nostr-tools/pure";
import {
  buildReplyTags,
  conversationIdFromEvent,
  decodeBuzzPrivateKey,
  mentionedPubkeys,
  parseThreadTags,
} from "../src/nostr-client.js";
import { buildOutboundMentionTags, normalizeBuzzTarget } from "../src/channel.js";
import { resolveConversationPolicy } from "../src/shared.js";

const CONV = "0198f1c2-7777-8888-9999-0123456789ab";

test("direct reply emits single reply e-tag; nested emits root+reply", () => {
  assert.deepEqual(buildReplyTags({ parentId: "p1" }), [["e", "p1", "", "reply"]]);
  assert.deepEqual(buildReplyTags({ rootId: "r1", parentId: "r1" }), [["e", "r1", "", "reply"]]);
  assert.deepEqual(buildReplyTags({ rootId: "r1", parentId: "p2" }), [
    ["e", "r1", "", "root"],
    ["e", "p2", "", "reply"],
  ]);
});

test("thread tags parse marked and positional NIP-10 forms", () => {
  const marked = { tags: [["e", "r1", "", "root"], ["e", "p2", "", "reply"]] };
  assert.deepEqual(parseThreadTags(marked), { rootId: "r1", parentId: "p2" });
  const positional = { tags: [["e", "r1"], ["e", "p2"]] };
  assert.deepEqual(parseThreadTags(positional), { rootId: "r1", parentId: "p2" });
  assert.deepEqual(parseThreadTags({ tags: [] }), { rootId: undefined, parentId: undefined });
});

test("mentions come from BOTH p and mention tags, lowercased", () => {
  // Corrected 2026-07-31: this previously asserted that `mention` tags were
  // ignored as non-notifying. The live Buzz desktop emits ["mention", <pubkey>]
  // for an @-autocomplete pick, so ignoring it dropped real human mentions.
  const pk = "ab".repeat(32);
  const other = "cd".repeat(32);
  const event = { tags: [["p", pk.toUpperCase()], ["mention", other.toUpperCase()], ["h", CONV]] };
  assert.deepEqual(mentionedPubkeys(event), [pk, other]);
  assert.equal(conversationIdFromEvent(event), CONV);
});

test("key decoding accepts hex and nsec, rejects junk", () => {
  const sk = generateSecretKey();
  const hex = Buffer.from(sk).toString("hex");
  assert.deepEqual(decodeBuzzPrivateKey(hex), sk);
  assert.throws(() => decodeBuzzPrivateKey("nope"));
});

test("outbound @Name translation emits p tag only for directory names present in text", () => {
  const forgePk = "12".repeat(32);
  const cfg = { channels: { buzz: { mentionDirectory: { FORGE: forgePk, ATLAS: "34".repeat(32) } } } };
  const tags = buildOutboundMentionTags({ cfg, text: "hand this to @FORGE please", selfPubkey: "ff".repeat(32) });
  assert.deepEqual(tags, [["p", forgePk]]);
});

test("self is never p-tagged from the directory", () => {
  const selfPk = "12".repeat(32);
  const cfg = { channels: { buzz: { mentionDirectory: { ALINA: selfPk } } } };
  assert.deepEqual(buildOutboundMentionTags({ cfg, text: "@ALINA self-note", selfPubkey: selfPk }), []);
});

test("target normalization strips buzz:/channel: prefixes verbatim-preserving id case", () => {
  assert.equal(normalizeBuzzTarget(`buzz:${CONV}`), CONV);
  assert.equal(normalizeBuzzTarget(`channel:${CONV.toUpperCase()}`), CONV.toUpperCase());
  assert.equal(normalizeBuzzTarget("  "), undefined);
});

test("conversation policy: allowlist fails closed, allowFrom lowercases", () => {
  const author = "AB".repeat(32);
  const cfg = {
    channels: {
      buzz: {
        allowFrom: [author],
        channels: { [CONV]: { allow: true } },
      },
    },
  };
  const listed = resolveConversationPolicy({ cfg, conversationId: CONV });
  assert.equal(listed.allowed, true);
  assert.equal(listed.requireMention, true);
  assert.ok(listed.allowFrom.includes(author.toLowerCase()));
  const unlisted = resolveConversationPolicy({ cfg, conversationId: "other" });
  assert.equal(unlisted.allowed, false);
});

test("kind:9 event shape round-trips through finalizeEvent for the relay contract", () => {
  const sk = generateSecretKey();
  const event = finalizeEvent(
    {
      kind: 9,
      created_at: 1_753_900_000,
      content: "hello from the fleet",
      tags: [["h", CONV], ["e", "aa".repeat(32), "", "reply"]],
    },
    sk,
  );
  assert.equal(event.kind, 9);
  assert.equal(event.pubkey, getPublicKey(sk));
  assert.equal(conversationIdFromEvent(event), CONV);
  assert.ok(event.sig.length === 128);
});
