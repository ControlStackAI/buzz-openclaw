#!/usr/bin/env bash
# P1.6 — join every agent identity to a Buzz channel.
#
# Relay membership (buzz-admin add-member) is NOT channel membership. An agent
# that is only a relay member never appears in the desktop's member list or its
# @-mention autocomplete, and a mention aimed at it degrades to the
# ["mention", pk] out-of-channel tag shape instead of a proper p tag.
# Every agent that should be addressable in a channel must join it.
#
# Idempotent: re-running is a no-op the relay accepts again without duplicating.
# Note the </dev/null on every buzz-cli call — the CLI reads stdin, and inside a
# loop it will otherwise swallow the rest of the driving list (same trap that bit
# buzz-enroll-members.sh).
#
# Usage: BUZZ_RELAY_URL=wss://… ./buzz-join-channel.sh <channel-uuid> [keydir]
set -uo pipefail

CHANNEL="${1:?usage: buzz-join-channel.sh <channel-uuid> [keydir]}"
KEYDIR="${2:-$HOME/.local/share/buzz/agent-keys}"
: "${BUZZ_RELAY_URL:?set BUZZ_RELAY_URL}"

fail=0
for f in "$KEYDIR"/*.key; do
  id="$(basename "$f" .key)"
  out=$(BUZZ_PRIVATE_KEY="$(cat "$f")" \
        buzz-cli channels join --channel "$CHANNEL" </dev/null 2>&1)
  case "$out" in
    *'"accepted":true'*) printf '%-16s ok\n'   "$id" ;;
    *)                   printf '%-16s FAIL %s\n' "$id" "$out"; fail=1 ;;
  esac
done

echo
echo "-- resulting channel members --"
BUZZ_PRIVATE_KEY="$(cat "$KEYDIR/main.key")" \
  buzz-cli channels members --channel "$CHANNEL" </dev/null 2>&1

exit "$fail"
