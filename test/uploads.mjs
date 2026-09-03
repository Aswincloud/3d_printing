// Quote-form uploads: into our own bucket, out only to the owner.
//
//   node test/uploads.mjs
//
// The point of src/uploads.js is WHERE the file goes and WHO can read it back,
// so that is what these test: the key shape nobody can guess, the extension
// allowlist, the size cap, and that the download route hands the object back
// as an attachment with the name the customer gave it.
import {
  uploadQuoteFile, downloadQuoteFile, validFileKey, safeFileName, quoteFileUrl,
  MAX_UPLOAD_BYTES,
} from "../src/uploads.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (t) => console.log(`\n${t}`);

// In-memory R2: just enough of the binding's surface for uploads.js.
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
        writeHttpMetadata(h) {
          if (o.opts?.httpMetadata?.contentType) h.set("content-type", o.opts.httpMetadata.contentType);
        },
      };
    },
  };
}

const upload = (env, { name, bytes = new Uint8Array([1, 2, 3]), type = "application/octet-stream", length } = {}) =>
  uploadQuoteFile(new Request("https://x/api/quote/upload", {
    method: "POST",
    headers: {
      "x-file-name": encodeURIComponent(name),
      "content-type": type,
      ...(length !== undefined ? { "content-length": String(length) } : {}),
      "cf-connecting-ip": "1.2.3.4",
    },
    body: bytes,
  }), env);

section("filenames");
ok("keeps a plain name", safeFileName("bracket_v2.stl") === "bracket_v2.stl");
ok("strips a path", safeFileName("C:\\Users\\me\\part.stl") === "part.stl");
ok("strips a unix path", safeFileName("../../etc/passwd.stl") === "passwd.stl", safeFileName("../../etc/passwd.stl"));
ok("replaces spaces and unicode", /^[A-Za-z0-9._-]+$/.test(safeFileName("my part (final) ✓.stl")));
ok("never empty", safeFileName("") === "file" && safeFileName("///") === "file");
ok("a header-breaking name cannot escape the quotes", !/["\r\n]/.test(safeFileName('a"b\r\n.stl')));

section("key shape");
ok("accepts a minted key",
   validFileKey("quotes/2026/3f2b1a9c-1111-4222-8333-444455556666/part.stl"));
for (const k of ["", "quotes/2026/not-a-uuid/part.stl", "quotes/2026/3f2b1a9c-1111-4222-8333-444455556666/../x",
                 "other/2026/3f2b1a9c-1111-4222-8333-444455556666/part.stl",
                 "https://litterbox.catbox.moe/x.stl", "javascript:alert(1)"]) {
  ok(`rejects ${JSON.stringify(k)}`, !validFileKey(k));
}
ok("the owner URL goes through the admin route",
   quoteFileUrl({ APP_BASE_URL: "https://3d-prints.aswincloud.com/" }, "quotes/2026/a/b.stl")
     === "https://3d-prints.aswincloud.com/api/admin/quotes/file?key=quotes%2F2026%2Fa%2Fb.stl");

section("upload");
{
  const env = { UPLOADS: fakeR2() };
  const res = await upload(env, { name: "my bracket.STL", type: "model/stl" });
  const out = await res.json();
  ok("200", res.status === 200, String(res.status));
  ok("returns a key of the minted shape", validFileKey(out.file_key), out.file_key);
  ok("the key ends in the safe name", out.file_key.endsWith("/my-bracket.STL"), out.file_key);
  ok("returns the safe name", out.file_name === "my-bracket.STL");
  ok("the object is in the bucket", env.UPLOADS._store.has(out.file_key));
  const stored = env.UPLOADS._store.get(out.file_key);
  ok("content type kept", stored.opts.httpMetadata.contentType === "model/stl");
  ok("original name kept as metadata", stored.opts.customMetadata.original_name === "my bracket.STL");

  // Two uploads of the same name never collide.
  const again = await (await upload(env, { name: "my bracket.STL" })).json();
  ok("a second upload of the same name gets a different key", again.file_key !== out.file_key);
}

section("upload — refusals");
{
  const env = { UPLOADS: fakeR2() };
  for (const name of ["shell.html", "run.exe", "model.svg", "noext", "x.stl.js"]) {
    const res = await upload(env, { name });
    ok(`${name} is refused (400)`, res.status === 400, String(res.status));
  }
  ok("nothing was stored for a refused type", env.UPLOADS._store.size === 0);

  ok("empty body is refused", (await upload(env, { name: "a.stl", bytes: new Uint8Array(0) })).status === 400);
  ok("a declared size over the cap is refused with 413",
     (await upload(env, { name: "a.stl", length: MAX_UPLOAD_BYTES + 1 })).status === 413);
  ok("cap is 100 MB", MAX_UPLOAD_BYTES === 104857600);

  const noBinding = await upload({}, { name: "a.stl" });
  ok("missing bucket binding → 503, not a crash", noBinding.status === 503);
}

section("download");
{
  const env = { UPLOADS: fakeR2() };
  const { file_key } = await (await upload(env, { name: "part.stl", type: "model/stl" })).json();

  const res = await downloadQuoteFile(env, new URL("https://x/api/admin/quotes/file?key=" + encodeURIComponent(file_key)));
  ok("200", res.status === 200, String(res.status));
  ok("served as an attachment, named", res.headers.get("content-disposition") === 'attachment; filename="part.stl"',
     res.headers.get("content-disposition"));
  ok("content type from the object", res.headers.get("content-type") === "model/stl");
  ok("never cached", res.headers.get("cache-control") === "private, no-store");
  ok("nosniff", res.headers.get("x-content-type-options") === "nosniff");

  ok("a bad key is 400", (await downloadQuoteFile(env, new URL("https://x/f?key=../etc"))).status === 400);
  ok("a missing object is 404",
     (await downloadQuoteFile(env, new URL("https://x/f?key=quotes/2026/3f2b1a9c-1111-4222-8333-444455556666/gone.stl"))).status === 404);
}

section("the storefront no longer talks to a third-party host");
import { readFileSync } from "node:fs";
const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
for (const f of ["public/assets/js/main.js", "public/assets/js/quote-modal.js", "src/security.js", "src/index.js"]) {
  ok(`${f} has no catbox URL`, !/https?:\/\/[a-z.]*catbox/i.test(read(f)));
}
ok("main.js uploads to /api/quote/upload", /fetch\('\/api\/quote\/upload'/.test(read("public/assets/js/main.js")));
ok("main.js sends file_key, not file_url", /file_key/.test(read("public/assets/js/main.js")) && !/file_url/.test(read("public/assets/js/main.js")));
ok("the CSP connect-src is 'self' plus known services only",
   /connect-src 'self' \$\{CF_ANALYTICS\}/.test(read("src/security.js")));

console.log(`\n  uploads: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
