// Minimal long-lived Nostr client for the Buzz relay.
//
// NIP-01 + NIP-42 against nostr-tools 2.24.x AbstractRelay:
//  - `ws` injected explicitly: globalThis.WebSocket on Node 22 has no .ping(),
//    so enablePing would silently degrade to a dummy REQ without it.
//  - `onauth` set once: AbstractRelay re-AUTHs on every AUTH frame, including
//    after reconnect.
//  - Own seen-id LRU: resubscribe advances `since = lastEmitted + 1`, which
//    silently skips events sharing created_at with the last emitted event, and
//    duplicate delivery across overlapping filters is legal NIP-01.

import fs from "node:fs";
import WebSocket from "ws";
import { AbstractRelay } from "nostr-tools/abstract-relay";
import { finalizeEvent, getPublicKey, verifyEvent } from "nostr-tools/pure";
import * as nip19 from "nostr-tools/nip19";

export const KIND_CHANNEL_MESSAGE = 9;
export const KIND_TYPING = 20002;
export const KIND_MEMBER_ADDED = 44100;
export const KIND_MEMBER_REMOVED = 44101;

export function decodeBuzzPrivateKey(material) {
  const trimmed = material?.trim();
  if (!trimmed) throw new Error("buzz: empty private key material");
  if (/^[0-9a-f]{64}$/i.test(trimmed)) return hexToBytes(trimmed.toLowerCase());
  if (trimmed.startsWith("nsec1")) {
    const decoded = nip19.decode(trimmed);
    if (decoded.type !== "nsec") throw new Error(`buzz: expected nsec, got ${decoded.type}`);
    return decoded.data;
  }
  throw new Error("buzz: private key must be 64-char hex or nsec1…");
}

export function loadBuzzPrivateKey(account) {
  if (account.privateKey) return decodeBuzzPrivateKey(account.privateKey);
  if (account.keyFile) return decodeBuzzPrivateKey(fs.readFileSync(account.keyFile, "utf8"));
  throw new Error(`buzz account ${account.accountId}: no private key (${account.keySource})`);
}

function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

class SeenLru {
  constructor(max = 10_000) {
    this.max = max;
    this.map = new Map();
  }
  has(id) {
    return this.map.has(id);
  }
  add(id) {
    if (this.map.has(id)) this.map.delete(id);
    this.map.set(id, true);
    if (this.map.size > this.max) this.map.delete(this.map.keys().next().value);
  }
}

export class BuzzRelayClient {
  constructor(params) {
    this.url = params.url;
    this.secretKey = params.secretKey;
    this.pubkey = getPublicKey(params.secretKey);
    this.log = params.log;
    this.relay = null;
    this.seen = new SeenLru();
    /** LRU of event ids this client published — reply_to_bot detection. */
    this.ownEventIds = new SeenLru(2_000);
    this.subs = [];
    /** pubkey → display name, from kind:0. Negative results cached as null. */
    this.profileNames = new Map();
    this.profileInflight = new Map();
  }

