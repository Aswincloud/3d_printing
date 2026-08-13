// Which /api/ responses a shared cache may store.
//
// This file exists because of a live incident. [cache] was enabled in wrangler.toml,
// and the audit that followed added `private, no-store` to /api/me — but missed
// /api/auth/me, a different endpoint answering the same question. Cloudflare then
// cached {"signedIn":false} and served it to everyone: Aswin signed in, the page
// asked who he was, the edge returned a 20-minute-old "nobody", and he was bounced
// back to the sign-in screen every time. cf-cache-status was HIT with age 1249.
//
// It was also a latent disclosure. Had the first request after an eviction come from
// a signed-in session, that response — carrying an email address — would have been
// stored and served to strangers.
//
// The fix inverted the default: everything under /api/ is no-store unless it is on an
// explicit allowlist. These tests pin that, so the next endpoint is private by
// default instead of public until someone remembers.
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};

const src = readFileSync(new URL("../src/index.js", import.meta.url), "utf8");

// Pull the real allowlist and the real function out of the source rather than
// duplicating them here — a copy would drift and then test itself.
const listMatch = src.match(/const CACHEABLE_API = new Set\(\[([\s\S]*?)\]\);/);
const fnMatch = src.match(/function noStoreUnlessCacheable[\s\S]*?\n}/);
if (!listMatch || !fnMatch) {
  console.log("  FAIL could not find CACHEABLE_API / noStoreUnlessCacheable in src/index.js");
  process.exit(1);
}
const CACHEABLE_API = new Set(
  [...listMatch[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]),
);
const noStoreUnlessCacheable = eval(
  "(" + fnMatch[0].replace("function noStoreUnlessCacheable", "function") + ")",
);

const res = (cc) => new Response("{}", { headers: cc ? { "cache-control": cc } : {} });
const run = (path, given) =>
  noStoreUnlessCacheable(new URL("https://x" + path), res(given)).headers.get("cache-control");

console.log("\nper-user endpoints must never be stored by a shared cache");
for (const p of [
  "/api/auth/me",          // THE one that was missed
  "/api/me",
  "/api/me/orders",
  "/api/me/cart",
  "/api/admin/orders",
  "/api/admin/products",
  "/api/admin/stats",
  "/api/orders",
  "/api/orders/verify",
  "/api/coupon/check",
  "/api/auth/providers",
]) {
  ok(`${p} → no-store`, run(p, null) === "private, no-store", String(run(p, null)));
}

console.log("\nan endpoint that states its own policy is left alone");
ok("/api/me keeps its explicit header", run("/api/me", "private, no-store") === "private, no-store");
ok("a deliberate public header is not overwritten",
   run("/api/products", "public, s-maxage=60") === "public, s-maxage=60");

console.log("\nthe public catalogue stays cacheable");
// If this ever starts failing, the homepage and every product page lose the edge
// cache they were measured against (TTFB 113-225ms -> ~50ms).
ok("/api/products is on the allowlist", CACHEABLE_API.has("/api/products"));
ok("/api/products is not forced to no-store", run("/api/products", null) === null);

console.log("\nthe helper is actually wired into the API response path");
// Found by mutation: deleting the call site left all 17 assertions passing, because
// they exercise the extracted function directly. A policy function nobody calls is
// exactly the bug this file exists to prevent, so the wiring is asserted too.
ok("noStoreUnlessCacheable wraps the api() result",
   /return withSecurityHeaders\(noStoreUnlessCacheable\(url, res\)\);/.test(src),
   "the /api/ return path does not call it");
ok("it is called before withSecurityHeaders, so headers survive",
   /withSecurityHeaders\(noStoreUnlessCacheable\(/.test(src));

console.log("\nthe allowlist is small on purpose");
ok("nothing under /api/admin/ is cacheable",
   ![...CACHEABLE_API].some((p) => p.startsWith("/api/admin")),
   [...CACHEABLE_API].join(","));
ok("nothing under /api/auth/ or /api/me is cacheable",
   ![...CACHEABLE_API].some((p) => p.startsWith("/api/auth") || p.startsWith("/api/me")),
   [...CACHEABLE_API].join(","));

console.log(`\n  apicache: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
