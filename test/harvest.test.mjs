import assert from "node:assert/strict";
import test from "node:test";

import { resolveAuthTag } from "../src/channel.js";
import { shouldPublishAgentDirectory } from "../src/shared.js";
import { buildPresenceTemplate, PRESENCE_KIND, startPresenceHeartbeat } from "../src/presence.js";
import {
  AGENT_PROFILE_KIND,
  hasConfiguredAuthTag,
  nextProfileCreatedAt,
  planProfileSync,
  PROFILE_KIND,
  resolveProfileTags,
} from "../src/profile-sync.js";
import {
  applyRosterChange,
  isNewerRoster,
  parseRoomRoster,
  parseRosterChange,
  ROOM_MEMBERSHIP_KIND,
  ROOM_SYSTEM_KIND,
} from "../src/room-roster.js";

const PK_A = "a".repeat(64);
const PK_B = "b".repeat(64);
const RELAY = "c".repeat(64);
const ROOM = "7fdd5a94-7523-5b86-b574-9124de6cdc0d";

test("per-account directory publication overrides the fleet setting", () => {
  assert.equal(shouldPublishAgentDirectory({}, {}), false);
  assert.equal(shouldPublishAgentDirectory({ publishAgentDirectory: true }, {}), true);
  assert.equal(
    shouldPublishAgentDirectory({ publishAgentDirectory: true }, { publishAgentDirectory: false }),
    false,
  );
  assert.equal(shouldPublishAgentDirectory({}, { publishAgentDirectory: true }), true);
});

/* ---------------------------------------------------------------- presence */

test("presence template is the ephemeral online event", () => {
  const tpl = buildPresenceTemplate();
  assert.equal(tpl.kind, PRESENCE_KIND);
  assert.equal(tpl.kind, 20001);
  assert.equal(tpl.content, "online");
  assert.deepEqual(tpl.tags, []);
});

test("presence heartbeat publishes immediately and on interval, then stops", async () => {
  const published = [];
  const stop = startPresenceHeartbeat({ publish: async (t) => void published.push(t), intervalMs: 10 });
  await new Promise((r) => setTimeout(r, 35));
  stop();
  const afterStop = published.length;
  assert.ok(published.length >= 2, `expected repeated beats, got ${published.length}`);
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(published.length, afterStop, "stop() must halt the heartbeat");
});

test("presence reports an error once per failure streak, and again after recovery", async () => {
  const errors = [];
  let mode = "fail";
  const stop = startPresenceHeartbeat({
    publish: async () => {
      if (mode === "fail") throw new Error("relay down");
    },
    onError: (e) => errors.push(e),
    intervalMs: 5,
  });
  await new Promise((r) => setTimeout(r, 40));
  assert.equal(errors.length, 1, "a flapping relay must not spam one error per beat");
  mode = "ok";
  await new Promise((r) => setTimeout(r, 20));
  mode = "fail";
  await new Promise((r) => setTimeout(r, 20));
  stop();
  assert.equal(errors.length, 2, "a new failure streak after recovery must report again");
});

/* ----------------------------------------------------------- profile sync */

test("auth tag replaces rather than accumulates, and other tags survive", () => {
  const current = { tags: [["auth", "old"], ["x", "keep"]] };
  const tags = resolveProfileTags(current, ["auth", "new"]);
  assert.deepEqual(tags, [["x", "keep"], ["auth", "new"]]);
  assert.equal(tags.filter((t) => t[0] === "auth").length, 1);
});

test("hasConfiguredAuthTag detects missing, stale, and duplicated attestations", () => {
  assert.equal(hasConfiguredAuthTag({ tags: [] }, undefined), true, "no configured tag → nothing to enforce");
  assert.equal(hasConfiguredAuthTag({ tags: [] }, ["auth", "x"]), false);
  assert.equal(hasConfiguredAuthTag({ tags: [["auth", "old"]] }, ["auth", "x"]), false);
  assert.equal(hasConfiguredAuthTag({ tags: [["auth", "x"], ["auth", "x"]] }, ["auth", "x"]), false);
  assert.equal(hasConfiguredAuthTag({ tags: [["auth", "x"]] }, ["auth", "x"]), true);
});

test("replaceable created_at always moves forward even within the same second", () => {
  assert.equal(nextProfileCreatedAt(undefined, 100), 100);
  assert.equal(nextProfileCreatedAt({ created_at: 100 }, 100), 101, "same-second republish must still be newer");
  assert.equal(nextProfileCreatedAt({ created_at: 50 }, 100), 100);
});

test("a fresh identity publishes only kind:0 by default for Buzz Desktop 0.5.3 compatibility", () => {
  const plan = planProfileSync({ displayName: "FORGE", now: 1000 });
  assert.deepEqual(plan.map((e) => e.kind), [PROFILE_KIND]);
  assert.equal(JSON.parse(plan[0].content).display_name, "FORGE");
});

