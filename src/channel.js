// Buzz channel plugin — NIP-01/42/29 kind:9 chat against the self-hosted Buzz
// relay. Buzz is a transport: OpenClaw stays authoritative for auth, skills,
// memory, and routing.
//
// The two project-model constraints live here and are covered by test/:
//  1. Inbound routes through resolveAgentRoute WITH a peer
//     ({kind:"channel", id:<relay-canonical conversation uuid>}); ids compare
//     case-sensitively, so the id is passed verbatim (trim only).
//  2. A bound conversation addresses its declared project session key
//     (resolveDeclaredSessionKey) instead of minting
//     agent:<id>:buzz:channel:<conv>.

import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";
import { implicitMentionKindWhen, resolveInboundMentionDecision } from "openclaw/plugin-sdk/channel-mention-gating";
import { createClaimableDedupe } from "openclaw/plugin-sdk/persistent-dedupe";
import { getPublicKey } from "nostr-tools/pure";

import {
  BUZZ_CHANNEL_ID,
  BUZZ_MAX_P_TAGS,
  buzzChannelConfigSchema,
  buzzMeta,
  canonicalConversationId,
  getChannelConfig,
  listBuzzAccountIds,
  resolveBuzzAccount,
  resolveConversationPolicy,
  resolveDefaultBuzzAccountId,
  shouldPublishAgentDirectory,
} from "./shared.js";
import { resolveDeclaredSessionKey } from "./session-map.js";
import { startPresenceHeartbeat } from "./presence.js";
import { AGENT_PROFILE_KIND, PROFILE_KIND, planProfileSync } from "./profile-sync.js";
import { uploadBuzzMedia } from "./media.js";
import { loadAuthTags, normalizeAuthTag } from "./auth-tags.js";
import { createBuzzReplayGuard } from "./replay-guard.js";
import {
  BuzzRelayClient,
  KIND_MEMBER_ADDED,
  KIND_MEMBER_REMOVED,
  KIND_CHANNEL_MESSAGE,
  buildReplyTags,
  conversationIdFromEvent,
  loadBuzzPrivateKey,
  mentionedPubkeys,
  parseThreadTags,
} from "./nostr-client.js";

/** accountId -> { client, account } for outbound sends + typing. */
const activeClients = new Map();

export function normalizeBuzzTarget(target) {
  const trimmed = target?.trim();
  if (!trimmed) return undefined;
  return trimmed.replace(/^buzz:/i, "").replace(/^(channel|conversation|group):/i, "").trim() || undefined;
}

/**
 * The peer the plugin hands to resolveAgentRoute (constraint 1). Exported so
 * the routing probe exercises the exact production shape.
 */
export function buildBuzzRoutePeer({ conversationId, chatType = "channel" }) {
  const id = canonicalConversationId(conversationId);
  if (!id) throw new Error("buzz: conversation id required for route peer");
  return { kind: chatType === "direct" ? "direct" : "channel", id };
}

/**
 * Build one live message subscription per conversation.
 *
 * Buzz relay 0.2.x classifies a REQ containing multiple #h values as global.
 * Global subscriptions intentionally cannot receive channel-scoped events, so
 * combining conversations into one filter silently disables live delivery.
 */
export function buildMessageSubscriptionSpecs({ accountId, conversationIds, since }) {
  return conversationIds.map((conversationId) => ({
    filters: [{ kinds: [KIND_CHANNEL_MESSAGE], "#h": [conversationId], since }],
    label: `buzz:${accountId}:messages:${conversationId}`,
  }));
}

/**
 * Declared-session override (constraint 2): bound conversations land on the
 * project session key; unbound conversations keep the route's own key.
 * Exported for the session-addressing probe.
 */
