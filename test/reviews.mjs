// Product reviews (src/reviews.js) and their place on the product page.
//
// What matters most: the VERIFIED badge comes only from a paid order on the
// reviewer's own session, never from the request; owner-added reviews always say
// where they came from and are never verified; the public form refuses spam
// shapes and floods; every post emails the owner.
//
//   node test/reviews.mjs
import { submitReview, cleanReview, listForProduct, adminListReviews, adminDeleteReview, adminAddReview } from "../src/reviews.js";
import { renderProductPage } from "../src/pdp.js";
import { productJsonLd } from "../src/seo.js";
import { signToken } from "@aswincloud/auth";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => { if (cond) { pass++; console.log(`  ok   ${name}`); } else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); } };
const section = (s) => console.log(`\n${s}`);

const PRODUCT = { id: "p-1", slug: "staircase-shelf", name: "Wall-Mounted Staircase Shelf", visible: 1 };
function envWith({ orders = [], reviews = [], session = null } = {}) {
  const db = { products: [PRODUCT, { id: "p-2", slug: "hidden-one", name: "Hidden", visible: 0 }], reviews: reviews.map((r) => ({ ...r })), orders };
  const mails = [];
  const run = (sql, a) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT id, slug, name FROM products WHERE slug = ? AND visible = 1")) return { first: db.products.find((p) => p.slug === a[0] && p.visible) || null };
    if (s.startsWith("SELECT id FROM products WHERE slug = ?")) { const p = db.products.find((x) => x.slug === a[0]); return { first: p ? { id: p.id } : null }; }
    if (s.startsWith("SELECT COUNT(*) AS n FROM reviews WHERE ip_hash = ?")) return { first: { n: db.reviews.filter((r) => r.ip_hash === a[0] && r.created_at > a[1]).length } };
    if (s.startsWith("SELECT o.id FROM orders o JOIN order_items oi")) {
      // Honour only what the SQL actually says: if the product or status filter
      // is dropped from the statement, the fake stops applying it too, so a
      // weakened query fails a test instead of being rescued here.
      const [uid, pid, ...st] = a;
      const byProduct = /AND oi\.product_id = \? AND/.test(s) && !/OR 1\)/.test(s);
      const byStatus = /AND o\.status IN \(/.test(s) && !/o\.status IS NOT NULL OR/.test(s);
      const o = db.orders.find((x) => x.user_id === uid && (!byProduct || x.product_id === pid) && (!byStatus || st.includes(x.status)));
      return { first: o ? { id: o.id } : null };
    }
    if (s.startsWith("INSERT INTO reviews")) {
      const owner = s.includes("'owner'");
      const r = owner ? { id: a[0], product_id: a[1], rating: a[2], name: a[3], body: a[4], verified: 0, user_id: null, order_id: null, source: "owner", source_note: a[5], ip_hash: "", created_at: a[6] }
                      : { id: a[0], product_id: a[1], rating: a[2], name: a[3], body: a[4], verified: a[5], user_id: a[6], order_id: a[7], source: "site", source_note: "", ip_hash: a[8], created_at: a[9] };
      db.reviews.push(r); return { meta: { changes: 1 } };
    }
    if (s.startsWith("SELECT id, rating, name, body, verified, source, source_note, created_at FROM reviews WHERE product_id = ?")) return { results: db.reviews.filter((r) => r.product_id === a[0]).sort((x, y) => y.created_at - x.created_at) };
    if (s.startsWith("SELECT r.id, r.rating")) return { results: db.reviews.map((r) => ({ ...r, product_name: PRODUCT.name, product_slug: PRODUCT.slug })) };
    if (s.startsWith("DELETE FROM reviews WHERE id = ?")) { const n = db.reviews.length; db.reviews = db.reviews.filter((r) => r.id !== a[0]); return { meta: { changes: n - db.reviews.length } }; }
    if (s.startsWith("SELECT id, email, name, created_at")) return { first: session };
    throw new Error("unhandled SQL: " + s.slice(0, 100));
  };
  globalThis.fetch = async (url, init) => { if (new URL(String(url)).hostname === "api.resend.com") { mails.push(JSON.parse(init.body)); return new Response('{"id":"m"}'); } throw new Error("unexpected " + url); };
  return { OWNER_EMAIL: "owner@example.com", RESEND_API_KEY: "re_test", SESSION_SECRET: "s", APP_BASE_URL: "https://shop.test", _db: db, _mails: mails,
    DB: { prepare(sql) { const make = (a) => ({ bind: (...x) => make(x), async first() { return run(sql, a).first ?? null; }, async all() { return { results: run(sql, a).results || [] }; }, async run() { return run(sql, a); } }); return make([]); } } };
}
const req = (ip = "1.2.3.4", cookie = "") => new Request("https://shop.test/api/reviews", { method: "POST", headers: { "cf-connecting-ip": ip, ...(cookie ? { cookie } : {}) } });
// A real signed customer session, as the shop sets it at sign-in.
const signedIn = async (userId) => req("1.2.3.4", `ap_user=${encodeURIComponent(await signToken("s", userId, "customer_session", 3600))}`);
const GOOD = { slug: "staircase-shelf", rating: 5, name: "Priya", body: "Beautiful print, arrived well packed." };
const read = async (r) => [r.status, await r.json()];

