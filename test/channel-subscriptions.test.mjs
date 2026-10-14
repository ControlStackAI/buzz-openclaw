import assert from "node:assert/strict";
import test from "node:test";

import { buildMessageSubscriptionSpecs } from "../src/channel.js";

test("live message subscriptions use exactly one #h channel each", () => {
  const since = 1_765_432_100;
  const specs = buildMessageSubscriptionSpecs({
    accountId: "main",
    conversationIds: ["general-uuid", "buzz-uuid", "desktop-uuid"],
    since,
  });

  assert.deepEqual(specs, [
    {
      filters: [{ kinds: [9], "#h": ["general-uuid"], since }],
      label: "buzz:main:messages:general-uuid",
    },
    {
      filters: [{ kinds: [9], "#h": ["buzz-uuid"], since }],
      label: "buzz:main:messages:buzz-uuid",
    },
    {
      filters: [{ kinds: [9], "#h": ["desktop-uuid"], since }],
      label: "buzz:main:messages:desktop-uuid",
    },
  ]);

  assert.ok(specs.every(({ filters }) => filters[0]["#h"].length === 1));
});

test("no allowlisted conversations produces no message subscriptions", () => {
  assert.deepEqual(
    buildMessageSubscriptionSpecs({ accountId: "main", conversationIds: [], since: 123 }),
    [],
  );
});
