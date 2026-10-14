#!/usr/bin/env node
/**
 * Mint NIP-OA owner attestations ("auth" tags) for the agent fleet.
 *
 * Run this yourself — it needs your Buzz *owner* secret key, which no agent
 * should ever hold. It prints tags to stdout and never transmits anything.
 *
 *   node scripts/buzz-mint-auth-tags.mjs --owner-key <path|-> [--conditions ""]
 *
 *   --owner-key   file containing the owner nsec/hex, or "-" to read stdin
 *   --conditions  NIP-OA conditions string (default ""), part of the preimage
 *   --keys-dir    agent key directory (default ~/.local/share/buzz/agent-keys)
 *   --agent       mint for one agent only (basename, e.g. "coder")
 *
 * Spec (block/buzz docs/nips/NIP-OA.md):
 *   tag       = ["auth", <owner-pubkey-hex>, <conditions>, <sig-hex>]  (exactly 4)
 *   preimage  = "nostr:agent-auth:" || <agent-pubkey-hex> || ":" || <conditions>
 *   message   = SHA256(preimage)
 *   sig       = BIP-340 Schnorr(message, owner-secret), 128 lowercase hex
 *
 * The agent pubkey is inside the preimage, so an attestation is bound to ONE
 * agent. Upstream calls the value "reusable" — that means reusable across many
 * events by that same agent, NOT shared across identities. A 17-agent fleet
 * needs 17 attestations.
 *
 * The owner pubkey must differ from the agent pubkey, or verifiers reject it.
 */

import { readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { schnorr } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { getPublicKey } from "nostr-tools/pure";

import { decodeBuzzPrivateKey } from "../src/nostr-client.js";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

const ownerKeyPath = arg("owner-key");
if (!ownerKeyPath) {
  console.error("usage: buzz-mint-auth-tags.mjs --owner-key <path|-> [--conditions <str>] [--agent <name>]");
  process.exit(2);
}
const conditions = arg("conditions", "");
const keysDir = arg("keys-dir", join(homedir(), ".local/share/buzz/agent-keys"));
const onlyAgent = arg("agent");

const ownerRaw = (ownerKeyPath === "-" ? readFileSync(0, "utf8") : readFileSync(ownerKeyPath, "utf8")).trim();
const ownerSecret = decodeBuzzPrivateKey(ownerRaw.split(/\s+/).at(-1));
const ownerPubkey = getPublicKey(ownerSecret);

/** NIP-OA signed message: SHA256("nostr:agent-auth:<agent>:<conditions>"). */
function signedMessage(agentPubkey) {
  return sha256(utf8ToBytes(`nostr:agent-auth:${agentPubkey}:${conditions}`));
}

/** Sign with the owner key, returning the raw signature bytes and the tag. */
function mintAuthTag(agentPubkey) {
  if (agentPubkey === ownerPubkey) throw new Error("owner pubkey equals agent pubkey — verifiers must reject this");
  const sig = schnorr.sign(signedMessage(agentPubkey), ownerSecret);
  return { sig, tag: ["auth", ownerPubkey, conditions, bytesToHex(sig)] };
}

const files = readdirSync(keysDir)
  .filter((f) => f.endsWith(".key"))
  .filter((f) => !onlyAgent || f === `${onlyAgent}.key`)
  .sort();

if (files.length === 0) {
  console.error(`no .key files found in ${keysDir}${onlyAgent ? ` for agent ${onlyAgent}` : ""}`);
  process.exit(1);
}

const out = {};
for (const file of files) {
  const account = file.replace(/\.key$/, "");
  const agentPubkey = getPublicKey(decodeBuzzPrivateKey(readFileSync(join(keysDir, file), "utf8").trim()));
  const { sig, tag } = mintAuthTag(agentPubkey);
  // Self-verify before emitting: a bad tag is worse than no tag, because Buzz
  // treats a malformed attestation as absent and we would chase a ghost.
  if (!schnorr.verify(sig, signedMessage(agentPubkey), hexToBytes(ownerPubkey))) {
    throw new Error(`self-verification failed for ${account}`);
  }
  out[account] = { pubkey: agentPubkey, authTag: tag };
}

console.error(`owner ${ownerPubkey} → ${files.length} attestation(s), all self-verified`);
console.log(JSON.stringify(out, null, 2));