test("agent-directory publication remains available behind an explicit opt-in", () => {
  const plan = planProfileSync({ displayName: "FORGE", publishAgentDirectory: true, now: 1000 });
  assert.deepEqual(plan.map((e) => e.kind), [PROFILE_KIND, AGENT_PROFILE_KIND]);
  assert.equal(JSON.parse(plan[1].content).channel_add_policy, "anyone");
});

test("a human-set display name is never clobbered", () => {
  const plan = planProfileSync({
    displayName: "FORGE",
    publishAgentDirectory: true,
    currentMetadata: { content: JSON.stringify({ display_name: "Forge (do not rename)", name: "forge" }), tags: [] },
    currentAgentProfile: {
      content: JSON.stringify({ name: "forge", display_name: "Forge (do not rename)", channel_add_policy: "anyone" }),
      tags: [],
    },
    now: 1000,
  });
  assert.deepEqual(plan, [], "nothing to publish when the profile is already good");
});

test("adding an owner attestation republishes kind:0 and only kind:0", () => {
  const plan = planProfileSync({
    displayName: "FORGE",
    publishAgentDirectory: true,
    authTag: ["auth", "owner-attestation"],
    currentMetadata: { content: JSON.stringify({ display_name: "FORGE", name: "FORGE" }), tags: [], created_at: 500 },
    currentAgentProfile: {
      content: JSON.stringify({ name: "FORGE", display_name: "FORGE", channel_add_policy: "anyone" }),
      tags: [],
    },
    now: 1000,
  });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].kind, PROFILE_KIND);
  assert.deepEqual(plan[0].tags, [["auth", "owner-attestation"]]);
});

test("an invalid channel_add_policy is corrected", () => {
  const plan = planProfileSync({
    displayName: "FORGE",
    publishAgentDirectory: true,
    currentMetadata: { content: JSON.stringify({ display_name: "FORGE", name: "FORGE" }), tags: [] },
    currentAgentProfile: { content: JSON.stringify({ name: "FORGE", display_name: "FORGE", channel_add_policy: "wat" }), tags: [] },
    now: 1000,
  });
  assert.equal(plan.length, 1);
  assert.equal(JSON.parse(plan[0].content).channel_add_policy, "anyone");
});

test("agent directory advertises invocable configured channels", () => {
  const plan = planProfileSync({
    displayName: "FORGE",
    publishAgentDirectory: true,
    channelIds: ["general-uuid", "pilot-uuid", "general-uuid"],
    currentAgentProfile: {
      content: JSON.stringify({
        name: "FORGE",
        display_name: "FORGE",
        channel_add_policy: "anyone",
      }),
      tags: [],
      created_at: 900,
    },
    now: 1000,
  });
  const agentEvent = plan.find((event) => event.kind === AGENT_PROFILE_KIND);
  assert.ok(agentEvent);
  const content = JSON.parse(agentEvent.content);
  assert.equal(content.respond_to, "anyone");
  assert.deepEqual(content.channel_ids, ["general-uuid", "pilot-uuid"]);
  assert.deepEqual(content.channels, content.channel_ids);
});

test("agent directory is current when invocation policy and channels match", () => {
  const content = {
    name: "FORGE",
    display_name: "FORGE",
    channel_add_policy: "anyone",
    respond_to: "anyone",
    channel_ids: ["general-uuid"],
    channels: ["general-uuid"],
  };
  assert.deepEqual(
    planProfileSync({
      displayName: "FORGE",
      publishAgentDirectory: true,
      channelIds: ["general-uuid"],
      currentMetadata: {
        content: JSON.stringify({ name: "FORGE", display_name: "FORGE" }),
        tags: [],
      },
      currentAgentProfile: { content: JSON.stringify(content), tags: [] },
      now: 1000,
    }),
    [],
  );
});

test("an empty display name publishes nothing", () => {
  assert.deepEqual(planProfileSync({ displayName: "   ", now: 1000 }), []);
});

/* ------------------------------------------------------------ room roster */

const rosterEvent = (over = {}) => ({
  kind: ROOM_MEMBERSHIP_KIND,
  id: "e1",
  pubkey: RELAY,
  created_at: 1000,
  tags: [["d", ROOM], ["p", PK_A, "", "bot"], ["p", PK_B]],
  content: "",
  ...over,
});

test("roster parses members and roles, including the bot role", () => {
  const roster = parseRoomRoster(rosterEvent());
  assert.equal(roster.roomId, ROOM);
  assert.deepEqual([...roster.members].sort(), [PK_A, PK_B].sort());
  assert.equal(roster.roles.get(PK_A), "bot");
  assert.equal(roster.roles.get(PK_B), undefined);
});

