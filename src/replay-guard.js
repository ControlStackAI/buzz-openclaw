// Buzz inbound replay guard, compatible with OpenClaw 2026.7.1.
//
// 7.2 exposes createChannelReplayGuard; 7.1 already has the lower-level
// createClaimableDedupe primitive. Keep the claim/commit/release policy here
// so the transport can adopt the 7.2 semantics without importing a 7.2-only
// helper.

export function createBuzzReplayGuard({ dedupe, accountId }) {
  const namespace = String(accountId ?? "default").trim() || "default";

  return {
    async process(event, handler) {
      const key = event?.id?.trim();
      if (!key) return { kind: "processed", value: await handler() };

      const claim = await dedupe.claim(key, { namespace });
      if (claim.kind === "duplicate") return { kind: "duplicate" };
      if (claim.kind === "inflight") return { kind: "inflight", pending: claim.pending };

      try {
        const value = await handler();
        await dedupe.commit(key, { namespace });
        return { kind: "processed", value };
      } catch (error) {
        dedupe.release(key, { namespace, error });
        throw error;
      }
    },
    clearMemory() {
      dedupe.clearMemory();
    },
  };
}
