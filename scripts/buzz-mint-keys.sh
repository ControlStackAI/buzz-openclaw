#!/usr/bin/env bash
# Mint one secp256k1 identity per Buzz account, idempotently.
#
#   scripts/buzz-mint-keys.sh [--roster FILE] [--dir DIR] [--dry-run]
#
# For every account id in the roster that has no key file yet, generate a key and
# write it 0600. Existing files are NEVER overwritten — re-running is a no-op that
# just reprints the public keys. Output is TSV: <account-id> <pubkey> <status>.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
roster="$here/buzz-roster.tsv"
keydir="${BUZZ_AGENT_KEY_DIR:-$HOME/.local/share/buzz/agent-keys}"
dry_run=0

while [ $# -gt 0 ]; do
  case "$1" in
    --roster) roster="$2"; shift 2 ;;
    --dir) keydir="$2"; shift 2 ;;
    --dry-run) dry_run=1; shift ;;
    -h|--help) sed -n '2,10p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -f "$roster" ] || { echo "roster not found: $roster" >&2; exit 1; }
mkdir -p "$keydir"
chmod 700 "$keydir"

# nostr-tools lives in this repo's node_modules; keygen and pubkey derivation both
# come from the same library the plugin uses at runtime, so there is no second
# implementation to drift.
mint() {
  node --input-type=module -e '
    import { generateSecretKey, getPublicKey } from "nostr-tools/pure";
    const sk = generateSecretKey();
    process.stdout.write(Buffer.from(sk).toString("hex") + "\t" + getPublicKey(sk) + "\n");
  '
}

pubkey_of() {
  node --input-type=module -e '
    import { getPublicKey } from "nostr-tools/pure";
    import { readFileSync } from "node:fs";
    const hex = readFileSync(process.argv[1], "utf8").trim();
    if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`not 64-char hex: ${process.argv[1]}`);
    process.stdout.write(getPublicKey(Uint8Array.from(Buffer.from(hex, "hex"))) + "\n");
  ' "$1"
}

cd "$here/.."
while IFS=$'\t' read -r id name; do
  case "${id:-}" in ''|'#'*) continue ;; esac
  file="$keydir/$id.key"
  if [ -f "$file" ]; then
    pk="$(pubkey_of "$file")" || { echo "cannot derive pubkey for $id" >&2; exit 1; }
    printf '%s\t%s\texists\t%s\n' "$id" "$pk" "$name"
    continue
  fi
  if [ "$dry_run" = 1 ]; then
    printf '%s\t%s\twould-mint\t%s\n' "$id" "-" "$name"
    continue
  fi
  minted="$(mint)"
  sk="${minted%%$'\t'*}"
  pk="${minted##*$'\t'}"
  umask 077
  printf '%s\n' "$sk" > "$file"
  chmod 600 "$file"
  printf '%s\t%s\tminted\t%s\n' "$id" "$pk" "$name"
done < "$roster"