  /**
   * Resolve a pubkey to its kind:0 display name, cached.
   *
   * Without this an inbound envelope shows the author as a raw 64-hex string,
   * which reads to an agent as an unidentified participant — enough for a
   * group-chat prompt to decide a direct question isn't worth answering.
   * Returns undefined when the relay has no profile or the lookup fails; the
   * caller falls back to a short pubkey.
   */
  async resolveProfileName(pubkey, { timeoutMs = 2_000 } = {}) {
    const key = String(pubkey).toLowerCase();
    if (this.profileNames.has(key)) return this.profileNames.get(key) ?? undefined;
    if (this.profileInflight.has(key)) return await this.profileInflight.get(key);
    if (!this.relay) return undefined;

    const pending = new Promise((resolve) => {
      let done = false;
      let sub;
      const finish = (name) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          sub?.close("profile-resolved");
        } catch {}
        this.profileNames.set(key, name ?? null);
        this.profileInflight.delete(key);
        resolve(name);
      };
      const timer = setTimeout(() => finish(undefined), timeoutMs);
      try {
        // Not this.subscribe(): that dedups against the shared seen-LRU and
        // registers for shutdown; this is a short-lived one-shot query.
        sub = this.relay.subscribe([{ kinds: [0], authors: [key], limit: 1 }], {
          label: `profile:${key.slice(0, 8)}`,
          onevent: (event) => {
            let name;
            try {
              const meta = JSON.parse(event.content || "{}");
              name = meta.display_name || meta.name || undefined;
            } catch {}
            finish(typeof name === "string" && name.trim() ? name.trim() : undefined);
          },
          oneose: () => finish(undefined),
          onclose: () => finish(undefined),
        });
      } catch (err) {
        this.log?.info?.(`buzz: profile lookup ${key.slice(0, 8)} failed: ${String(err)}`);
        finish(undefined);
      }
    });
    this.profileInflight.set(key, pending);
    return await pending;
  }

  async connect() {
    const relay = new AbstractRelay(this.url, {
      verifyEvent,
      websocketImplementation: WebSocket,
      enablePing: true,
      enableReconnect: true,
    });
    const signer = (evtTemplate) => finalizeEvent(evtTemplate, this.secretKey);
    // onauth covers re-AUTH after reconnect (AbstractRelay calls it on every
    // AUTH frame). It does NOT gate subscribe(): Buzz rejects unauthenticated
    // REQs with CLOSED and nostr-tools never retries them, so the initial
    // connect must complete one AUTH round-trip before any subscription.
    relay.onauth = signer;
    // AbstractRelay's internal auto-auth does `this.auth(onauth).catch(cb)`
    // where cb RE-THROWS anything except SendingOnClosedConnection — an
    // ["OK", …, false, "restricted: …"] therefore becomes an unhandled
    // rejection and kills the whole gateway process. Wrap auth() so it can
    // never reject; connect() checks lastAuthError and fails hard itself.
    const rawAuth = relay.auth.bind(relay);
    this.lastAuthError = null;
    relay.auth = (sign) =>
      rawAuth(sign).then(
        (ok) => {
          this.lastAuthError = null;
          return ok;
        },
        (err) => {
          this.lastAuthError = err instanceof Error ? err : new Error(String(err));
          this.log?.error?.(`buzz: NIP-42 auth failed (${this.url}): ${String(err)}`);
          return `auth-failed: ${String(err)}`;
        },
      );
    relay.onnotice = (msg) => this.log?.info?.(`buzz relay NOTICE: ${msg}`);
    relay.onclose = () => this.log?.info?.(`buzz relay connection closed (${this.url})`);
    try {
      await relay.connect();
      // Wait for the NIP-42 challenge before admitting subscriptions.
      const deadline = Date.now() + 10_000;
      while (!relay.challenge && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 50));
      }
      if (!relay.challenge) throw new Error(`buzz: no AUTH challenge from ${this.url} within 10s`);
      await relay.auth(signer);
      if (this.lastAuthError) throw this.lastAuthError;
      this.relay = relay;
      this.log?.info?.(`buzz: connected+authed to ${this.url} as ${this.pubkey.slice(0, 12)}…`);
      return this;
    } catch (err) {
      // Failed admission must not leave an unowned socket/reconnect loop alive.
      relay.skipReconnection = true;
      try { relay.close(); } catch {}
      this.relay = null;
      throw err;
    }
  }

  /** Subscribe with dedup; onEvent only sees each event id once per client. */
  subscribe(filters, { label, onEvent }) {
    if (!this.relay) throw new Error("buzz: subscribe before connect");
    const sub = this.relay.subscribe(filters, {
      label,
      onevent: (event) => {
        if (this.seen.has(event.id)) return;
        this.seen.add(event.id);
        try {
          onEvent(event);
        } catch (err) {
          this.log?.error?.(`buzz: onEvent(${label}) failed: ${String(err)}`);
        }
      },
      oneose: () => {},
      onclose: (reason) => this.log?.info?.(`buzz: sub ${label} closed: ${reason}`),
    });
    this.subs.push(sub);
    return sub;
  }

  async publish(template) {
    if (!this.relay) throw new Error("buzz: publish before connect");
    const event = finalizeEvent(
      { created_at: Math.floor(Date.now() / 1000), ...template },
      this.secretKey,
    );
    await this.relay.publish(event);
    this.ownEventIds.add(event.id);
    this.seen.add(event.id); // never re-ingest our own outbound
    return event;
  }

  /**
   * Latest replaceable event per kind for this client's own pubkey.
   *
   * Used by profile sync so we can decide whether anything actually needs
   * republishing, instead of clobbering a human-set display name on every
   * reconnect. Resolves on EOSE, or on timeout with whatever arrived — a relay
   * that never sends EOSE must not wedge startup.
   */
  async queryOwnReplaceable(kinds, { timeoutMs = 5_000 } = {}) {
    const latest = new Map();
    if (!this.relay) return latest;
    return await new Promise((resolve) => {
      let done = false;
      let sub;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try {
          sub?.close("replaceable-query-complete");
        } catch {}
        resolve(latest);
      };
      const timer = setTimeout(finish, timeoutMs);
      try {
        sub = this.relay.subscribe(
          kinds.map((kind) => ({ kinds: [kind], authors: [this.pubkey], limit: 1 })),
          {
            label: `own-replaceable:${String(this.pubkey).slice(0, 8)}`,
            onevent: (event) => {
              const current = latest.get(event.kind);
              if (!current || event.created_at > current.created_at) latest.set(event.kind, event);
            },
            oneose: finish,
            onclose: finish,
          },
        );
      } catch {
        finish();
      }
      if (done) {
        try {
          sub?.close("replaceable-query-complete");
        } catch {}
      }
    });
  }

  async publishChannelMessage({ conversationId, content, tags = [] }) {
    return await this.publish({
      kind: KIND_CHANNEL_MESSAGE,
      content,
      tags: [["h", conversationId], ...tags],
    });
  }

  async publishTyping({ conversationId }) {
    // Ephemeral, not h-scoped by the relay but harmless to include context.
    try {
      await this.publish({ kind: KIND_TYPING, content: "", tags: conversationId ? [["h", conversationId]] : [] });
    } catch (err) {
      this.log?.info?.(`buzz: typing publish skipped: ${String(err)}`);
    }
  }

  close() {
    for (const sub of this.subs.splice(0)) {
      try {
        sub.close("shutdown");
      } catch {}
    }
    if (this.relay) {
      this.relay.skipReconnection = true;
      try {
        this.relay.close();
      } catch {}
      this.relay = null;
    }
  }
}

