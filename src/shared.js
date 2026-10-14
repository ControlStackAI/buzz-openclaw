// Buzz channel plugin — shared config resolution + metadata.
//
// Config shape (channels.buzz):
// {
//   relay: "ws://127.0.0.1:3000",
//   projectsIndexPath: "~/.openclaw/projects/index.json",   // optional override
//   groupPolicy: "allowlist",                                // allowlist | open
//   channels: {                                              // NIP-29 conversations, keyed by relay UUID (canonical form, case-sensitive)
//     "<conversation-uuid>": {
//       allow: true,
//       sessionKey: "agent:main:project:<slug>",             // explicit declared session key (constraint 2, tier 1)
//       project: "<slug>",                                   // declared project → sessionKey from projects index (constraint 2, tier 2)
//       requireMention: true,
//       allowFrom: ["<pubkey-hex>", ...]                     // author allowlist for this conversation
//     }
//   },
//   allowFrom: ["<pubkey-hex>", ...],                        // channel-wide author allowlist (operator public keys)
//   accounts: {
//     main: { name: "ALINA", privateKey: "...", privateKeyEnv: "BUZZ_KEY_MAIN", privateKeyFile: "/run/..." },
//     ...
//   },
//   defaultAccount: "main"
// }

export const BUZZ_CHANNEL_ID = "buzz";
export const BUZZ_DEFAULT_ACCOUNT_ID = "main";
export const BUZZ_DEFAULT_RELAY = "ws://127.0.0.1:3000";
export const BUZZ_MAX_CONTENT_BYTES = 64 * 1024;
export const BUZZ_MAX_P_TAGS = 50;

export const buzzMeta = {
  id: BUZZ_CHANNEL_ID,
  label: "Buzz",
  selectionLabel: "Buzz (Nostr relay)",
  docsPath: "/channels/buzz",
  docsLabel: "buzz",
  blurb: "Buzz relay over native Nostr: NIP-01 + NIP-42 + NIP-29 kind:9, one npub per agent.",
  detailLabel: "Buzz",
  order: 73,
};

export function getChannelConfig(cfg) {
  return cfg?.channels?.[BUZZ_CHANNEL_ID] ?? {};
}

export function getAccounts(cfg) {
  return getChannelConfig(cfg).accounts ?? {};
}

/** Per-account override supports a one-identity canary before fleet rollout. */
export function shouldPublishAgentDirectory(channel, accountConfig) {
  return accountConfig?.publishAgentDirectory ?? channel?.publishAgentDirectory === true;
}

/**
 * Canonical conversation id form: the relay's UUID exactly as it appears in the
 * `h` tag / kind-39000 `d` tag. Trim only — ids compare case-sensitively in
 * route bindings (normalizeRouteBindingId trims, never case-folds), so we must
 * emit the relay's form verbatim and keep it stable.
 */
export function canonicalConversationId(raw) {
  const trimmed = typeof raw === "string" ? raw.trim() : "";
  return trimmed || undefined;
}

export function listBuzzAccountIds(cfg) {
  return Object.keys(getAccounts(cfg));
}

export function resolveDefaultBuzzAccountId(cfg) {
  const channel = getChannelConfig(cfg);
  const explicit = channel.defaultAccount?.trim();
  if (explicit) return explicit;
  const ids = listBuzzAccountIds(cfg);
  if (ids.includes(BUZZ_DEFAULT_ACCOUNT_ID)) return BUZZ_DEFAULT_ACCOUNT_ID;
  return ids[0] ?? BUZZ_DEFAULT_ACCOUNT_ID;
}

function readPrivateKeyMaterial(accountConfig) {
  const inline = accountConfig.privateKey?.trim();
  if (inline) return { value: inline, source: "config" };
  const envName = accountConfig.privateKeyEnv?.trim();
  if (envName) {
    const fromEnv = process.env[envName]?.trim();
    if (fromEnv) return { value: fromEnv, source: `env:${envName}` };
    return { value: undefined, source: `env:${envName} (unset)` };
  }
  const file = accountConfig.privateKeyFile?.trim();
  if (file) return { value: undefined, source: `file:${file}`, file };
  return { value: undefined, source: "missing" };
}