export function resolveBuzzSessionKey({ cfg, route, conversationId, policy, log }) {
  const declared = resolveDeclaredSessionKey({ cfg, conversationId, policy, log });
  let sessionKey = declared?.sessionKey;
  // Project records have one canonical key (normally agent:main:...), while a
  // shared Buzz room can route to any fleet account. Keep the project
  // namespace but use the agent selected by resolveAgentRoute. An explicit
  // per-conversation sessionKey remains exact by design.
  if (sessionKey && declared.source !== "config.sessionKey" && route.agentId) {
    sessionKey = sessionKey.replace(/^agent:[^:]+:/i, `agent:${route.agentId}:`);
  }
  if (sessionKey && sessionKey !== route.sessionKey) {
    log?.info?.(`buzz: conversation ${conversationId} → declared session ${sessionKey} (${declared.source})`);
  }
  return { sessionKey: sessionKey ?? route.sessionKey, declaredSource: declared?.source };
}

/**
 * Which thread, if any, this event's session belongs to (Slack parity).
 *
 * Slack: `agent:<id>:slack:channel:<chan>:thread:<threadTs>` for thread
 * replies, plain channel key for top-level messages — and it *seeds* an
 * eligible top-level root into the thread session so the root and the replies
 * that follow share one session (docs/channels/slack.md, "Threading, sessions,
 * and reply tags"). Verified against this host's own history, e.g.
 * `agent:main:slack:channel:c0bhp68cdl5:thread:1784404386.491209`.
 *
 * Buzz's analogue of `thread_ts` is the NIP-10 root event id. Seeding applies
 * when we are about to answer with e-tags (`replyMode: "thread"`), because that
 * is exactly when the desktop will render our answer as a new thread off this
 * message — the same "expected to start a visible thread" condition Slack uses.
 *
 * Returns undefined when the message belongs on the conversation session.
 */
export function resolveBuzzThreadRoot({ event, rootId, parentId, policy }) {
  if (!policy.threadSessions) return undefined;
  // A reply: NIP-10 root marker, falling back to the parent for a one-deep
  // reply that carries only a `reply` marker.
  if (rootId || parentId) return rootId ?? parentId;
  // Top-level. Seeded only if our answer will open a thread on it.
  return policy.replyMode === "thread" ? event.id : undefined;
}

/** Apply the thread suffix to whatever base key the conversation resolved to. */
export function applyBuzzThreadSuffix({ sessionKey, threadRoot }) {
  if (!threadRoot || !sessionKey) return sessionKey;
  return `${sessionKey}:thread:${threadRoot}`;
}

/**
 * `@Name` matcher shared by the outbound tag builder and the inbound text
 * fallback, so the two can never drift on escaping or boundary rules.
 */
export function mentionPattern(name) {
  return new RegExp(`@${String(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\w-])`, "i");
}

/**
 * Inbound counterpart to the outbound tag builder (upstream block/buzz#2663
 * gap 5, #2603): the desktop's @-selector only offers desktop-managed agents,
 * so a human addressing an external agent emits plain text and NO p tag. Field
 * reports on #2663 confirm it — both live mentions there carried only an `h`
 * tag. Without this, a p-tag-only gate silently drops every human mention.
 *
 * Deliberately narrow: a literal `@<name>` run for one of *this account's* own
 * names. Anything looser would let an agent be steered by prose about it.
 */
export function textMentionsSelf({ text, names }) {
  if (!text) return false;
  for (const name of names) {
    const trimmed = String(name ?? "").trim();
    if (!trimmed) continue;
    if (mentionPattern(trimmed).test(text)) return true;
  }
  return false;
}

/** Names this account answers to in plain text: display name, id, aliases. */
export function selfMentionNames({ account, cfg }) {
  const channel = getChannelConfig(cfg);
  const configured = channel.accounts?.[account.accountId]?.mentionAliases ?? [];
  return [account.name, account.accountId, ...configured].filter(Boolean);
}

