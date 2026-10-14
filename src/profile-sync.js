/**
 * Buzz profile sync: kind:0 metadata (with NIP-OA owner attestation) and the
 * kind:10100 agent-directory profile.
 *
 * Harvested from upstream OpenClaw's `@openclaw/buzz`
 * (extensions/buzz/src/profile.ts @ v2026.7.2-beta.6, MIT, © OpenClaw
 * Foundation), reimplemented in JS against our own relay client.
 *
 * Two things this buys us that our previous bare `{name, display_name}` kind:0
 * did not:
 *
 * 1. **`owner unavailable` goes away.** Buzz shows that badge when a profile
 *    carries no valid NIP-OA owner attestation. The attestation is an `auth`
 *    tag on kind:0, signed by the human owner — we cannot mint it, the human owner's
 *    identity does, and we just republish it.
 * 2. **Optional agent-directory registration (kind:10100).** Available for
 *    clients that support remote agents. It is disabled by default because
 *    Buzz Desktop 0.5.3 hides directory agents it does not manage locally.
 *
 * Divergence from upstream, on purpose: upstream resolves a display name for
 * one bot identity, falling back to "OpenClaw". We already know the agent's
 * name per client, so the caller passes it and there is no fallback chain.
 */

export const PROFILE_KIND = 0;
export const AGENT_PROFILE_KIND = 10_100;

const DEFAULT_CHANNEL_ADD_POLICY = "anyone";
const CHANNEL_ADD_POLICIES = new Set(["anyone", "owner_only", "nobody"]);

/** Parse a replaceable event's JSON content into a plain object; never throws. */
export function parseProfileContent(event) {
  if (!event) return {};
  try {
    const parsed = JSON.parse(event.content || "{}");
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? { ...parsed } : {};
  } catch {
    return {};
  }
}

function readNonEmptyString(content, key) {
  const value = content?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Replace any existing `auth` tags with the configured one, preserving every
 * other tag. Upstream filters rather than appends so a rotated attestation
 * cannot leave a stale one behind.
 */
export function resolveProfileTags(event, authTag) {
  const existing = event?.tags ?? [];
  if (!authTag) return existing.map((tag) => tag.slice());
  return [...existing.filter((tag) => tag[0] !== "auth").map((tag) => tag.slice()), [...authTag]];
}

/** True when the event already carries exactly the configured attestation. */
export function hasConfiguredAuthTag(event, authTag) {
  if (!authTag) return true;
  const authTags = (event?.tags ?? []).filter((tag) => tag[0] === "auth");
  return authTags.length === 1 && JSON.stringify(authTags[0]) === JSON.stringify(authTag);
}

/**
 * `created_at` for a replaceable event.
 *
 * Load-bearing: relays keep the newest replaceable event per (kind, pubkey), so
 * republishing within the same second as the current one can be dropped as
 * not-newer. Upstream's `max(now, current + 1)` guarantees forward motion.
 */
export function nextProfileCreatedAt(current, now = Math.floor(Date.now() / 1000)) {
  return current ? Math.max(now, current.created_at + 1) : now;
}

/**
 * Decide which profile events need publishing. Pure — the caller signs and
 * publishes — so the decision is directly testable.
 *
 * Returns `[]` when nothing changed, which is the common case on reconnect and
 * is why this does not blindly republish on every connect.
 */
export function planProfileSync({
  displayName,
  authTag,
  channelIds,
  currentMetadata,
  currentAgentProfile,
  publishAgentDirectory = false,
  now,
}) {
  const name = String(displayName ?? "").trim();
  if (!name) return [];

  const metadataContent = parseProfileContent(currentMetadata);
  const agentContent = parseProfileContent(currentAgentProfile);

  // Never clobber a display name a human already set in Buzz.
  const resolvedDisplayName =
    readNonEmptyString(metadataContent, "display_name") ??
    readNonEmptyString(agentContent, "display_name") ??
    readNonEmptyString(agentContent, "name") ??
    name;

  const plan = [];

  if (metadataContent.display_name !== resolvedDisplayName || !hasConfiguredAuthTag(currentMetadata, authTag)) {
    metadataContent.display_name = resolvedDisplayName;
    if (!readNonEmptyString(metadataContent, "name")) metadataContent.name = resolvedDisplayName;
    plan.push({
      kind: PROFILE_KIND,
      content: JSON.stringify(metadataContent),
      created_at: nextProfileCreatedAt(currentMetadata, now),
      tags: resolveProfileTags(currentMetadata, authTag),
    });
  }

  // Buzz Desktop 0.5.3 marks kind:10100 identities as agents, then excludes
  // every agent not present in its desktop-local managed-agents.json. Remote
  // OpenClaw identities therefore disappear from both the member list and
  // @-autocomplete. Keep the upstream-compatible publisher available for a
  // fixed client, but fail compatible with 0.5.3 by default.
  if (!publishAgentDirectory) return plan;

  let agentChanged = false;
  if (!readNonEmptyString(agentContent, "name")) {
    agentContent.name = resolvedDisplayName;
    agentChanged = true;
  }
  if (!readNonEmptyString(agentContent, "display_name")) {
    agentContent.display_name = resolvedDisplayName;
    agentChanged = true;
  }
  if (typeof agentContent.channel_add_policy !== "string" || !CHANNEL_ADD_POLICIES.has(agentContent.channel_add_policy)) {
    agentContent.channel_add_policy = DEFAULT_CHANNEL_ADD_POLICY;
    agentChanged = true;
  }
  // Buzz Desktop 0.5.3 treats a kind:10100 entry as an explicit invocation
  // policy. A directory entry with no `respond_to`/`channel_ids` is therefore
  // *less* permissive than publishing no directory entry at all: the desktop
  // hides that identity from member lists and @-autocomplete even when it is
  // an active channel member. Keep the directory contract aligned with the
  // conversations this OpenClaw account actually serves.
  if (Array.isArray(channelIds)) {
    if (agentContent.respond_to !== "anyone") {
      agentContent.respond_to = "anyone";
      agentChanged = true;
    }
    const normalizedChannelIds = [...new Set(channelIds.map((id) => String(id).trim()).filter(Boolean))].sort();
    const currentChannelIds = Array.isArray(agentContent.channel_ids)
      ? [...new Set(agentContent.channel_ids.map((id) => String(id).trim()).filter(Boolean))].sort()
      : [];
    if (JSON.stringify(currentChannelIds) !== JSON.stringify(normalizedChannelIds)) {
      agentContent.channel_ids = normalizedChannelIds;
      // `channels` is display-only but index-aligned with `channel_ids` in the
      // desktop. UUIDs are a truthful fallback until room names are available.
      agentContent.channels = normalizedChannelIds;
      agentChanged = true;
    }
  }
  if (agentChanged) {
    plan.push({
      kind: AGENT_PROFILE_KIND,
      content: JSON.stringify(agentContent),
      created_at: nextProfileCreatedAt(currentAgentProfile, now),
      tags: (currentAgentProfile?.tags ?? []).map((tag) => tag.slice()),
    });
  }

  return plan;
}
