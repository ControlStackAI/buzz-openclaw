// Conversation → declared session key mapping (constraint 2 of the project model).
//
// A bound conversation addresses the project's declared session
// (`agent:<id>:project:<slug>` from ~/.openclaw/projects/index.json) instead of
// minting `agent:<id>:buzz:channel:<conv>`. This is what unifies per-project
// history across Buzz + terminal + ACP + cron.
//
// Resolution order:
//   1. channels.buzz.channels.<conv>.sessionKey  — explicit declared key
//   2. channels.buzz.channels.<conv>.project     — slug → index record sessionKey
//   3. projects index entry whose channels[] contains {platform:"buzz", id:<conv>}
//   4. null → caller falls back to route.sessionKey

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { canonicalConversationId, getChannelConfig, resolveConversationPolicy } from "./shared.js";

export const DEFAULT_PROJECTS_INDEX_PATH = path.join(os.homedir(), ".openclaw", "projects", "index.json");

const INDEX_CACHE_TTL_MS = 15_000;
const indexCache = new Map(); // path -> { at, entries }

export function resolveProjectsIndexPath(cfg) {
  const configured = getChannelConfig(cfg).projectsIndexPath?.trim();
  if (!configured) return DEFAULT_PROJECTS_INDEX_PATH;
  if (configured.startsWith("~/")) return path.join(os.homedir(), configured.slice(2));
  return configured;
}

function loadProjectsIndex(indexPath, log) {
  const cached = indexCache.get(indexPath);
  if (cached && Date.now() - cached.at < INDEX_CACHE_TTL_MS) return cached.entries;
  let entries = [];
  try {
    const raw = JSON.parse(fs.readFileSync(indexPath, "utf8"));
    if (Array.isArray(raw)) {
      entries = raw
        .map((row) => (row && typeof row === "object" && "value" in row ? row.value : row))
        .filter((v) => v && typeof v === "object");
    } else if (raw && typeof raw === "object") {
      entries = Object.values(raw).filter((v) => v && typeof v === "object");
    }
  } catch (err) {
    if (err?.code !== "ENOENT") log?.warn?.(`buzz: projects index ${indexPath} unreadable: ${String(err)}`);
    entries = [];
  }
  indexCache.set(indexPath, { at: Date.now(), entries });
  return entries;
}

export function clearProjectsIndexCacheForTest() {
  indexCache.clear();
}

function isValidSessionKey(key) {
  return typeof key === "string" && /^agent:[a-z0-9_-]+:/i.test(key.trim());
}

function projectRecordSessionKey(record) {
  const key = record?.sessionKey;
  return isValidSessionKey(key) ? key.trim() : undefined;
}

/**
 * Resolve the declared session key for a Buzz conversation, or null when the
 * conversation is unbound (caller uses route.sessionKey).
 */
export function resolveDeclaredSessionKey(params) {
  const { cfg, conversationId, log } = params;
  const conv = canonicalConversationId(conversationId);
  if (!conv) return null;
  const policy = params.policy ?? resolveConversationPolicy({ cfg, conversationId: conv });

  if (policy.sessionKey) {
    if (isValidSessionKey(policy.sessionKey)) return { sessionKey: policy.sessionKey, source: "config.sessionKey" };
    log?.warn?.(`buzz: channels.${conv}.sessionKey "${policy.sessionKey}" is not a valid session key; ignoring`);
  }

  const indexPath = resolveProjectsIndexPath(cfg);
  const entries = loadProjectsIndex(indexPath, log);

  if (policy.project) {
    const record = entries.find((e) => e.project === policy.project);
    const key = projectRecordSessionKey(record);
    if (key) return { sessionKey: key, source: `config.project:${policy.project}` };
    log?.warn?.(`buzz: conversation ${conv} declares project "${policy.project}" but no index record with a sessionKey exists at ${indexPath}`);
  }

  for (const record of entries) {
    const channels = Array.isArray(record.channels) ? record.channels : [];
    const match = channels.some(
      (ch) => ch && ch.platform === "buzz" && canonicalConversationId(ch.id) === conv,
    );
    if (!match) continue;
    const key = projectRecordSessionKey(record);
    if (key) return { sessionKey: key, source: `index:${record.project ?? "?"}` };
  }

  return null;
}
