// Gallery photos that live in R2 instead of the repo.
//
// THE PROBLEM
// -----------
// Every product photo used to reach the site the same way: commit the JPEG into
// public/assets/images/, regenerate public/assets/images.json, open a pull
// request, wait for `npm test`, squash-merge, wait for the deploy. That is the
// correct amount of ceremony for code. For one photo of a wall panel it is a
// branch, a PR and two CI waits to move 250KB, several times a week.
//
// The ceremony was never about review. It exists because the [assets] binding
// has no directory listing — a Worker can fetch /assets/images/x.jpg but cannot
// ask "what files are there?" — so the set of photos had to be written down
// somewhere, and the only writable place was the repo. Hence the manifest, and
// hence git as the upload protocol.
//
// THE SHAPE OF THE FIX
// --------------------
// R2 can list. The bucket already exists (UPLOADS, used by uploads.js for quote
// files), and D1 already holds everything else about a product. So a photo can
// be POSTed straight to the Worker:
//
//   POST /api/admin/gallery   — raw bytes, filename in x-file-name
//
// The object goes to R2 under gallery/<file>, a row goes into gallery_images,
// and GET /assets/images/<file> serves it from R2 when no committed file of
// that name exists. Same URL space as before, so nothing downstream — the
// frontend, the `image` column, product pages, sitemaps — changes at all.
//
// galleryImages() then returns the union of the two sources in the manifest's
// own shape, and admin.js and shop.js read THAT instead of the static file.
// Every existing consumer (unlisted photos, planRowsFor's validation, the ?v=
// cache-buster) starts seeing R2 photos with no further change.
//
// WHAT STAYS IN GIT
// -----------------
// The 113 photos already committed, and any future one that genuinely wants
// review. This is additive: the static manifest is still read, still merged,
// still authoritative for its own files. Deleting it would break the site; not
// adding to it will not.

import { json, bad, now } from "./lib.js";
import { safeFileName } from "./uploads.js";

// Photos only, and only formats a browser renders inline. Narrower than
// uploads.js's list on purpose: that one accepts STLs because a customer is
// sending a model to be quoted. This one is what appears on the shop.
export const GALLERY_EXTENSIONS = new Set(["jpg", "jpeg", "png", "webp"]);

// Generous for a photo, small enough that a mis-sent video is rejected rather
// than stored. The largest committed image today is under 1MB.
export const MAX_IMAGE_BYTES = 12 * 1024 * 1024;

const CONTENT_TYPES = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", webp: "image/webp",
};

// gallery/<file>. Flat, and the filename IS the key suffix — unlike quote files,
// where the uuid in the path is the access control. These are public images
// served at a public URL; hiding the key would protect nothing.
export const galleryKey = (file) => `gallery/${file}`;

const extensionOf = (name) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "";
};

// The same 8 hex characters scripts/build-image-manifest.mjs writes, computed
// the same way (sha256 of the bytes, truncated). It has to match: shop.js turns
// this into the ?v= on the image URL, and an R2 photo whose hash was generated
// differently would still work but would look like a different KIND of thing in
// the manifest, which is exactly the seam this module exists to remove.
export async function contentHash(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 8);
}

// A filename safe to serve at /assets/images/<file> and to store in the `image`
// column. safeFileName() already strips directories and anything exotic; the
// extra rule here is that it must still end in an image extension afterwards,
// so "..%2Fevil" cannot arrive as "-evil" and be treated as a photo.
export function safeImageName(name) {
  const cleaned = safeFileName(name).toLowerCase();
  return GALLERY_EXTENSIONS.has(extensionOf(cleaned)) ? cleaned : null;
}

// ── reading ───────────────────────────────────────────────────────

// The committed manifest. Moved here from the two identical private copies in
// admin.js and shop.js, which had drifted apart in their error handling.
export async function readStaticManifest(env) {
  if (!env.ASSETS?.fetch) return null;
  try {
    const res = await env.ASSETS.fetch(new Request("https://assets.local/assets/images.json"));
    if (!res.ok) {
      console.error("image manifest fetch failed", res.status);
      return null;
    }
    const data = await res.json();
    return Array.isArray(data?.images) ? data : null;
  } catch (e) {
    console.error("image manifest unreadable", e?.message || e);
    return null;
  }
}

// R2-backed photos, newest first. Read from D1 rather than by listing the
// bucket: the row is where the hash and byte count live, a list would cost an
// extra round trip per request, and the table is the thing a migration can fix.
async function readUploadedImages(env) {
  if (!env.DB) return [];
  try {
    const { results } = await env.DB.prepare(
      `SELECT file, bytes, hash, created_at FROM gallery_images ORDER BY created_at DESC, file ASC`
    ).all();
    return results || [];
  } catch (e) {
    // A missing table is the pre-migration state, not an outage. Degrading to
    // the committed photos means the shop keeps working while 0023 is pending.
    console.error("gallery_images unreadable", e?.message || e);
    return [];
  }
}

