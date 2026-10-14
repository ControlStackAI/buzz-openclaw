#!/usr/bin/env bash
# Enroll every roster identity as a relay member, idempotently.
#
#   scripts/buzz-enroll-members.sh [--roster FILE] [--dir DIR] [--dry-run]
#
# Diffs the roster's public keys against `buzz-admin list-members` and calls
# add-member only for the missing ones. Re-running adds nothing. Requires
# BUZZ_RELAY_URL and an admin BUZZ_PRIVATE_KEY in the environment (or falls back
# to the `main` agent key, which is a plain member — admin rights are needed for
# add-member, so export an admin key if this errors on permissions).
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
    -h|--help) sed -n '2,12p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

: "${BUZZ_RELAY_URL:?set BUZZ_RELAY_URL, e.g. wss://relay.example.org}"
export BUZZ_PRIVATE_KEY="${BUZZ_PRIVATE_KEY:-$(cat "$keydir/main.key")}"

existing="$(buzz-admin list-members | awk 'NR>2 && $1 ~ /^[0-9a-f]{64}$/ {print $1}')"
[ -n "$existing" ] || { echo "relay returned no members — refusing to proceed" >&2; exit 1; }

pubkey_of() {
  node --input-type=module -e '
    import { getPublicKey } from "nostr-tools/pure";
    import { readFileSync } from "node:fs";
    const hex = readFileSync(process.argv[1], "utf8").trim();
    process.stdout.write(getPublicKey(Uint8Array.from(Buffer.from(hex, "hex"))) + "\n");
  ' "$1"
}

cd "$here/.."
while IFS=$'\t' read -r id name; do
  case "${id:-}" in ''|'#'*) continue ;; esac
  file="$keydir/$id.key"
  [ -f "$file" ] || { echo "$id: no key file — run buzz-mint-keys.sh first" >&2; exit 1; }
  pk="$(pubkey_of "$file")"
  if printf '%s\n' "$existing" | grep -qx "$pk"; then
    printf '%s\t%s\tmember\n' "$id" "$pk"
  elif [ "$dry_run" = 1 ]; then
    printf '%s\t%s\twould-add\n' "$id" "$pk"
  else
    # </dev/null matters: buzz-admin reads stdin, and stdin here is the roster
    # file the while-loop is iterating — without this it swallows the rest of it
    # and the loop silently stops after one add.
    buzz-admin add-member --pubkey "$pk" --role member >/dev/null </dev/null
    printf '%s\t%s\tadded\n' "$id" "$pk"
  fi
done < "$roster"