section("validation");
ok("good review passes", !cleanReview(GOOD).error);
ok("rating 0 refused", !!cleanReview({ ...GOOD, rating: 0 }).error);
ok("rating 6 refused", !!cleanReview({ ...GOOD, rating: 6 }).error);
ok("rating 4.5 refused", !!cleanReview({ ...GOOD, rating: 4.5 }).error);
ok("no name refused", !!cleanReview({ ...GOOD, name: " " }).error);
ok("too short refused", !!cleanReview({ ...GOOD, body: "ok" }).error);
ok("too long refused", !!cleanReview({ ...GOOD, body: "x".repeat(1001) }).error);
ok("a link refused", /Links/.test(cleanReview({ ...GOOD, body: "great, buy at https://spam.example" }).error || ""));
ok("a bare domain refused", !!cleanReview({ ...GOOD, body: "visit cheapprints.com today" }).error);
ok("whitespace collapsed in the name", cleanReview({ ...GOOD, name: "  Priya   S  " }).name === "Priya S");

section("posting: anyone can, it is stored, the owner is emailed");
{
  const env = envWith();
  const jobs = []; const [st, b] = await read(await submitReview(req(), env, GOOD, { waitUntil: (p) => jobs.push(p) })); await Promise.all(jobs);
  ok("201", st === 201, JSON.stringify(b));
  ok("stored", env._db.reviews.length === 1 && env._db.reviews[0].body === GOOD.body);
  ok("a guest is NOT verified", b.review.verified === false && env._db.reviews[0].verified === 0);
  ok("the owner is emailed", env._mails.length === 1 && /New 5★ review on Wall-Mounted Staircase Shelf/.test(env._mails[0].subject), env._mails[0]?.subject);
  ok("the email has the text and a link to manage", env._mails[0].text.includes(GOOD.body) && env._mails[0].text.includes("/shop.html#reviews"));
  ok("the IP itself is not stored, only a hash", env._db.reviews[0].ip_hash.length === 32 && !env._db.reviews[0].ip_hash.includes("1.2.3.4"));
}
section("verified: only from a paid order on the reviewer's own session");
{
  const env = envWith({ session: { id: "u-1", email: "p@x" }, orders: [{ id: "o-1", user_id: "u-1", product_id: "p-1", status: "delivered" }] });
  const [, b] = await read(await submitReview(await signedIn("u-1"), env, GOOD, null));
  ok("signed in + paid order for this product: verified", b.review.verified === true && env._db.reviews[0].order_id === "o-1");
  ok("and the owner's email says so", /verified buyer/.test(env._mails[0].subject));
}
{
  const env = envWith({ session: { id: "u-1", email: "p@x" }, orders: [{ id: "o-1", user_id: "u-1", product_id: "OTHER", status: "delivered" }] });
  ok("signed in but bought something else: not verified", (await read(await submitReview(await signedIn("u-1"), env, GOOD, null)))[1].review.verified === false);
}
{
  const env = envWith({ session: { id: "u-1", email: "p@x" }, orders: [{ id: "o-1", user_id: "u-1", product_id: "p-1", status: "pending" }] });
  ok("an unpaid order does not verify", (await read(await submitReview(await signedIn("u-1"), env, GOOD, null)))[1].review.verified === false);
}
{
  const env = envWith({ session: null, orders: [{ id: "o-1", user_id: "u-1", product_id: "p-1", status: "paid" }] });
  // Forged cookie: same shape, wrong secret.
  const forged = req("1.2.3.4", `ap_user=${encodeURIComponent(await signToken("WRONG", "u-1", "customer_session", 3600))}`);
  const envF = envWith({ session: { id: "u-1", email: "p@x" }, orders: [{ id: "o-1", user_id: "u-1", product_id: "p-1", status: "paid" }] });
  ok("a forged session cookie is not verified", (await read(await submitReview(forged, envF, GOOD, null)))[1].review.verified === false);
  ok("verified:true in the request is ignored", (await read(await submitReview(req(), env, { ...GOOD, verified: true, order_id: "o-1" }, null)))[1].review.verified === false);
  ok("and nothing verified is stored for it", env._db.reviews.every((r) => r.verified === 0));
}
section("spam");
{
  const env = envWith();
  const [st] = await read(await submitReview(req(), env, { ...GOOD, website: "http://bot" }, null));
  ok("honeypot filled: answers ok, stores nothing, emails nobody", st === 200 && env._db.reviews.length === 0 && env._mails.length === 0);
}
{
  const env = envWith();
  for (let i = 0; i < 5; i++) await submitReview(req("9.9.9.9"), env, { ...GOOD, body: GOOD.body + " " + i }, null);
  const [st] = await read(await submitReview(req("9.9.9.9"), env, GOOD, null));
  ok("sixth review in an hour from one IP: 429", st === 429 && env._db.reviews.length === 5, String(st));
  ok("another IP is unaffected", (await read(await submitReview(req("8.8.8.8"), env, GOOD, null)))[0] === 201);
}
{
  const env = envWith();
  ok("hidden product refused", (await read(await submitReview(req(), env, { ...GOOD, slug: "hidden-one" }, null)))[0] === 404);
  ok("unknown product refused", (await read(await submitReview(req(), env, { ...GOOD, slug: "nope" }, null)))[0] === 404);
  ok("invalid review refused before storing", (await read(await submitReview(req(), env, { ...GOOD, rating: 9 }, null)))[0] === 400 && env._db.reviews.length === 0);
}
section("owner: list, delete, add a real review from elsewhere");
{
  const env = envWith({ reviews: [{ id: "11111111-1111-1111-1111-111111111111", product_id: "p-1", rating: 2, name: "X", body: "spam spam", verified: 0, source: "site", source_note: "", ip_hash: "", created_at: 1 }] });
  ok("list", (await read(await adminListReviews(env)))[1].reviews.length === 1);
  ok("delete", (await read(await adminDeleteReview(env, "11111111-1111-1111-1111-111111111111")))[0] === 200 && env._db.reviews.length === 0);
  ok("delete again is 404", (await read(await adminDeleteReview(env, "11111111-1111-1111-1111-111111111111")))[0] === 404);
  const [st] = await read(await adminAddReview(env, { slug: "staircase-shelf", rating: 5, name: "Karthik", body: "Loved the shelf, great finish!", source_note: "via WhatsApp" }));
  const r = env._db.reviews[0];
  ok("owner-added review stored, labelled, never verified", st === 201 && r.source === "owner" && r.source_note === "via WhatsApp" && r.verified === 0);
  const before = env._db.reviews.length;
  ok("owner-added without saying where it came from is refused", (await read(await adminAddReview(env, { slug: "staircase-shelf", rating: 5, name: "Karthik", body: "Loved the shelf, great!", source_note: "" })))[0] === 400 && env._db.reviews.length === before);
  ok("owner-added with a one-letter source is refused too", (await read(await adminAddReview(env, { slug: "staircase-shelf", rating: 5, name: "Karthik", body: "Loved the shelf, great!", source_note: "x" })))[0] === 400);
}
section("product page");
{
  const env = envWith({ reviews: [
    { id: "a", product_id: "p-1", rating: 5, name: "Priya <b>", body: "Great <script>x</script>", verified: 1, source: "site", source_note: "", created_at: 2000 },
    { id: "b", product_id: "p-1", rating: 4, name: "Karthik", body: "Good", verified: 0, source: "owner", source_note: "via WhatsApp", created_at: 1000 }] });
  const rv = await listForProduct(env, "p-1");
  ok("summary: 2 reviews, average 4.5", rv.count === 2 && rv.avg === 4.5, JSON.stringify(rv));
  const html = renderProductPage({ APP_NAME: "AswinPrints", APP_BASE_URL: "https://shop.test", FLAT_SHIP_PAISE: "9900", FREE_SHIP_THRESHOLD_PAISE: "200000" },
    { product: { slug: "staircase-shelf", name: "Shelf", description: "d", price_paise: 39900, image: "assets/images/x.jpg", images: "", category: "decor" }, related: [], reviews: rv, headExtra: "" });
  ok("the section sits after the specs and before More in", html.indexOf("pdp-specs") < html.indexOf('id="reviews"') && (html.indexOf("pdp-related") === -1 || html.indexOf('id="reviews"') < html.indexOf("pdp-related")));
  ok("shows the average and count", html.includes("<b>4.5</b> out of 5 · 2 reviews"));
  ok("verified badge on the verified one", (html.match(/Verified buyer<\/span>/g) || []).length === 1);
  ok("owner-added shows where it came from", html.includes("via WhatsApp"));
  ok("names and text are escaped", html.includes("Priya &lt;b&gt;") && !html.includes("<script>x</script>"));
  ok("the form posts the slug and has a honeypot", html.includes('data-slug="staircase-shelf"') && html.includes('name="website"'));
  ok("each rating radio has its own accessible name", [1, 2, 3, 4, 5].every((n) => html.includes(`value="${n}" aria-label="${n} star`)));
  ok("summary carries count and sum for the live update", html.includes('data-count="2" data-sum="9"'));
  const late = renderProductPage({ APP_NAME: "A", APP_BASE_URL: "https://s", FLAT_SHIP_PAISE: "9900", FREE_SHIP_THRESHOLD_PAISE: "200000" },
    { product: { slug: "s", name: "S", description: "", price_paise: 100, image: "x", images: "", category: "decor" }, related: [],
      reviews: { count: 1, avg: 5, reviews: [{ id: "z", rating: 5, name: "N", body: "posted early morning IST", verified: 0, source: "site", source_note: "", created_at: Date.parse("2026-10-19T20:30:00Z") }] }, headExtra: "" });
  ok("dates are shown in IST (20:30 UTC on the 19th is the 20th in India)", late.includes("20 Oct 2026"), (late.match(/rv-date">([^<]+)/) || [])[1]);
  const empty = renderProductPage({ APP_NAME: "A", APP_BASE_URL: "https://s", FLAT_SHIP_PAISE: "9900", FREE_SHIP_THRESHOLD_PAISE: "200000" },
    { product: { slug: "s", name: "S", description: "", price_paise: 100, image: "x", images: "", category: "decor" }, related: [], reviews: { reviews: [], count: 0, avg: 0 }, headExtra: "" });
  ok("no reviews: an invitation, no fake rating", empty.includes("No reviews yet") && !empty.includes("out of 5"));
  const ld = productJsonLd({}, { slug: "s", name: "S", price_paise: 39900 }, { pageUrl: "u", imageUrl: "i", reviews: rv });
  ok("structured data carries the real rating", ld.aggregateRating?.ratingValue === "4.5" && ld.aggregateRating.reviewCount === 2);
  ok("and none without reviews", !productJsonLd({}, { slug: "s", name: "S", price_paise: 39900 }, { pageUrl: "u", imageUrl: "i", reviews: { count: 0 } }).aggregateRating);
}
console.log(`\n  reviews: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