test("malformed rosters are rejected rather than partially trusted", () => {
  assert.equal(parseRoomRoster(rosterEvent({ kind: 9 })), undefined);
  assert.equal(parseRoomRoster(rosterEvent({ tags: [["p", PK_A]] })), undefined, "no d-tag");
  assert.equal(parseRoomRoster(rosterEvent({ tags: [["d", "not-a-uuid"]] })), undefined);
  const junkKey = parseRoomRoster(rosterEvent({ tags: [["d", ROOM], ["p", "zz"], ["p", PK_A]] }));
  assert.deepEqual([...junkKey.members], [PK_A], "a bad pubkey is dropped, the good one survives");
});

test("roster ordering is stable on created_at ties", () => {
  const a = { createdAt: 5, eventId: "aaa" };
  const b = { createdAt: 5, eventId: "bbb" };
  assert.equal(isNewerRoster(a, undefined), true);
  assert.equal(isNewerRoster({ createdAt: 6, eventId: "z" }, a), true);
  assert.equal(isNewerRoster(a, b), true, "lexically smaller id wins a tie");
  assert.equal(isNewerRoster(b, a), false, "and the comparison is not symmetric");
});

test("only the roster publisher can mutate the roster", () => {
  const roster = parseRoomRoster(rosterEvent());
  const change = (over = {}) => ({
    kind: ROOM_SYSTEM_KIND,
    pubkey: RELAY,
    tags: [["h", ROOM]],
    content: JSON.stringify({ type: "member_removed", target: PK_B }),
    ...over,
  });
  assert.deepEqual(parseRosterChange(change(), roster), { type: "member_removed", targetPublicKey: PK_B });
  assert.equal(parseRosterChange(change({ pubkey: PK_A }), roster), undefined, "a member must not forge roster changes");
  assert.equal(parseRosterChange(change({ tags: [["h", "9".repeat(8)]] }), roster), undefined, "wrong room");
  assert.equal(parseRosterChange(change({ content: "{not json" }), roster), undefined);
  assert.equal(parseRosterChange(change({ content: JSON.stringify({ type: "nope", target: PK_B }) }), roster), undefined);
});

test("member_left reports the departing member as actor, not target", () => {
  const roster = parseRoomRoster(rosterEvent());
  const parsed = parseRosterChange(
    { kind: ROOM_SYSTEM_KIND, pubkey: RELAY, tags: [["h", ROOM]], content: JSON.stringify({ type: "member_left", actor: PK_B }) },
    roster,
  );
  assert.deepEqual(parsed, { type: "member_left", targetPublicKey: PK_B });
});

test("applying a change does not mutate the original roster", () => {
  const roster = parseRoomRoster(rosterEvent());
  const next = applyRosterChange(roster, { type: "member_removed", targetPublicKey: PK_A });
  assert.equal(roster.members.has(PK_A), true, "original untouched");
  assert.equal(next.members.has(PK_A), false);
  assert.equal(next.roles.has(PK_A), false, "role is dropped with membership");
  const joined = applyRosterChange(next, { type: "member_joined", targetPublicKey: PK_A });
  assert.equal(joined.members.has(PK_A), true);
});

/* -------------------------------------------------------------- auth tag */

test("resolveAuthTag prefers the per-account attestation over the channel-wide one", () => {
  const chan = ["auth", "d".repeat(64), "", "1".repeat(128)];
  const acct = ["auth", "d".repeat(64), "", "2".repeat(128)];
  assert.deepEqual(resolveAuthTag({ authTag: chan }, { authTag: acct }), acct);
  assert.deepEqual(resolveAuthTag({ authTag: chan }, {}), chan);
});

test("resolveAuthTag returns undefined when unset or empty, never a bare auth tag", () => {
  assert.equal(resolveAuthTag({}, {}), undefined);
  assert.equal(resolveAuthTag({ authTag: "   " }, {}), undefined);
  assert.equal(resolveAuthTag({ authTag: [] }, {}), undefined);
  assert.equal(resolveAuthTag({ authTag: ["auth"] }, {}), undefined, "a tag with no value is not an attestation");
  assert.equal(resolveAuthTag({ authTag: ["auth", "  "] }, {}), undefined);
  assert.equal(resolveAuthTag({ authTag: ["notauth", "x"] }, {}), undefined);
  assert.equal(resolveAuthTag({}, {}, new Map()), undefined, "empty file store is still no attestation");
});

test("resolveAuthTag stringifies a well-formed four-element tag", () => {
  // Numeric conditions are legal NIP-OA (e.g. an expiry clause) and must survive
  // as strings, since the conditions string is part of the signed preimage.
  const owner = "d".repeat(64);
  const sig = "3".repeat(128);
  assert.deepEqual(resolveAuthTag({}, { authTag: ["auth", owner, 1234, sig] }), ["auth", owner, "1234", sig]);
});

