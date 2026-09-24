// Gallery photos in R2: the same URL, whichever place the bytes live in.
//
//   node test/gallery.mjs
//
// src/gallery.js exists to delete a workflow — a pull request per JPEG — so
// what these test is that nothing downstream can tell the difference. An
// uploaded photo has to appear in the merged manifest exactly as a committed
// one does, serve from /assets/images/<file> with the same cache headers, and
// carry the same kind of content hash, or the consumers in admin.js and shop.js
// start treating the two sources differently and the seam comes back.
//
// The other half is that this is a write endpoint reachable by the listing
// agent's token, so: create-only, images only, and bounded.
import {
  galleryImages, uploadGalleryImage, serveGalleryImage, safeImageName,
  contentHash, galleryKey, MAX_IMAGE_BYTES, GALLERY_EXTENSIONS,
} from "../src/gallery.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (t) => console.log(`\n${t}`);

// In-memory R2, same shape as test/uploads.mjs.
function fakeR2() {
  const store = new Map();
  return {
    _store: store,
    async put(key, bytes, opts) { store.set(key, { bytes, opts }); },
    async get(key) {
      const o = store.get(key);
      if (!o) return null;
      return {
        body: o.bytes,
        httpEtag: `"${o.opts?.customMetadata?.hash || "x"}"`,
        customMetadata: o.opts?.customMetadata,
        writeHttpMetadata(h) {
          if (o.opts?.httpMetadata?.contentType) h.set("content-type", o.opts.httpMetadata.contentType);
        },
      };
    },
  };
}

// The committed manifest, served the way the [assets] binding serves it.
function fakeAssets(manifest) {
  return {
    async fetch() {
      if (!manifest) return new Response("nope", { status: 404 });
      return new Response(JSON.stringify(manifest), {
        status: 200, headers: { "content-type": "application/json" },
      });
    },
  };
}

// Just enough D1 for one table.
function fakeDB(rows = [], { throwOnSelect = false } = {}) {
  const db = { rows };
  return {
    _db: db,
    prepare(sql) {
      return {
        bind(...args) { this._args = args; return this; },
        async all() {
          if (throwOnSelect) throw new Error("no such table: gallery_images");
          return { results: [...db.rows].sort((a, b) => b.created_at - a.created_at) };
        },
        async run() {
          const [file, key, bytes, hash, content_type, actor, created_at] = this._args;
          if (!db.rows.some((r) => r.file === file)) {
            db.rows.push({ file, key, bytes, hash, content_type, actor, created_at });
          }
          return { success: true };
        },
      };
    },
  };
}

const MANIFEST = {
  generated_at: "2026-09-01T00:00:00.000Z",
  count: 2,
  images: [
    { file: "ganesha_lotus_panel.jpg", bytes: 250000, hash: "aabbccdd" },
    { file: "gta_comic_panel.jpg", bytes: 253702, hash: "7808a0f9" },
  ],
};

const envWith = ({ manifest = MANIFEST, rows = [], r2 = fakeR2(), db } = {}) => ({
  ASSETS: fakeAssets(manifest),
  UPLOADS: r2,
  DB: db || fakeDB(rows),
});

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

const upload = (env, { name = "new_panel.jpg", bytes = JPEG, actor = "owner", length } = {}) =>
  uploadGalleryImage(new Request("https://x/api/admin/gallery/upload", {
    method: "POST",
    headers: {
      "x-file-name": name,
      ...(length === undefined ? {} : { "content-length": String(length) }),
    },
    body: bytes,
  }), env, actor);

// ── names ─────────────────────────────────────────────────────────
section("a filename is only a filename");
ok("a plain name passes", safeImageName("ganesha_panel.jpg") === "ganesha_panel.jpg");
ok("uppercase is normalised", safeImageName("Ganesha.JPG") === "ganesha.jpg");
ok("a path is stripped to its last segment", safeImageName("../../etc/passwd.png") === "passwd.png");
ok("a traversal that would survive stripping is refused", safeImageName("../../etc/passwd") === null);
ok("a non-image extension is refused", safeImageName("payload.svg") === null);
ok("an html file is refused", safeImageName("x.html") === null);
ok("no extension at all is refused", safeImageName("photo") === null);
ok("an empty name is refused", safeImageName("") === null);
ok("every allowed extension is accepted",
   [...GALLERY_EXTENSIONS].every((e) => safeImageName(`p.${e}`) === `p.${e}`));
// The name IS the public URL, so anything that could change its meaning in a
// path has to be gone before it is stored, not escaped at serve time.
ok("a query string cannot be smuggled in", !/[?&=]/.test(safeImageName("a.jpg?x=1&y=2") || ""));
ok("a slash cannot survive", !(safeImageName("a/b.jpg") || "").includes("/"));
ok("the key is namespaced", galleryKey("a.jpg") === "gallery/a.jpg");

