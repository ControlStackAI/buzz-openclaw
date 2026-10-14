/**
 * Relay-signed room roster (kind:39002) and membership-change events
 * (kind:40099).
 *
 * Harvested from upstream OpenClaw's `@openclaw/buzz`
 * (extensions/buzz/src/room-membership.ts @ v2026.7.2-beta.6, MIT, © OpenClaw
 * Foundation).
 *
 * Why this matters for us: the roster is published and signed by the relay, so
 * membership can be checked from memory before any agent work happens — no
 * per-message relay query and no polling. Both kinds are already flowing on our
 * relay (39002 ×57, 40099 ×57 at time of writing), we simply were not reading
 * them.
 *
 * Note the roles map: this is where the **Bot** role would show up, which is
 * the role upstream requires and the relay will not let an ordinary member
 * self-assign.
 */

const HEX_PUBLIC_KEY = /^[0-9a-f]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const CHANGE_TYPES = new Set(["member_joined", "member_left", "member_removed"]);

export const ROOM_MEMBERSHIP_KIND = 39_002;
export const ROOM_SYSTEM_KIND = 40_099;

/**
 * Parse a kind:39002 roster event. Returns undefined for anything malformed —
 * a bad roster must never widen access, so every reject path is silent-and-safe.
 */
export function parseRoomRoster(event) {
  if (!event || event.kind !== ROOM_MEMBERSHIP_KIND) return undefined;
  const roomId = event.tags.find((tag) => tag[0] === "d")?.[1]?.trim().toLowerCase();
  if (!roomId || !UUID.test(roomId)) return undefined;

  const members = new Set();
  const roles = new Map();
  for (const tag of event.tags) {
    if (tag[0] !== "p") continue;
    const pubkey = tag[1]?.trim().toLowerCase();
    if (!pubkey || !HEX_PUBLIC_KEY.test(pubkey)) continue;
    members.add(pubkey);
    const role = tag[3]?.trim().toLowerCase();
    if (role) roles.set(pubkey, role);
  }

  return {
    roomId,
    createdAt: event.created_at,
    eventId: event.id,
    publisherPublicKey: String(event.pubkey).toLowerCase(),
    members,
    roles,
  };
}

/**
 * Ordering for replaceable rosters. Ties on `created_at` break on the lexically
 * smaller event id — arbitrary but *stable*, so two clients converge on the
 * same roster instead of flapping.
 */
export function isNewerRoster(candidate, current) {
  return (
    !current ||
    candidate.createdAt > current.createdAt ||
    (candidate.createdAt === current.createdAt && candidate.eventId < current.eventId)
  );
}

/**
 * Parse a kind:40099 membership change, but only when it is authentic for this
 * roster: same publisher as the roster and h-tagged to the same room. Anything
 * else is ignored, so a member cannot forge a roster mutation.
 */
export function parseRosterChange(event, roster) {
  if (
    !event ||
    !roster ||
    event.kind !== ROOM_SYSTEM_KIND ||
    String(event.pubkey).toLowerCase() !== roster.publisherPublicKey ||
    !event.tags.some((tag) => tag[0] === "h" && tag[1]?.toLowerCase() === roster.roomId)
  ) {
    return undefined;
  }
  try {
    const content = JSON.parse(event.content);
    if (typeof content.type !== "string" || !CHANGE_TYPES.has(content.type)) return undefined;
    // member_left reports the departing member as `actor`, not `target`.
    const raw =
      typeof content.target === "string"
        ? content.target
        : content.type === "member_left" && typeof content.actor === "string"
          ? content.actor
          : "";
    const target = raw.trim().toLowerCase();
    if (!HEX_PUBLIC_KEY.test(target)) return undefined;
    return { type: content.type, targetPublicKey: target };
  } catch {
    return undefined;
  }
}

/** Apply a parsed change to a roster, returning a new roster (never mutates). */
export function applyRosterChange(roster, change) {
  if (!roster || !change) return roster;
  const members = new Set(roster.members);
  const roles = new Map(roster.roles);
  if (change.type === "member_joined") {
    members.add(change.targetPublicKey);
  } else {
    members.delete(change.targetPublicKey);
    roles.delete(change.targetPublicKey);
  }
  return { ...roster, members, roles };
}