/** Translate agent-emitted @Name runs into p tags via the configured directory. */
export function buildOutboundMentionTags({ cfg, text, selfPubkey }) {
  const directory = { ...(getChannelConfig(cfg).mentionDirectory ?? {}) };
  for (const [accountId, entry] of activeClients) {
    const name = entry.account?.name || accountId;
    if (!directory[name]) directory[name] = entry.client.pubkey;
  }
  const tags = [];
  const seen = new Set();
  for (const [name, pubkey] of Object.entries(directory)) {
    if (typeof pubkey !== "string" || !/^[0-9a-f]{64}$/i.test(pubkey)) continue;
    const normalized = pubkey.toLowerCase();
    if (normalized === selfPubkey) continue;
    if (seen.has(normalized)) continue;
    if (!mentionPattern(name).test(text)) continue;
    seen.add(normalized);
    tags.push(["p", normalized]);
    if (tags.length >= BUZZ_MAX_P_TAGS) break;
  }
  return tags;
}

function shortPubkey(pubkey) {
  return `${pubkey.slice(0, 8)}…${pubkey.slice(-4)}`;
}

/**
 * NIP-OA owner attestation tag for this account's kind:0 profile.
 *
 * Per-account wins over channel-wide, because the attestation binds a specific
 * agent pubkey to its human owner — a single shared tag would be wrong for 17
 * identities. Accepts either a ready-made tag array or the bare attestation
 * value. Returns undefined when unset, which leaves the profile untouched
 * rather than publishing an empty `auth` tag.
 */
export function resolveAuthTag(channelCfg, account, fileTags) {
  const raw = account?.authTag ?? channelCfg?.authTag;
  const configured = normalizeAuthTag(
    typeof raw === "string" && raw.trim() ? safeParseTag(raw.trim()) : raw,
  );
  if (configured) return configured;
  // Fall back to the file store, keyed by account id — the normal path, since
  // an attestation is a secret and does not belong in declarative config.
  return fileTags?.get(account?.accountId) ?? fileTags?.get(account?.name);
}