section("the hash matches the manifest generator's");
{
  // scripts/build-image-manifest.mjs writes the first 8 hex of sha256. shop.js
  // turns it into ?v=, so a different scheme here would mean R2 photos cache
  // by a rule of their own.
  const h = await contentHash(JPEG.buffer.slice(0));
  ok("8 hex characters", /^[0-9a-f]{8}$/.test(h), h);
  ok("stable for the same bytes", h === await contentHash(JPEG.buffer.slice(0)));
  ok("different for different bytes",
     h !== await contentHash(new Uint8Array([9, 9, 9]).buffer));
}

// ── the merged manifest ───────────────────────────────────────────
section("uploaded and committed photos are one list");
{
  const env = envWith({ rows: [
    { file: "r2_one.jpg", bytes: 111, hash: "11111111", created_at: 200 },
    { file: "r2_two.jpg", bytes: 222, hash: "22222222", created_at: 100 },
  ] });
  const m = await galleryImages(env);
  ok("count covers both sources", m.count === 4, String(m.count));
  ok("the shape is the manifest's",
     m.images.every((i) => typeof i.file === "string" && "bytes" in i && "hash" in i));
  ok("uploads come first, newest first",
     m.images.slice(0, 2).map((i) => i.file).join(",") === "r2_one.jpg,r2_two.jpg");
  ok("committed photos are still all there",
     MANIFEST.images.every((s) => m.images.some((i) => i.file === s.file)));
  ok("committed hashes are untouched",
     m.images.find((i) => i.file === "gta_comic_panel.jpg").hash === "7808a0f9");
}

section("degrading, not breaking");
{
  const onlyStatic = await galleryImages(envWith({ rows: [] }));
  ok("no uploads → exactly the committed manifest", onlyStatic.count === 2);

  // The pre-migration state: the code is deployed, 0023 is not applied yet.
  const noTable = await galleryImages(envWith({ db: fakeDB([], { throwOnSelect: true }) }));
  ok("a missing gallery_images table still serves the committed photos",
     noTable?.count === 2);

  const noAssets = await galleryImages(envWith({
    manifest: null,
    rows: [{ file: "r2_one.jpg", bytes: 1, hash: "11111111", created_at: 1 }],
  }));
  ok("an unreadable manifest still serves the uploads", noAssets?.count === 1);

  const nothing = await galleryImages(envWith({ manifest: null, rows: [] }));
  ok("both sources gone → null, not an empty list", nothing === null);
  // null and [] mean different things to the callers: shop.js synthesises no
  // cards from null, and planRowsFor refuses everything rather than accepting
  // anything when it cannot verify the file exists.
}

section("a committed file wins its own name");
{
  // Should be unreachable — the upload route refuses the name — but if a row
  // ever does exist, the [assets] binding serves the committed bytes, so the
  // manifest has to agree with what the URL actually returns.
  const env = envWith({ rows: [
    { file: "gta_comic_panel.jpg", bytes: 1, hash: "deadbeef", created_at: 999 },
  ] });
  const m = await galleryImages(env);
  ok("no duplicate entry", m.images.filter((i) => i.file === "gta_comic_panel.jpg").length === 1);
  ok("the committed hash is the one reported",
     m.images.find((i) => i.file === "gta_comic_panel.jpg").hash === "7808a0f9");
}

// ── uploading ─────────────────────────────────────────────────────
section("uploading a photo");
{
  const env = envWith();
  const res = await upload(env, { name: "shiva_lingam.jpg" });
  const body = await res.json();
  ok("201", res.status === 201, String(res.status));
  ok("stored under gallery/<file>", env.UPLOADS._store.has("gallery/shiva_lingam.jpg"));
  ok("recorded in D1", env.DB._db.rows.some((r) => r.file === "shiva_lingam.jpg"));
  ok("the response gives the public path", body.path === "assets/images/shiva_lingam.jpg");
  ok("the url carries the cache-buster", body.url === `/assets/images/shiva_lingam.jpg?v=${body.hash}`);
  ok("the byte count is the real one", body.bytes === JPEG.byteLength);
  ok("the content type is set from the extension",
     env.UPLOADS._store.get("gallery/shiva_lingam.jpg").opts.httpMetadata.contentType === "image/jpeg");
  ok("the row hash matches the response",
     env.DB._db.rows.find((r) => r.file === "shiva_lingam.jpg").hash === body.hash);

  // Appears in the merged manifest immediately — the property the whole
  // feature rests on, since that is what admin.js and shop.js read.
  const m = await galleryImages(env);
  ok("it is in the manifest on the next read",
     m.images.some((i) => i.file === "shiva_lingam.jpg" && i.hash === body.hash));
}

