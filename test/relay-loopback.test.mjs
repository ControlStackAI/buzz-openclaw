import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocketServer } from "ws";
import { generateSecretKey, finalizeEvent, verifyEvent } from "nostr-tools/pure";
import { BuzzRelayClient } from "../src/nostr-client.js";

async function fixture(t, { rejectAuth = false, omitChallenge = false } = {}) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const received = [];
  const inbound = finalizeEvent({ kind: 9, created_at: Math.floor(Date.now() / 1000),
    content: "synthetic inbound", tags: [["h", "test-room"]] }, generateSecretKey());
  server.on("connection", (socket) => {
    let authenticated = false;
    if (!omitChallenge) socket.send(JSON.stringify(["AUTH", "synthetic-challenge"]));
    socket.on("message", (data) => {
      const frame = JSON.parse(data.toString());
      received.push(frame);
      if (frame[0] === "AUTH") {
        const event = frame[1];
        authenticated = !rejectAuth && verifyEvent(event) && event.kind === 22242 &&
          event.tags.some(([tag, value]) => tag === "challenge" && value === "synthetic-challenge");
        socket.send(JSON.stringify(["OK", event.id, authenticated, authenticated ? "" : "restricted: synthetic rejection"]));
      } else if (frame[0] === "REQ") {
        if (!authenticated) { socket.send(JSON.stringify(["CLOSED", frame[1], "auth-required"])); return; }
        socket.send(JSON.stringify(["EVENT", frame[1], inbound]));
        socket.send(JSON.stringify(["EVENT", frame[1], inbound]));
        socket.send(JSON.stringify(["EOSE", frame[1]]));
      } else if (frame[0] === "EVENT") {
        socket.send(JSON.stringify(["OK", frame[1].id, authenticated && verifyEvent(frame[1]), ""]));
      }
    });
  });
  const client = new BuzzRelayClient({ url: `ws://127.0.0.1:${server.address().port}`, secretKey: generateSecretKey() });
  t.after(async () => {
    client.close();
    for (const socket of server.clients) socket.terminate();
    await new Promise((resolve) => server.close(resolve));
  });
  return { client, received, inbound, server };
}

test("loopback relay authenticates before REQ, deduplicates inbound, acknowledges signed publish", { timeout: 10000 }, async (t) => {
  const { client, received, inbound } = await fixture(t);
  await client.connect();
  const events = [];
  await new Promise((resolve) => client.subscribe([{ kinds: [9], "#h": ["test-room"] }], {
    label: "synthetic", onEvent: (event) => { events.push(event); resolve(); },
  }));
  const published = await client.publishChannelMessage({ conversationId: "test-room", content: "synthetic outbound" });
  assert.equal(events.length, 1);
  assert.equal(events[0].id, inbound.id);
  assert.equal(published.content, "synthetic outbound");
  assert.ok(verifyEvent(published));
  assert.ok(received.findIndex((f) => f[0] === "AUTH") < received.findIndex((f) => f[0] === "REQ"));
});

test("loopback relay rejects authorization without starting subscriptions", { timeout: 10000 }, async (t) => {
  const { client, received } = await fixture(t, { rejectAuth: true });
  await assert.rejects(client.connect(), /restricted|synthetic rejection/);
  assert.equal(client.relay, null);
  assert.equal(received.some((f) => f[0] === "REQ"), false);
});

test("missing NIP-42 challenge closes the failed-admission socket", { timeout: 15000 }, async (t) => {
  const { client, received, server } = await fixture(t, { omitChallenge: true });
  const closed = new Promise((resolve) => server.once("connection", (socket) => socket.once("close", resolve)));
  await assert.rejects(client.connect(), /no AUTH challenge/);
  await closed;
  assert.equal(client.relay, null);
  assert.equal(server.clients.size, 0);
  assert.equal(received.some((f) => f[0] === "REQ"), false);
});