export function resolveBuzzAccount(params) {
  const cfg = params.cfg;
  const channel = getChannelConfig(cfg);
  const accountId = params.accountId?.trim() || resolveDefaultBuzzAccountId(cfg);
  const config = getAccounts(cfg)[accountId] ?? {};
  const key = readPrivateKeyMaterial(config);
  const relay = config.relay?.trim() || channel.relay?.trim() || BUZZ_DEFAULT_RELAY;
  const resolved = {
    accountId,
    enabled: config.enabled !== false,
    name: config.name?.trim() || accountId,
    relay,
    keySource: key.source,
    keyFile: key.file,
    privateKey: key.value,
    config,
  };
  const reasons = [];
  if (!config || Object.keys(config).length === 0) reasons.push(`no channels.buzz.accounts.${accountId} entry`);
  else if (!key.value && !key.file) reasons.push(`missing private key (${key.source})`);
  return {
    ...resolved,
    configured: reasons.length === 0,
    unconfiguredReason: reasons.length > 0 ? reasons.join("; ") : undefined,
  };
}

/** Per-conversation policy with channel-level fallbacks. */
export function resolveConversationPolicy(params) {
  const channel = getChannelConfig(params.cfg);
  const conversationId = canonicalConversationId(params.conversationId);
  const entry = conversationId ? (channel.channels?.[conversationId] ?? null) : null;
  const groupPolicy = channel.groupPolicy?.trim() || "allowlist";
  return {
    conversationId,
    listed: entry != null,
    allowed: groupPolicy === "open" ? entry?.allow !== false : entry != null && entry.allow !== false,
    requireMention: entry?.requireMention ?? true,
    // Default ON: until upstream #2603 lands, the desktop emits no p tag for
    // external agents, so p-tag-only gating drops every human mention.
    textMention: entry?.textMention ?? channel.textMention ?? true,
    allowFrom: [...(channel.allowFrom ?? []), ...(entry?.allowFrom ?? [])].map((s) => String(s).trim().toLowerCase()).filter(Boolean),
    sessionKey: entry?.sessionKey?.trim() || undefined,
    project: entry?.project?.trim() || undefined,
    // Slack parity (docs/channels/slack.md "Threading, sessions, and reply
    // tags"): thread replies get a `:thread:<root>` session suffix, top-level
    // messages stay on the conversation session. Default ON so a Buzz thread
    // is as isolated as a Slack thread.
    threadSessions: entry?.threadSessions ?? channel.threadSessions ?? true,
    // "channel" (default): keep top-level replies on the bound conversation.
    // "thread": answer with NIP-10 e-tags, rendered by the desktop as a new
    // thread off the inbound message.
    replyMode: (entry?.replyMode ?? channel.replyMode ?? "channel").trim(),
  };
}

const accountKeySchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    name: { type: "string" },
    relay: { type: "string" },
    privateKey: { type: "string" },
    privateKeyEnv: { type: "string" },
    privateKeyFile: { type: "string" },
    mentionAliases: { type: "array", items: { type: "string" } },
    publishAgentDirectory: { type: "boolean" },
  },
};

export const buzzChannelConfigSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    enabled: { type: "boolean" },
    relay: { type: "string" },
    projectsIndexPath: { type: "string" },
    groupPolicy: { type: "string", enum: ["allowlist", "open"] },
    defaultAccount: { type: "string" },
    allowFrom: { type: "array", items: { type: "string" } },
    mentionDirectory: { type: "object", additionalProperties: { type: "string" } },
    publishAgentDirectory: { type: "boolean" },
    textMention: { type: "boolean" },
    threadSessions: { type: "boolean" },
    replyMode: { type: "string", enum: ["thread", "channel"] },
    channels: {
      type: "object",
      additionalProperties: {
        type: "object",
        additionalProperties: false,
        properties: {
          allow: { type: "boolean" },
          sessionKey: { type: "string" },
          project: { type: "string" },
          requireMention: { type: "boolean" },
          textMention: { type: "boolean" },
          threadSessions: { type: "boolean" },
          replyMode: { type: "string", enum: ["thread", "channel"] },
          allowFrom: { type: "array", items: { type: "string" } },
        },
      },
    },
    accounts: { type: "object", additionalProperties: accountKeySchema },
  },
};