function safeParseTag(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function fleetPubkeys(cfg, log) {
  const keys = new Set();
  for (const accountId of listBuzzAccountIds(cfg)) {
    const account = resolveBuzzAccount({ cfg, accountId });
    try {
      if (account.privateKey || account.keyFile) keys.add(getPublicKey(loadBuzzPrivateKey(account)));
    } catch (err) {
      log?.warn?.(`buzz: cannot derive pubkey for account ${accountId}: ${String(err)}`);
    }
  }
  return keys;
}

function waitUntilAbort(signal, onAbort) {
  return new Promise((resolve) => {
    const complete = () => {
      onAbort?.();
      resolve();
    };
    if (!signal) return;
    if (signal.aborted) {
      complete();
      return;
    }
    signal.addEventListener("abort", complete, { once: true });
  });
}

async function deliverInbound({ event, account, client, channelRuntime, getCfg, log, fleet }) {
  const cfg = getCfg();
  const conversationId = conversationIdFromEvent(event);
  if (!conversationId) return;
  const author = event.pubkey.toLowerCase();

  // Self/sibling suppression: never react to our own fleet's messages.
  if (author === client.pubkey.toLowerCase() || fleet.has(author)) return;

  const policy = resolveConversationPolicy({ cfg, conversationId });
  if (!policy.allowed) {
    log?.info?.(`buzz: drop event ${event.id.slice(0, 8)} — conversation ${conversationId} not allowlisted`);
    return;
  }
  // Author gate (mirrors hardenSlack): with an allowFrom list, only listed
  // pubkeys may trigger. An empty list fails closed in allowlist-group mode.
  if (policy.allowFrom.length > 0 ? !policy.allowFrom.includes(author) : true) {
    log?.info?.(`buzz: drop event ${event.id.slice(0, 8)} — author ${shortPubkey(author)} not in allowFrom`);
    return;
  }

  const { parentId, rootId } = parseThreadTags(event);
  const mentions = mentionedPubkeys(event);
  const selfPubkey = client.pubkey.toLowerCase();
  const isReplyToBot = Boolean(parentId && client.ownEventIds.has(parentId));
  const pTagged = mentions.includes(selfPubkey);
  const textMentioned =
    !pTagged &&
    policy.textMention &&
    textMentionsSelf({ text: event.content ?? "", names: selfMentionNames({ account, cfg }) });
  if (textMentioned) {
    log?.info?.(`buzz: event ${event.id.slice(0, 8)} — text mention of ${account.name} with no p tag (upstream #2603)`);
  }
  const decision = resolveInboundMentionDecision({
    facts: {
      canDetectMention: true,
      wasMentioned: pTagged || textMentioned,
      hasAnyMention: mentions.length > 0,
      implicitMentionKinds: implicitMentionKindWhen("reply_to_bot", isReplyToBot),
    },
    policy: {
      isGroup: true,
      requireMention: policy.requireMention,
      allowedImplicitMentionKinds: ["reply_to_bot"],
      allowTextCommands: false,
      hasControlCommand: false,
      commandAuthorized: false,
    },
  });
  if (decision.shouldSkip) return;

  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg,
    channel: BUZZ_CHANNEL_ID,
    accountId: account.accountId,
    peer: buildBuzzRoutePeer({ conversationId }),
    runtime: channelRuntime,
    sessionStore: cfg.session?.store,
  });
  const { sessionKey: baseSessionKey } = resolveBuzzSessionKey({ cfg, route, conversationId, policy, log });
  const threadRoot = resolveBuzzThreadRoot({ event, rootId, parentId, policy });
  const sessionKey = applyBuzzThreadSuffix({ sessionKey: baseSessionKey, threadRoot });
  if (threadRoot) {
    log?.info?.(`buzz: event ${event.id.slice(0, 8)} → thread session ${sessionKey}`);
  }

  const senderId = event.pubkey;
  // A bare 64-hex author reads as an unidentified participant and invites a
  // NO_REPLY from group-chat prompts; prefer the kind:0 display name.
  const profileName = await client.resolveProfileName?.(senderId).catch(() => undefined);
  const senderName = profileName || shortPubkey(senderId);
  const { storePath, body } = buildEnvelope({
    channel: "Buzz",
    from: senderName,
    timestamp: event.created_at * 1000,
    body: event.content,
  });
  const msgCtx = channelRuntime.reply.finalizeInboundContext({
    Body: body,
    RawBody: event.content,
    CommandBody: event.content,
    From: `${BUZZ_CHANNEL_ID}:${senderId}`,
    To: `${BUZZ_CHANNEL_ID}:${conversationId}`,
    SessionKey: sessionKey,
    AccountId: account.accountId,
    OriginatingChannel: BUZZ_CHANNEL_ID,
    OriginatingTo: `${BUZZ_CHANNEL_ID}:${conversationId}`,
    ChatType: "channel",
    SenderName: senderName,
    SenderId: senderId,
    Provider: BUZZ_CHANNEL_ID,
    Surface: BUZZ_CHANNEL_ID,
    ConversationLabel: conversationId,
    MessageSid: event.id,
    ReplyToId: event.id,
    Timestamp: event.created_at * 1000,
    WasMentioned: decision.effectiveWasMentioned,
    CommandAuthorized: true,
  });
  channelRuntime.session
    .recordSessionMetaFromInbound({ storePath, sessionKey: msgCtx.SessionKey ?? sessionKey, ctx: msgCtx })
    .catch((err) => log?.warn?.(`buzz: session meta: ${String(err)}`));

  await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: msgCtx,
    cfg,
    dispatcherOptions: {
      deliver: async (payload) => {
        const outText = payload?.text ?? payload?.body;
        if (!outText?.trim()) return;
        // replyMode "channel": answer flat, the way Slack replies in-channel by
        // default. Only suppressible for a top-level message — inside a thread
        // an untagged reply would escape the thread it belongs to.
        const inThread = Boolean(rootId || parentId);
        const replyTags =
          policy.replyMode === "channel" && !inThread
            ? []
            : buildReplyTags({ rootId: rootId ?? event.id, parentId: event.id });
        // Do NOT auto-p the human being replied to — thread e-tags carry that
        // context; auto-p would ping on every reply.
        const mentionTags = buildOutboundMentionTags({ cfg, text: outText, selfPubkey });
        await client.publishChannelMessage({
          conversationId,
          content: outText,
          tags: [...replyTags, ...mentionTags],
        });
      },
      onReplyStart: () => {
        client.publishTyping({ conversationId }).catch(() => {});
      },
    },
  });
}

