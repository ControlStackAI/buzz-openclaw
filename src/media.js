import { createHash } from "node:crypto";
import { finalizeEvent } from "nostr-tools/pure";
import { loadOutboundMediaFromUrl } from "openclaw/plugin-sdk/outbound-media";

export const BLOSSOM_AUTH_KIND = 24242;
export const BUZZ_MAX_MEDIA_BYTES = 50 * 1024 * 1024;

export function relayHttpBase(relayUrl) {
  const url = new URL(relayUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  else if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`buzz: unsupported relay URL protocol ${url.protocol}`);
  }
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/$/, "");
}

export function buildBlossomUploadAuth({ secretKey, sha256, now = Math.floor(Date.now() / 1000) }) {
  return finalizeEvent(
    {
      kind: BLOSSOM_AUTH_KIND,
      created_at: now,
      content: "Upload buzz-media",
      tags: [
        ["t", "upload"],
        ["x", sha256],
        ["expiration", String(now + 300)],
      ],
    },
    secretKey,
  );
}

export function blossomAuthorization(event) {
  return `Nostr ${Buffer.from(JSON.stringify(event), "utf8").toString("base64url")}`;
}

function cleanImetaValue(value) {
  return String(value).replace(/[\r\n]+/g, " ").trim();
}

export function buildImetaTag(descriptor, fallback = {}) {
  const url = descriptor?.url;
  const mime = descriptor?.type ?? descriptor?.mime_type ?? fallback.contentType;
  const sha256 = descriptor?.sha256 ?? fallback.sha256;
  const size = descriptor?.size ?? fallback.size;
  if (!url || !mime || !sha256 || !Number.isFinite(Number(size))) {
    throw new Error("buzz: incomplete Blossom descriptor (url, type, sha256, size required)");
  }
  const fields = [
    `url ${cleanImetaValue(url)}`,
    `m ${cleanImetaValue(mime)}`,
    `x ${cleanImetaValue(sha256)}`,
    `size ${Number(size)}`,
  ];
  for (const key of ["dim", "blurhash", "alt", "thumb", "duration", "bitrate"]) {
    if (descriptor[key] != null && String(descriptor[key]).trim()) {
      fields.push(`${key} ${cleanImetaValue(descriptor[key])}`);
    }
  }
  const filename = descriptor.filename ?? fallback.fileName;
  if (filename) fields.push(`filename ${cleanImetaValue(filename)}`);
  return ["imeta", ...fields];
}

export async function uploadBuzzMedia({
  relayUrl,
  secretKey,
  mediaUrl,
  mediaAccess,
  mediaLocalRoots,
  mediaReadFile,
  fetchImpl = fetch,
}) {
  const loaded = await loadOutboundMediaFromUrl(mediaUrl, {
    maxBytes: BUZZ_MAX_MEDIA_BYTES,
    mediaAccess,
    mediaLocalRoots,
    mediaReadFile,
  });
  const sha256 = createHash("sha256").update(loaded.buffer).digest("hex");
  const auth = buildBlossomUploadAuth({ secretKey, sha256 });
  const response = await fetchImpl(`${relayHttpBase(relayUrl)}/upload`, {
    method: "PUT",
    headers: {
      Authorization: blossomAuthorization(auth),
      "Content-Type": loaded.contentType ?? "application/octet-stream",
      "X-SHA-256": sha256,
    },
    body: loaded.buffer,
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`buzz: media upload failed (${response.status}): ${detail}`);
  }
  const descriptor = await response.json();
  if (String(descriptor.sha256 ?? "").toLowerCase() !== sha256) {
    throw new Error("buzz: Blossom descriptor sha256 does not match uploaded bytes");
  }
  return {
    descriptor,
    imeta: buildImetaTag(descriptor, {
      contentType: loaded.contentType ?? "application/octet-stream",
      fileName: loaded.fileName,
      sha256,
      size: loaded.buffer.byteLength,
    }),
  };
}