// The union, in the manifest's own shape, so a caller cannot tell which source a
// photo came from.
//
// Uploads come first because they are the new ones and unlistedImages() renders
// in this order. Committed files win a name collision — uploads are rejected at
// that name in the first place, and if one somehow exists, the [assets] binding
// would serve the committed bytes anyway, so the manifest must agree with what
// the URL actually returns.
export async function galleryImages(env) {
  const [staticManifest, uploaded] = await Promise.all([
    readStaticManifest(env),
    readUploadedImages(env),
  ]);

  // null, not [] — callers distinguish "the manifest is unreadable" (do nothing)
  // from "there are no photos" (say so). Only a total failure of both is null.
  if (!staticManifest && !uploaded.length) return null;

  const statics = staticManifest?.images || [];
  const committed = new Set(statics.map((i) => i.file));
  const images = [
    ...uploaded
      .filter((r) => !committed.has(r.file))
      .map((r) => ({ file: r.file, bytes: r.bytes || 0, hash: r.hash || "", source: "r2" })),
    ...statics.map((i) => ({ ...i, source: "git" })),
  ];

  return {
    generated_at: staticManifest?.generated_at || new Date().toISOString(),
    count: images.length,
    images,
  };
}

// ── serving ───────────────────────────────────────────────────────

// GET /assets/images/<file>, for files that are NOT in the repo.
//
// Reached only after the ASSETS binding has 404ed, so a committed photo is
// never routed through here and nothing about the existing 113 changes.
//
// Sets its own cache headers because public/_headers is applied by the asset
// server, which is not in this path. The values match the /assets/images/* rule
// there — a day fresh, a month stale-while-revalidate — so both kinds of photo
// cache identically.
export async function serveGalleryImage(request, env, file) {
  if (!env.UPLOADS) return null;
  const safe = safeImageName(file);
  if (!safe || safe !== file) return null;

  const object = await env.UPLOADS.get(galleryKey(safe)).catch((e) => {
    console.error("gallery read failed", safe, e?.message || e);
    return null;
  });
  if (!object) return null;

  const headers = new Headers();
  object.writeHttpMetadata?.(headers);
  if (!headers.get("content-type")) {
    headers.set("content-type", CONTENT_TYPES[extensionOf(safe)] || "application/octet-stream");
  }
  headers.set("cache-control", "public, max-age=86400, stale-while-revalidate=2592000");
  // The content hash, so a re-uploaded photo at the same name (which the upload
  // route refuses today) could still be revalidated correctly if it ever is.
  const etag = object.httpEtag || (object.customMetadata?.hash && `"${object.customMetadata.hash}"`);
  if (etag) headers.set("etag", etag);

  if (request.headers.get("if-none-match") === headers.get("etag")) {
    return new Response(null, { status: 304, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

// ── writing ───────────────────────────────────────────────────────

// POST /api/admin/gallery/upload — raw body is the image, name in x-file-name.
//
// Dispatched before the JSON body parser in index.js, since the body is bytes,
// and therefore ALSO before the positional admin gate — so it carries the gate
// with it (see adminActor() in index.js), rather than being the one /api/admin/
// route that quietly sits above the line.
//
// CREATE-ONLY, by the same standard as the other agent routes: a name that
// already exists in R2 or in the committed manifest is refused, not overwritten.
// That is what makes this safe to hand to the listing agent. Replacing a photo
// means the URL keeps its old bytes in every CDN and browser cache anyway, so
// overwrite is not a feature being withheld — it is one that does not work.
export async function uploadGalleryImage(request, env, actor = "owner") {
  if (!env.UPLOADS) {
    console.error("gallery upload received but the UPLOADS R2 binding is missing");
    return bad("Image storage isn't configured.", 503);
  }

  const file = safeImageName(request.headers.get("x-file-name") || "");
  if (!file) return bad("Send an image filename in x-file-name (.jpg, .png or .webp).", 400);

  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_IMAGE_BYTES) return bad("That image is too large (max 12MB).", 413);

  const buf = await request.arrayBuffer().catch(() => null);
  if (!buf || !buf.byteLength) return bad("Empty upload.", 400);
  if (buf.byteLength > MAX_IMAGE_BYTES) return bad("That image is too large (max 12MB).", 413);

  const bytes = new Uint8Array(buf);

  // Checked against BOTH sources. The manifest matters more than the bucket
  // here: a committed file of the same name would be served by the [assets]
  // binding and the R2 object would be dead weight nobody could ever fetch.
  const existing = await galleryImages(env);
  if (existing?.images?.some((i) => i.file === file)) {
    return bad(`${file} already exists. Upload it under a different name.`, 409);
  }

  const hash = await contentHash(buf);
  const contentType = CONTENT_TYPES[extensionOf(file)] || "application/octet-stream";

  await env.UPLOADS.put(galleryKey(file), bytes, {
    httpMetadata: { contentType, cacheControl: "public, max-age=86400" },
    customMetadata: { file, hash, actor, uploaded_at: String(now()) },
  });

  // R2 first, then D1: an object with no row is invisible and harmless, a row
  // with no object is a broken image on the shop. Insert-or-ignore so a retry
  // after a timeout cannot fail on the primary key.
  try {
    await env.DB.prepare(
      `INSERT OR IGNORE INTO gallery_images (file, key, bytes, hash, content_type, actor, created_at)
       VALUES (?,?,?,?,?,?,?)`
    ).bind(file, galleryKey(file), bytes.byteLength, hash, contentType, actor, now()).run();
  } catch (e) {
    console.error("gallery row insert failed", file, e?.message || e);
    return bad("The image was stored but could not be recorded. Try again.", 500);
  }

  return json({
    ok: true,
    file,
    path: `assets/images/${file}`,
    url: `/assets/images/${file}?v=${hash}`,
    bytes: bytes.byteLength,
    hash,
  }, 201);
}
