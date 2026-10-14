import assert from "node:assert/strict";
import test from "node:test";
import { generateSecretKey, getPublicKey, verifyEvent } from "nostr-tools/pure";

import {
  BLOSSOM_AUTH_KIND,
  blossomAuthorization,
  buildBlossomUploadAuth,
  buildImetaTag,
  relayHttpBase,
  uploadBuzzMedia,
} from "../src/media.js";

test("relay websocket URLs map to the matching HTTP origin", () => {
  assert.equal(relayHttpBase("ws://127.0.0.1:3000"), "http://127.0.0.1:3000");
  assert.equal(relayHttpBase("wss://buzz.example/relay"), "https://buzz.example");
});

test("Blossom upload auth is signed, short-lived, and hash-scoped", () => {
  const secretKey = generateSecretKey();
  const sha256 = "a".repeat(64);
  const event = buildBlossomUploadAuth({ secretKey, sha256, now: 1000 });
  assert.equal(event.kind, BLOSSOM_AUTH_KIND);
  assert.equal(event.pubkey, getPublicKey(secretKey));
  assert.equal(verifyEvent(event), true);
  assert.deepEqual(event.tags, [["t", "upload"], ["x", sha256], ["expiration", "1300"]]);
  const decoded = JSON.parse(Buffer.from(blossomAuthorization(event).slice(6), "base64url").toString());
  assert.equal(decoded.id, event.id);
});

test("imeta uses only Buzz's strict allowlisted fields", () => {
  const tag = buildImetaTag({
    url: "http://relay/media/hash.png",
    type: "image/png",
    sha256: "b".repeat(64),
    size: 123,
    dim: "10x20",
    thumb: "http://relay/media/hash.thumb.jpg",
    ignored: "nope",
  }, { fileName: "plot.png" });
  assert.deepEqual(tag, [
    "imeta",
    "url http://relay/media/hash.png",
    "m image/png",
    `x ${"b".repeat(64)}`,
    "size 123",
    "dim 10x20",
    "thumb http://relay/media/hash.thumb.jpg",
    "filename plot.png",
  ]);
});

test("upload hashes exact bytes, authenticates PUT /upload, and verifies descriptor hash", async () => {
  const secretKey = generateSecretKey();
  const bytes = Buffer.from("buzz-media-test");
  let request;
  const result = await uploadBuzzMedia({
    relayUrl: "ws://127.0.0.1:3000",
    secretKey,
    mediaUrl: "/approved/note.txt",
    mediaReadFile: async () => bytes,
    mediaLocalRoots: ["/approved"],
    fetchImpl: async (url, init) => {
      request = { url, init };
      const sha256 = init.headers["X-SHA-256"];
      return new Response(JSON.stringify({
        url: `http://127.0.0.1:3000/media/${sha256}.txt`,
        sha256,
        size: bytes.length,
        type: "text/plain",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  assert.equal(request.url, "http://127.0.0.1:3000/upload");
  assert.equal(request.init.method, "PUT");
  assert.equal(request.init.headers["Content-Type"], "text/plain");
  assert.match(request.init.headers.Authorization, /^Nostr /);
  assert.deepEqual(Buffer.from(request.init.body), bytes);
  assert.equal(result.imeta[0], "imeta");
});

test("upload rejects a descriptor for different bytes", async () => {
  await assert.rejects(
    uploadBuzzMedia({
      relayUrl: "ws://127.0.0.1:3000",
      secretKey: generateSecretKey(),
      mediaUrl: "/approved/a.txt",
      mediaReadFile: async () => Buffer.from("x\n"),
      mediaLocalRoots: ["/approved"],
      fetchImpl: async () => new Response(JSON.stringify({
        url: "http://relay/media/nope.txt",
        sha256: "0".repeat(64),
        size: 2,
        type: "text/plain",
      }), { status: 200 }),
    }),
    /does not match/,
  );
});