test("an unset attestation leaves an otherwise-current profile untouched", () => {
  const plan = planProfileSync({
    displayName: "FORGE",
    authTag: resolveAuthTag({}, {}),
    currentMetadata: { content: JSON.stringify({ display_name: "FORGE", name: "FORGE" }), tags: [] },
    currentAgentProfile: {
      content: JSON.stringify({ name: "FORGE", display_name: "FORGE", channel_add_policy: "anyone" }),
      tags: [],
    },
  });
  assert.deepEqual(plan, []);
});

/* ------------------------------------------------ auth tag file store */

import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as joinPath } from "node:path";
import { loadAuthTags, normalizeAuthTag, readAccountAuthTag } from "../src/auth-tags.js";

const OWNER = "d".repeat(64);
const SIG = "e".repeat(128);
const GOOD = ["auth", OWNER, "", SIG];

const withStore = (contents) => {
  const dir = mkdtempSync(joinPath(tmpdir(), "buzz-authtags-"));
  const filePath = joinPath(dir, "agent-auth-tags.json");
  writeFileSync(filePath, typeof contents === "string" ? contents : JSON.stringify(contents));
  return filePath;
};

test("normalizeAuthTag enforces the NIP-OA four-element shape", () => {
  assert.deepEqual(normalizeAuthTag(GOOD), GOOD);
  assert.equal(normalizeAuthTag(["auth", OWNER, ""]), undefined, "three elements is malformed");
  assert.equal(normalizeAuthTag(["auth", OWNER, "", SIG, "extra"]), undefined, "five elements is malformed");
  assert.equal(normalizeAuthTag(["nope", OWNER, "", SIG]), undefined);
  assert.equal(normalizeAuthTag(["auth", "short", "", SIG]), undefined, "owner must be 64 hex");
  assert.equal(normalizeAuthTag(["auth", OWNER, "", "abc"]), undefined, "sig must be 128 hex");
  assert.equal(normalizeAuthTag(undefined), undefined);
});

test("both accepted per-account shapes yield the same tag", () => {
  assert.deepEqual(readAccountAuthTag({ pubkey: "x", authTag: GOOD }), GOOD, "mint-script shape");
  assert.deepEqual(readAccountAuthTag(GOOD), GOOD, "bare array shape");
});

test("the mint script's exact output shape loads", () => {
  const filePath = withStore({ coder: { pubkey: PK_A, authTag: GOOD }, main: { pubkey: PK_B, authTag: GOOD } });
  const tags = loadAuthTags({ filePath });
  assert.equal(tags.size, 2);
  assert.deepEqual(tags.get("coder"), GOOD);
});

test("a missing store is normal and must not throw", () => {
  const warns = [];
  const tags = loadAuthTags({ filePath: "/nonexistent/agent-auth-tags.json", onWarn: (m) => warns.push(m) });
  assert.equal(tags.size, 0);
  assert.deepEqual(warns, [], "absence is not a warning — no attestations minted yet is the normal state");
});

test("a corrupt store degrades to no attestation rather than taking accounts down", () => {
  const warns = [];
  assert.equal(loadAuthTags({ filePath: withStore("{not json"), onWarn: (m) => warns.push(m) }).size, 0);
  assert.equal(loadAuthTags({ filePath: withStore([1, 2]), onWarn: (m) => warns.push(m) }).size, 0);
  assert.ok(warns.length >= 2, "but it must be loud about it");
});

test("one malformed entry is dropped without losing the good ones", () => {
  const warns = [];
  const filePath = withStore({ good: { authTag: GOOD }, bad: { authTag: ["auth", "nope"] } });
  const tags = loadAuthTags({ filePath, onWarn: (m) => warns.push(m) });
  assert.deepEqual([...tags.keys()], ["good"]);
  assert.ok(warns.some((w) => w.includes("bad")));
});

test("resolveAuthTag falls back to the file store, and config still wins", () => {
  const fileTags = new Map([["coder", GOOD]]);
  assert.deepEqual(resolveAuthTag({}, { accountId: "coder" }, fileTags), GOOD);
  assert.equal(resolveAuthTag({}, { accountId: "absent" }, fileTags), undefined);
  const override = ["auth", OWNER, "", "f".repeat(128)];
  assert.deepEqual(resolveAuthTag({}, { accountId: "coder", authTag: override }, fileTags), override);
});

test("resolveAuthTag rejects a malformed configured tag instead of publishing it", () => {
  assert.equal(resolveAuthTag({ authTag: ["auth", "tooshort"] }, {}), undefined);
  assert.equal(resolveAuthTag({}, { authTag: "just-a-string" }), undefined, "a bare value is not an attestation");
  assert.deepEqual(resolveAuthTag({}, { authTag: JSON.stringify(GOOD) }), GOOD, "JSON string form is accepted");
});