export const buzzPlugin = {
  id: BUZZ_CHANNEL_ID,
  meta: buzzMeta,
  capabilities: {
    chatTypes: ["channel"],
    blockStreaming: true,
    media: true,
  },
  reload: { configPrefixes: ["channels.buzz"] },
  configSchema: buzzChannelConfigSchema,
  messaging: {
    targetPrefixes: [BUZZ_CHANNEL_ID],
    normalizeTarget: normalizeBuzzTarget,
    parseExplicitTarget: ({ raw }) => {
      const to = normalizeBuzzTarget(raw);
      return to ? { to, chatType: "channel" } : null;
    },
    inferTargetChatType: () => "channel",
    targetResolver: {
      looksLikeId: (_raw, normalized) => Boolean(normalized?.trim()),
      hint: "<conversation_uuid|buzz:conversation_uuid>",
    },
  },
  config: {
    listAccountIds: listBuzzAccountIds,
    resolveAccount: (cfg, accountId) => resolveBuzzAccount({ cfg, accountId }),
    defaultAccountId: resolveDefaultBuzzAccountId,
    isConfigured: (account) => account.configured,
    unconfiguredReason: (account) => (account.configured ? undefined : account.unconfiguredReason ?? "not configured"),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: account.configured,
      relay: account.relay,
      credentialSource: account.keySource,
    }),
  },
  outbound: {
    deliveryMode: "direct",
    resolveTarget: ({ to }) => {
      const normalized = to ? normalizeBuzzTarget(to) : undefined;
      return normalized
        ? { ok: true, to: normalized }
        : { ok: false, error: new Error("Buzz target conversation uuid is required") };
    },
    sendText: async ({ cfg, to, text, accountId, replyToId }) => {
      const resolvedAccountId = accountId?.trim() || resolveDefaultBuzzAccountId(cfg);
      const entry = activeClients.get(resolvedAccountId);
      if (!entry) throw new Error(`buzz: account ${resolvedAccountId} is not connected`);
      const conversationId = normalizeBuzzTarget(to);
      if (!conversationId) throw new Error("buzz: missing conversation id");
      const tags = [
        ...(replyToId ? buildReplyTags({ parentId: String(replyToId) }) : []),
        ...buildOutboundMentionTags({ cfg, text, selfPubkey: entry.client.pubkey.toLowerCase() }),
      ];
      const event = await entry.client.publishChannelMessage({ conversationId, content: text, tags });
      return { channel: BUZZ_CHANNEL_ID, messageId: event.id, chatId: conversationId };
    },
    sendMedia: async ({
      cfg,
      to,
      text,
      mediaUrl,
      mediaAccess,
      mediaLocalRoots,
      mediaReadFile,
      accountId,
      replyToId,
    }) => {
      const resolvedAccountId = accountId?.trim() || resolveDefaultBuzzAccountId(cfg);
      const entry = activeClients.get(resolvedAccountId);
      if (!entry) throw new Error(`buzz: account ${resolvedAccountId} is not connected`);
      const conversationId = normalizeBuzzTarget(to);
      if (!conversationId) throw new Error("buzz: missing conversation id");
      if (!mediaUrl?.trim()) throw new Error("buzz: media URL or path is required");
      const { imeta } = await uploadBuzzMedia({
        relayUrl: entry.account.relay,
        secretKey: entry.client.secretKey,
        mediaUrl,
        mediaAccess,
        mediaLocalRoots,
        mediaReadFile,
      });
      const content = text?.trim() ?? "";
      const tags = [
        imeta,
        ...(replyToId ? buildReplyTags({ parentId: String(replyToId) }) : []),
        ...buildOutboundMentionTags({ cfg, text: content, selfPubkey: entry.client.pubkey.toLowerCase() }),
      ];
      const event = await entry.client.publishChannelMessage({ conversationId, content, tags });
      return { channel: BUZZ_CHANNEL_ID, messageId: event.id, chatId: conversationId };
    },
  },
  heartbeat: {
    sendTyping: async ({ cfg, to, accountId }) => {
      const entry = activeClients.get(accountId?.trim() || resolveDefaultBuzzAccountId(cfg));
      if (!entry) return;
      await entry.client.publishTyping({ conversationId: normalizeBuzzTarget(to) });
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const { cfg, accountId, log, abortSignal } = ctx;
      const account = resolveBuzzAccount({ cfg, accountId });
      if (!account.enabled) {
        log?.info?.(`buzz account ${accountId} disabled, skipping`);
        return waitUntilAbort(abortSignal);
      }
      if (!account.configured) {
        log?.warn?.(`buzz account ${accountId} not configured: ${account.unconfiguredReason ?? ""}`);
        return waitUntilAbort(abortSignal);
      }
      const channelRuntime = ctx.channelRuntime;
      if (!channelRuntime) {
        log?.error?.("buzz: channelRuntime unavailable; cannot dispatch replies");
        return waitUntilAbort(abortSignal);
      }
      let secretKey;
      try {
        secretKey = loadBuzzPrivateKey(account);
      } catch (err) {
        log?.error?.(`buzz account ${accountId}: ${String(err)}`);
        return waitUntilAbort(abortSignal);
      }
      const client = new BuzzRelayClient({ url: account.relay, secretKey, log });
      try {
        await client.connect();
      } catch (err) {
        log?.error?.(`buzz account ${accountId}: relay connect failed: ${String(err)}`);
        return waitUntilAbort(abortSignal);
      }
      activeClients.set(account.accountId, { client, account });
      const replayGuard = createBuzzReplayGuard({
        accountId,
        dedupe: createClaimableDedupe({
          pluginId: "buzz",
          namespacePrefix: "buzz.inbound-dedupe",
          ttlMs: 30 * 24 * 60 * 60 * 1000,
          memoryMaxSize: 10_000,
          stateMaxEntries: 50_000,
          onDiskError: (err) => log?.error?.(`buzz account ${accountId}: replay state failed: ${String(err)}`),
        }),
      });
      const fleet = fleetPubkeys(cfg, log);
      const getCfg = () => ctx.getCfg?.() ?? cfg;

      // Profile sync: kind:0 (what desktop autocomplete inserts and the
      // renderer chips) plus the kind:10100 agent-directory entry, and the
      // NIP-OA owner attestation when one is configured — Buzz shows
      // "owner unavailable" without it. Replaces an unconditional kind:0
      // republish that clobbered any display name a human had set in Buzz.
      void (async () => {
        try {
          const current = await client.queryOwnReplaceable([PROFILE_KIND, AGENT_PROFILE_KIND]);
          const authTag = resolveAuthTag(
            getChannelConfig(cfg),
            account,
            loadAuthTags({ onWarn: (m) => log?.warn?.(m) }),
          );
          if (!authTag) {
            log?.info?.(
              `buzz account ${accountId}: no NIP-OA attestation; Buzz will show "owner unavailable" until one is minted`,
            );
          }
          const plan = planProfileSync({
            displayName: account.name,
            authTag,
            publishAgentDirectory: shouldPublishAgentDirectory(getChannelConfig(cfg), account.config),
            channelIds: Object.entries(getChannelConfig(cfg).channels ?? {})
              .filter(([, policy]) => policy?.allow !== false)
              .map(([conversationId]) => conversationId),
            currentMetadata: current.get(PROFILE_KIND),
            currentAgentProfile: current.get(AGENT_PROFILE_KIND),
          });
          if (plan.length === 0) {
            log?.info?.(`buzz account ${accountId}: profile already current (${account.name})`);
            return;
          }
          for (const template of plan) await client.publish(template);
          log?.info?.(
            `buzz account ${accountId}: profile synced (${account.name}); kinds ${plan.map((e) => e.kind).join(",")}`,
          );
        } catch (err) {
          log?.warn?.(`buzz account ${accountId}: profile sync failed: ${String(err)}`);
        }
      })();

      // Ephemeral presence, republished every 30s. The relay drops it when the
      // last authed connection for this pubkey closes, so each agent shows
      // online independently rather than one bot standing in for the fleet.
      const stopPresence = startPresenceHeartbeat({
        publish: (template) => client.publish(template),
        onError: (err) => log?.warn?.(`buzz account ${accountId}: ${err.message}`),
      });

      const conversationIds = Object.keys(getChannelConfig(cfg).channels ?? {})
        .map(canonicalConversationId)
        .filter(Boolean);
      const sinceSec = Math.floor(Date.now() / 1000);
      if (conversationIds.length > 0) {
        // One firehose per allowlisted conversation (not #p-filtered): needed
        // for reply_to_bot, because thread replies do not p-tag the parent
        // author. Relay 0.2.x requires exactly one #h value for a subscription
        // to be indexed as channel-scoped.
        for (const spec of buildMessageSubscriptionSpecs({
          accountId,
          conversationIds,
          since: sinceSec,
        })) {
          client.subscribe(spec.filters, {
            label: spec.label,
            onEvent: (event) => {
              void replayGuard
                .process(event, () =>
                  deliverInbound({ event, account, client, channelRuntime, getCfg, log, fleet }),
                )
                .catch((err) =>
                  log?.error?.(`buzz: inbound ${event.id.slice(0, 8)} failed: ${String(err)}`),
                );
            },
          });
        }
      } else {
        log?.warn?.(`buzz account ${accountId}: no channels.buzz.channels allowlisted; listening for membership only`);
      }
      // Membership notifications ride this account's own authed socket —
      // p-gated kinds require #p == the authenticated pubkey.
      client.subscribe(
        [{ kinds: [KIND_MEMBER_ADDED, KIND_MEMBER_REMOVED], "#p": [client.pubkey], since: sinceSec }],
        {
          label: `buzz:${accountId}:membership`,
          onEvent: (event) => {
            const conv = conversationIdFromEvent(event) ?? "?";
            log?.info?.(
              `buzz account ${accountId}: ${event.kind === KIND_MEMBER_ADDED ? "added to" : "removed from"} conversation ${conv}`,
            );
          },
        },
      );
      log?.info?.(
        `buzz account ${accountId}: listening as ${shortPubkey(client.pubkey)} on ${account.relay} (${conversationIds.length} conversation(s))`,
      );
      activeClients.set(account.accountId, { client, account, stopPresence });
      return waitUntilAbort(abortSignal, () => {
        log?.info?.(`buzz: stopping account ${accountId}`);
        activeClients.delete(account.accountId);
        stopPresence();
        replayGuard.clearMemory();
        client.close();
      });
    },
    stopAccount: async (ctx) => {
      const entry = activeClients.get(ctx.accountId);
      if (entry) {
        activeClients.delete(ctx.accountId);
        entry.stopPresence?.();
        entry.client.close();
      }
      ctx.log?.info?.(`buzz account ${ctx.accountId} stopped`);
    },
  },
};

export const __testing = { activeClients, deliverInbound };
