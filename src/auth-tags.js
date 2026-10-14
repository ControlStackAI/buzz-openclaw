/**
 * File-backed store for NIP-OA owner attestations.
 *
 * Why a file rather than declarative config: an attestation is a delegated,
 * reusable capability signed by the human owner's key — upstream's own docs say
 * to treat it as a secret and keep it out of source control. Our nix config is
 * a git repo, and agent lanes cannot edit sops, so attestations live beside
 * `agent-keys/` and `relay.env` in the same file-based store for the same
 * reason. Migrate all three into sops together when the operator re-keys.
 *
 * Format is exactly what `scripts/buzz-mint-auth-tags.mjs` prints, so its
 * output can be redirected into place with no reshaping:
 *
 *   {
 *     "coder":  { "pubkey": "<hex>", "authTag": ["auth", "<owner>", "", "<sig>"] },
 *     "main":   { ... }
 *   }
 *
 * A bare tag array per account is also accepted, since that is the other
 * obvious shape someone would hand-write.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const DEFAULT_AUTH_TAGS_PATH = path.join(os.homedir(), ".local/share/buzz/agent-auth-tags.json");

/**
 * A NIP-OA `auth` tag is exactly four elements. Anything else is malformed and
 * MUST be rejected — and a malformed tag is worse than no tag, because Buzz
 * treats an invalid attestation as absent while we would think it was applied.
 */
export function normalizeAuthTag(value) {
  if (!Array.isArray(value) || value.length !== 4) return undefined;
  const tag = value.map((part) => String(part));
  if (tag[0] !== "auth") return undefined;
  if (!/^[0-9a-f]{64}$/u.test(tag[1])) return undefined; // owner pubkey
  if (!/^[0-9a-f]{128}$/u.test(tag[3])) return undefined; // schnorr signature
  return tag;
}

/** Pull the tag out of either accepted per-account shape. */
export function readAccountAuthTag(entry) {
  if (!entry) return undefined;
  return normalizeAuthTag(Array.isArray(entry) ? entry : entry.authTag);
}

/**
 * Load the store. Missing file is normal (no attestations minted yet) and
 * returns an empty map rather than throwing — the fleet must still connect.
 * A malformed or unreadable file is reported through `onWarn` and also yields
 * an empty map, so a bad edit degrades to "no attestation" instead of taking
 * every account down.
 */
export function loadAuthTags({ filePath = DEFAULT_AUTH_TAGS_PATH, onWarn } = {}) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") onWarn?.(`buzz: cannot read ${filePath}: ${String(err)}`);
    return new Map();
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    onWarn?.(`buzz: ${filePath} is not valid JSON: ${String(err)}`);
    return new Map();
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    onWarn?.(`buzz: ${filePath} must be an object keyed by account id`);
    return new Map();
  }

  const out = new Map();
  for (const [account, entry] of Object.entries(parsed)) {
    const tag = readAccountAuthTag(entry);
    if (tag) out.set(account, tag);
    else onWarn?.(`buzz: ${filePath}: attestation for "${account}" is malformed; ignoring it`);
  }
  return out;
}
