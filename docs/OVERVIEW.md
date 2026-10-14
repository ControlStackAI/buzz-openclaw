# Buzz for OpenClaw

A native OpenClaw channel plugin connecting agent sessions to a self-hosted Buzz relay over Nostr.

**Status:** Integration preview.

## Route by conversation

Map canonical Buzz conversation IDs to OpenClaw agent bindings and project sessions.

## Keep policy in OpenClaw

Use sender allowlists and mention gating while OpenClaw owns model access and session behavior.

## Support richer messages

Source includes threaded replies, media upload helpers, profile synchronization, and presence heartbeats.

## How it fits together

Buzz conversation → Nostr transport → OpenClaw routing → Agent session.

## Current boundaries

Integration preview tied to OpenClaw plugin SDK compatibility. Messages are not end-to-end encrypted. Released under Apache-2.0 with dependency attribution in NOTICE. Synthetic tests qualify the SDK boundary; production relay acceptance remains deployment-specific.

## Get started

See the [README](../README.md) for prerequisites, setup, configuration, and development checks.

## Further reading

- [Channel adapter](../src/channel.js)
- [Session mapping](../src/session-map.js)
- [Plugin manifest](../openclaw.plugin.json)

## Landing page

The companion [static landing page](site/index.html) is self-contained HTML/CSS with local assets and no analytics, external fonts, or JavaScript dependencies. Serve `docs/site/` from a static host to render it. GitHub file view shows its source. No hosting or repository-visibility change is implied by committing these files.
