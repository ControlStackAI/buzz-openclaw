/**
 * Ephemeral Buzz presence (kind 20001).
 *
 * Harvested from upstream OpenClaw's `@openclaw/buzz`
 * (extensions/buzz/src/buzz-bus.ts @ v2026.7.2-beta.6, MIT, © OpenClaw
 * Foundation) and reimplemented for our per-agent client. Upstream runs one bot
 * identity; we run one client per agent, so every agent publishes its own
 * presence and Buzz can show the whole fleet online rather than a single bot.
 *
 * Why the relay wants a heartbeat rather than a sticky flag: presence is
 * ephemeral, so the relay drops it when the last authenticated connection for
 * that pubkey closes. That is what stops two Gateways from marking each other
 * offline.
 */

export const PRESENCE_KIND = 20_001;
export const PRESENCE_HEARTBEAT_INTERVAL_MS = 30_000;

/** Build the ephemeral `online` presence event template. */
export function buildPresenceTemplate() {
  return { kind: PRESENCE_KIND, content: "online", tags: [] };
}

/**
 * Publish presence immediately, then every 30s. Returns a stop function.
 *
 * Three properties worth keeping, all from upstream:
 * - an in-flight guard, so a slow relay cannot stack publishes;
 * - error reported once per failure streak, reset on the next success, so a
 *   flapping relay does not spam the log every 30s;
 * - `timer.unref()`, so the heartbeat never holds the process open.
 */
export function startPresenceHeartbeat({ publish, onError, intervalMs = PRESENCE_HEARTBEAT_INTERVAL_MS }) {
  let stopped = false;
  let inFlight = false;
  let errorReported = false;

  const publishOnline = async () => {
    if (stopped || inFlight) return;
    inFlight = true;
    try {
      await publish(buildPresenceTemplate());
      errorReported = false;
    } catch (err) {
      if (!stopped && !errorReported) {
        errorReported = true;
        onError?.(err instanceof Error ? err : new Error(`buzz presence heartbeat failed: ${String(err)}`));
      }
    } finally {
      inFlight = false;
    }
  };

  void publishOnline();
  const timer = setInterval(() => void publishOnline(), intervalMs);
  timer.unref?.();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
