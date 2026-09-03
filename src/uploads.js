// Quote-form file uploads, stored in our own R2 bucket.
//
// The quote form used to POST the customer's file — an STL of their part, a
// photo of the thing to copy, a PDF of a drawing — to litterbox.catbox.moe, an
// anonymous public host, from the browser. Anyone with the returned URL could
// download it, it expired after 72 hours whether or not the job had been
// priced, and the privacy policy did not mention a third party at all. For a
// customer sending a design they may not own the rights to share, that is not
// an acceptable place for it to live.
//
// Now: the browser PUTs the bytes to POST /api/quote/upload, the Worker writes
// them to the UPLOADS bucket under a key nobody can guess, and the quote row
// carries that key. The only way to read the object back is
// GET /api/admin/quotes/file?key=…, which sits behind the owner gate in
// index.js like every other /api/admin/ route.
//
// The bucket is `3dprints-uploads` (wrangler.toml). Retention is a lifecycle
// rule on the bucket, set in the Cloudflare dashboard, not code here.

import { json, bad } from "./lib.js";

// What the form's accept= attribute lists, and nothing else. Checked by
// extension, since a browser's Content-Type for .stl or .3mf is whatever it
// feels like — often application/octet-stream — and is not worth trusting.
export const ALLOWED_EXTENSIONS = new Set([
  "stl", "obj", "3mf", "step", "stp", "jpg", "jpeg", "png", "pdf",
]);

// Matches the "Max 100MB" the form promises. Also the Workers request body
// ceiling on the free plan, so a larger figure here would not be honoured.
export const MAX_UPLOAD_BYTES = 100 * 1024 * 1024;

// quotes/<yyyy>/<uuid>/<safe-name>. The uuid is the secret; the year is so the
// bucket can be browsed by hand and so a lifecycle rule has a prefix to bite on.
const KEY_RE = /^quotes\/\d{4}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[A-Za-z0-9._-]{1,120}$/;

export const validFileKey = (key) => KEY_RE.test(String(key || ""));

// A filename safe to put in a key and a Content-Disposition header. Keeps the
// extension (checked separately), replaces everything else that is not a plain
// character, and refuses to become empty.
export function safeFileName(name) {
  const base = String(name || "").split(/[\\/]/).pop().trim();
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "").slice(0, 120);
  return cleaned || "file";
}

const extensionOf = (name) => {
  const m = /\.([A-Za-z0-9]+)$/.exec(String(name || ""));
  return m ? m[1].toLowerCase() : "";
};

// POST /api/quote/upload — raw body is the file; the name travels in a header.
//
// Dispatched before the JSON body parser in index.js, since the body is bytes.
// No auth: the quote form itself is anonymous. Bounded by RL_QUOTE (the same
// limiter as the form, 6/min per IP) and by the size and extension checks.
export async function uploadQuoteFile(request, env) {
  if (!env.UPLOADS) {
    console.error("upload received but the UPLOADS R2 binding is missing");
    return bad("File uploads aren't available right now — send the file by email instead.", 503);
  }

  const rawName = decodeURIComponent(request.headers.get("x-file-name") || "");
  const name = safeFileName(rawName);
  const ext = extensionOf(name);
  if (!ALLOWED_EXTENSIONS.has(ext)) {
    return bad("That file type isn't supported. Send an STL, OBJ, 3MF, STEP, image or PDF.");
  }

  // Content-Length is set by the browser for a fetch() with a File body and is
  // the cheap check. The read below is the real one: a chunked body with no
  // length cannot exceed the cap either.
  const declared = Number(request.headers.get("content-length") || 0);
  if (declared > MAX_UPLOAD_BYTES) return bad("That file is larger than 100 MB.", 413);

  const bytes = await request.arrayBuffer();
  if (bytes.byteLength === 0) return bad("The file was empty.");
  if (bytes.byteLength > MAX_UPLOAD_BYTES) return bad("That file is larger than 100 MB.", 413);

  const key = `quotes/${new Date().getUTCFullYear()}/${crypto.randomUUID()}/${name}`;
  await env.UPLOADS.put(key, bytes, {
    httpMetadata: {
      contentType: request.headers.get("content-type") || "application/octet-stream",
    },
    customMetadata: {
      original_name: rawName.slice(0, 200),
      uploaded_at: String(Date.now()),
      ip: request.headers.get("cf-connecting-ip") || "",
    },
  });

  return json({ ok: true, file_key: key, file_name: name, bytes: bytes.byteLength });
}

// GET /api/admin/quotes/file?key=… — owner only (the gate is in index.js).
export async function downloadQuoteFile(env, url) {
  if (!env.UPLOADS) return bad("File storage isn't configured.", 503);
  const key = url.searchParams.get("key") || "";
  if (!validFileKey(key)) return bad("Bad file key.", 400);

  const obj = await env.UPLOADS.get(key);
  if (!obj) return bad("That file is no longer stored.", 404);

  const name = key.split("/").pop();
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  if (!headers.get("content-type")) headers.set("content-type", "application/octet-stream");
  // Attachment, always: an uploaded .html or .svg opened inline on this origin
  // would run as us. The extension allowlist keeps those out too, but the
  // header is the one that counts if the list is ever widened.
  headers.set("content-disposition", `attachment; filename="${name}"`);
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(obj.body, { status: 200, headers });
}

// The URL the owner's email and the dashboard link to. Built here so the two
// cannot disagree about the route.
export const quoteFileUrl = (env, key) =>
  (env.APP_BASE_URL || "https://3d-prints.aswincloud.com").replace(/\/$/, "")
  + "/api/admin/quotes/file?key=" + encodeURIComponent(key);