/** NIP-10 threading tags for a Buzz kind:9 reply. Unknown parents are rejected by the relay. */
export function buildReplyTags({ rootId, parentId }) {
  if (!parentId && !rootId) return [];
  if (!rootId || rootId === parentId) return [["e", parentId ?? rootId, "", "reply"]];
  return [
    ["e", rootId, "", "root"],
    ["e", parentId, "", "reply"],
  ];
}

/** Extract NIP-10 thread context from a kind:9 event's tags. */
export function parseThreadTags(event) {
  const eTags = (event.tags ?? []).filter((t) => t[0] === "e");
  if (eTags.length === 0) return { rootId: undefined, parentId: undefined };
  const marked = new Map();
  for (const tag of eTags) {
    const marker = tag[3];
    if (marker && !marked.has(marker)) marked.set(marker, tag[1]);
  }
  if (marked.size > 0) {
    const rootId = marked.get("root") ?? marked.get("reply");
    const parentId = marked.get("reply") ?? marked.get("root");
    return { rootId, parentId };
  }
  // Positional fallback (NIP-10 deprecated form): first = root, last = reply.
  return { rootId: eTags[0][1], parentId: eTags[eTags.length - 1][1] };
}

export function conversationIdFromEvent(event) {
  const h = (event.tags ?? []).find((t) => t[0] === "h");
  return h?.[1]?.trim() || undefined;
}

/**
 * Pubkeys this event addresses.
 *
 * Both `p` and `mention` tags count. The Buzz desktop composer emits
 * `["mention", <pubkey>]` — NOT a p tag — when a human picks an agent from the
 * @-autocomplete; observed live 2026-07-31 on a v0.5.2 relay:
 *   tags = [["h", <channel>], ["mention", "fdb1698c…"]]
 * Treating `mention` as a non-notifying reference (the earlier assumption here)
 * therefore dropped every desktop @-mention of an external agent on the floor.
 */
export function mentionedPubkeys(event) {
  return (event.tags ?? [])
    .filter((t) => (t[0] === "p" || t[0] === "mention") && typeof t[1] === "string")
    .map((t) => t[1].toLowerCase());
}