section("which actor uploaded it is recorded");
{
  const env = envWith();
  await upload(env, { name: "agent_photo.jpg", actor: "agent" });
  ok("the row names the actor",
     env.DB._db.rows.find((r) => r.file === "agent_photo.jpg").actor === "agent");
  ok("R2 metadata names it too",
     env.UPLOADS._store.get("gallery/agent_photo.jpg").opts.customMetadata.actor === "agent");
  const owner = envWith();
  await upload(owner, { name: "owner_photo.jpg" });
  ok("owner is the default",
     owner.DB._db.rows.find((r) => r.file === "owner_photo.jpg").actor === "owner");
}

section("create-only: this token must never be able to replace a photo");
// The reason POST /api/admin/gallery/upload is safe to put in AGENT_ROUTES. An
// overwrite would change what an already-published URL returns, which is both a
// content-integrity problem and one no CDN would honour anyway.
{
  const env = envWith();
  await upload(env, { name: "once.jpg" });
  const again = await upload(env, { name: "once.jpg", bytes: new Uint8Array([7, 7, 7, 7]) });
  ok("a second upload at the same name is 409", again.status === 409, String(again.status));
  ok("the original bytes are untouched",
     env.UPLOADS._store.get("gallery/once.jpg").bytes.length === JPEG.byteLength);
  ok("still one row", env.DB._db.rows.filter((r) => r.file === "once.jpg").length === 1);

  const committed = await upload(env, { name: "gta_comic_panel.jpg" });
  ok("a name already committed to the repo is 409", committed.status === 409);
  ok("and nothing was written for it", !env.UPLOADS._store.has("gallery/gta_comic_panel.jpg"));
  // Because the [assets] binding would serve the committed file regardless, so
  // the object would be bytes nobody could ever fetch.

  const upper = await upload(env, { name: "GTA_COMIC_PANEL.JPG" });
  ok("the collision check is not case-dodgeable", upper.status === 409, String(upper.status));
}

section("what is refused");
{
  const env = envWith();
  ok("no filename → 400", (await upload(env, { name: "" })).status === 400);
  ok("a non-image → 400", (await upload(env, { name: "payload.svg" })).status === 400);
  ok("an empty body → 400", (await upload(env, { bytes: new Uint8Array(0) })).status === 400);

  const big = await upload(env, { name: "huge.jpg", bytes: new Uint8Array(MAX_IMAGE_BYTES + 1) });
  ok("over the size cap → 413", big.status === 413, String(big.status));
  ok("the oversized body was not stored", !env.UPLOADS._store.has("gallery/huge.jpg"));

  // Rejected on the declared length before the body is read, so a 2GB upload
  // costs one header rather than the whole transfer.
  const declared = await upload(env, { name: "claimed.jpg", length: MAX_IMAGE_BYTES + 1 });
  ok("an oversized content-length → 413 without reading", declared.status === 413);

  const noBucket = { ...envWith(), UPLOADS: null };
  ok("no R2 binding → 503, not a crash", (await upload(noBucket)).status === 503);
  ok("nothing was refused with a 5xx that should have been a 4xx",
     (await upload(env, { name: "x.exe" })).status === 400);
}

// ── serving ───────────────────────────────────────────────────────
section("serving an uploaded photo at the committed photos' URL");
{
  const env = envWith();
  const up = await (await upload(env, { name: "served.jpg" })).json();
  const req = new Request("https://x/assets/images/served.jpg");
  const res = await serveGalleryImage(req, env, "served.jpg");
  ok("200", res.status === 200);
  ok("content-type from R2", res.headers.get("content-type") === "image/jpeg");
  // public/_headers is applied by the asset server, which is not in this path,
  // so the values have to be repeated here — and have to match, or the two
  // kinds of photo cache differently.
  ok("the cache policy matches public/_headers",
     res.headers.get("cache-control") === "public, max-age=86400, stale-while-revalidate=2592000");
  ok("an etag is set", !!res.headers.get("etag"));

  const revalidate = await serveGalleryImage(
    new Request("https://x/assets/images/served.jpg", { headers: { "if-none-match": res.headers.get("etag") } }),
    env, "served.jpg");
  ok("a matching if-none-match → 304", revalidate.status === 304);

  ok("an unknown file → null, so index.js falls through to the 404 page",
     await serveGalleryImage(req, env, "nope.jpg") === null);
  ok("a traversal → null", await serveGalleryImage(req, env, "../../secret.jpg") === null);
  ok("a name needing sanitising → null, never a guess at what was meant",
     await serveGalleryImage(req, env, "Served.JPG") === null);
  // Deliberate: serveGalleryImage only serves the exact key, so a request that
  // is not already canonical cannot reach an object by a second spelling.
  ok("a quote file cannot be reached through the gallery path",
     await serveGalleryImage(req, env, "quotes/2026/x/model.stl") === null);
  ok("no R2 binding → null", await serveGalleryImage(req, { ...env, UPLOADS: null }, "served.jpg") === null);
  ok(`${up.file} really was the one stored`, up.file === "served.jpg");
}

console.log(`\n  gallery: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
