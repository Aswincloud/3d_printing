// Offline tests for the admin surface: the auth gate first, then the handlers.
//
// The gate matters more than anything else here. /api/admin/orders returns
// customer names, addresses, phone numbers and Razorpay payment ids, and
// /refund moves real money — so "unauthenticated request is refused" is not a
// nice-to-have, it's the feature.

import { ownerAllowed, ssoConfigured, currentOwner } from "../src/auth.js";
import {
  listProducts, createProduct, updateProduct, deleteProduct, unlistedImages,
  batchCreateProducts, hideImages,
  listOrders, updateOrder, refundOrder, stats, bulkUpdateProducts,
  describeProducts, agentListingEmail,
} from "../src/admin.js";
import { signToken } from "@aswincloud/auth";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);

const SESSION_SECRET = "test_session_secret_value";
const OWNER = "aswin@aswincloud.com";

const BASE_ENV = {
  AUTH_BROKER_URL: "https://auth.aswincloud.com",
  RELAY_SECRET: "test_relay_secret",
  SESSION_SECRET,
  OWNER_EMAIL: OWNER,
  ACCESS_MODE: "owners",
  RAZORPAY_KEY_ID: "rzp_test_x",
  RAZORPAY_KEY_SECRET: "secret_x",
  // Set, or updateOrder skips the shipped notification entirely and the email
  // assertions would pass by never running.
  RESEND_API_KEY: "re_fake_for_tests",
};

// Captures what Resend was asked to send. Returns the array so a test can assert
// on the count as well as the content — "sends exactly one email" is the whole
// point of the re-save case.
function stubResend() {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes("api.resend.com")) {
      calls.push(JSON.parse(init.body || "{}"));
      return new Response(JSON.stringify({ id: "email_stub" }), { status: 200 });
    }
    throw new Error("unexpected fetch in admin test: " + u);
  };
  return calls;
}

// ══ INVARIANT 6 ══════════════════════════════════════════════════
// @aswincloud/auth's isOwner() treats an EMPTY allowlist as "allow anyone":
//     if (allow.size === 0) return true;
// Sensible for a package used by public sites; catastrophic here. ownerAllowed()
// must therefore deny when OWNER_EMAIL is missing, and these are the tests that
// prove it — if any of them start failing, the dashboard is world-readable.
section("ownerAllowed() — fails closed with no allowlist (invariant 6)");
for (const [label, owners] of [
  ["undefined", undefined],
  ["empty string", ""],
  ["whitespace", "   "],
  ["only commas", ",,,"],
  ["comma + spaces", " , , "],
]) {
  const env = { ...BASE_ENV, OWNER_EMAIL: owners };
  ok(`OWNER_EMAIL ${label} → denies a real address`, ownerAllowed(env, OWNER) === false);
  ok(`OWNER_EMAIL ${label} → denies an attacker`, ownerAllowed(env, "attacker@evil.com") === false);
}

section("ownerAllowed() — with an allowlist");
ok("owner allowed", ownerAllowed(BASE_ENV, OWNER) === true);
ok("owner allowed, different case", ownerAllowed(BASE_ENV, "ASWIN@AswinCloud.com") === true);
ok("owner allowed with padding", ownerAllowed(BASE_ENV, "  aswin@aswincloud.com  ") === true);
ok("non-owner denied", ownerAllowed(BASE_ENV, "someone@else.com") === false);
ok("empty email denied", ownerAllowed(BASE_ENV, "") === false);
ok("similar-but-different denied", ownerAllowed(BASE_ENV, "aswin@aswincloud.co") === false);
ok("prefix attack denied", ownerAllowed(BASE_ENV, "aswin@aswincloud.com.evil.com") === false);
ok("subdomain attack denied", ownerAllowed(BASE_ENV, "aswin@evil.aswincloud.com") === false);
ok("multi-owner list works",
   ownerAllowed({ ...BASE_ENV, OWNER_EMAIL: "a@b.com, aswin@aswincloud.com" }, OWNER) === true);

// An unknown ACCESS_MODE must fall back to "owners", not to something permissive.
section("ownerAllowed() — ACCESS_MODE fallback");
for (const mode of [undefined, "", "nonsense", "OWNERS", "admin"]) {
  const env = { ...BASE_ENV, ACCESS_MODE: mode };
  ok(`mode ${JSON.stringify(mode)} still denies a non-owner`,
     ownerAllowed(env, "someone@else.com") === false);
  ok(`mode ${JSON.stringify(mode)} still allows the owner`, ownerAllowed(env, OWNER) === true);
}

// "public" is a real mode in the package and would allow anybody. It should
// never be set here, but confirm it's the env var — not a code path — that
// decides, so the risk is visible in config review.
section("ownerAllowed() — ACCESS_MODE=public is permissive (documented risk)");
ok('mode "public" allows a stranger (do NOT set this)',
   ownerAllowed({ ...BASE_ENV, ACCESS_MODE: "public" }, "anyone@example.com") === true);

section("ssoConfigured()");
ok("true with all three", ssoConfigured(BASE_ENV) === true);
for (const k of ["AUTH_BROKER_URL", "RELAY_SECRET", "SESSION_SECRET"]) {
  ok(`false without ${k}`, ssoConfigured({ ...BASE_ENV, [k]: "" }) === false);
}
ok("false with nothing", ssoConfigured({}) === false);

// ── session cookie ────────────────────────────────────────────────
const reqWithCookie = (value) => new Request("http://x/api/admin/orders", {
  headers: value ? { cookie: `ap_session=${value}` } : {},
});

section("currentOwner()");
{
  const good = await signToken(SESSION_SECRET, OWNER, "owner_session", 3600);
  ok("valid session → owner email",
     (await currentOwner(reqWithCookie(good), BASE_ENV)) === OWNER);

  ok("no cookie → null", (await currentOwner(reqWithCookie(null), BASE_ENV)) === null);
  ok("garbage cookie → null", (await currentOwner(reqWithCookie("nonsense"), BASE_ENV)) === null);
  ok("empty cookie → null", (await currentOwner(reqWithCookie(""), BASE_ENV)) === null);

  // Signed with the wrong secret.
  const wrongSecret = await signToken("some_other_secret", OWNER, "owner_session", 3600);
  ok("token from another secret → null",
     (await currentOwner(reqWithCookie(wrongSecret), BASE_ENV)) === null);

  // Signed with the right secret but for a different PURPOSE — a nonce token
  // must not work as a session.
  const wrongPurpose = await signToken(SESSION_SECRET, OWNER, "broker_nonce", 3600);
  ok("nonce token cannot be used as a session",
     (await currentOwner(reqWithCookie(wrongPurpose), BASE_ENV)) === null);

  // Expired.
  const expired = await signToken(SESSION_SECRET, OWNER, "owner_session", -10);
  ok("expired token → null", (await currentOwner(reqWithCookie(expired), BASE_ENV)) === null);

  // A validly-signed session for a NON-owner must still be refused: the policy
  // is re-checked per request, so removing an email revokes access at once.
  const strangerTok = await signToken(SESSION_SECRET, "stranger@evil.com", "owner_session", 3600);
  ok("valid session for a non-owner → null",
     (await currentOwner(reqWithCookie(strangerTok), BASE_ENV)) === null);

  // Same valid owner token, but OWNER_EMAIL has since been emptied.
  ok("valid owner token + empty OWNER_EMAIL → null (invariant 6)",
     (await currentOwner(reqWithCookie(good), { ...BASE_ENV, OWNER_EMAIL: "" })) === null);

  // And with SSO switched off entirely.
  ok("unconfigured sso → null",
     (await currentOwner(reqWithCookie(good), { ...BASE_ENV, SESSION_SECRET: "" })) === null);
}

// ── fake D1 ───────────────────────────────────────────────────────
// Deliberately dumb: pattern-matches only the statements admin.js issues, and
// throws on anything else so a changed query can't silently no-op a test.
// Real D1 returns only the selected columns; project so a test asserting a
// column is absent can't pass for the wrong reason.
const project = (row, cols) =>
  Object.fromEntries(cols.filter((c) => c in row).map((c) => [c, row[c]]));

// Apply a SET clause to a fake row. Not every assignment is a `?` — admin.js
// issues `SET visible = 0, updated_at = ?`, and a parser that assumed one
// placeholder per column silently wrote the wrong values into the wrong
// columns (which is exactly how this test started passing for a broken reason).
function applySets(row, sql, prefix, args) {
  const clause = sql.slice(prefix.length, sql.indexOf(" WHERE "));
  let argIdx = 0;
  for (const part of clause.split(",")) {
    const eq = part.indexOf("=");
    const col = part.slice(0, eq).trim();
    const val = part.slice(eq + 1).trim();
    row[col] = val === "?" ? args[argIdx++] : JSON.parse(val.replace(/'/g, '"'));
  }
}

function makeDB(seed = {}) {
  // Deep copy: spreading the array alone would share the row OBJECTS between
  // test blocks, so an UPDATE in one block mutated the next block's fixture.
  const copy = (rows) => (rows || []).map((r) => ({ ...r }));
  const db = {
    products: copy(seed.products),
    orders: copy(seed.orders),
    order_items: copy(seed.order_items),
  };
  const run = (sql, a) => {
    const s = sql.replace(/\s+/g, " ").trim();

    // Matched on a stable PREFIX rather than the full column list: pinning added a
    // column and the exact-list match broke every test in the file at once.
    if (s.startsWith("SELECT id, slug, name, description, price_paise, image, images, category, visible, sort,")) {
      // Same ordering the query asks for: pinned, then newest, then the curated
      // sequence within a batch. Emulated here only so the dashboard fixture is
      // not misleading — the real clause runs against real SQLite in
      // test/shop.mjs, which also asserts this file's clause matches the shop's.
      return { results: [...db.products].sort((x, y) =>
        Number(Boolean(y.pinned)) - Number(Boolean(x.pinned)) ||
        (y.created_at || 0) - (x.created_at || 0) ||
        Number((x.sort || 0) === 0) - Number((y.sort || 0) === 0) ||
        (x.sort || 0) - (y.sort || 0) ||
        String(x.name).localeCompare(String(y.name))) };
    }
    // Every image path the catalogue uses — for the unlisted-photos diff.
    // Projected to exactly these two columns, so a test asserting that nothing
    // else leaks cannot pass because the fake handed back the whole row.
    if (s.startsWith("SELECT image, images FROM products")) {
      return { results: db.products.map((p) => project(p, ["image", "images"])) };
    }
    if (s.startsWith("SELECT id FROM products WHERE slug = ? AND id != ?")) {
      return { first: db.products.find((p) => p.slug === a[0] && p.id !== a[1]) || null };
    }
    if (s.startsWith("SELECT id FROM products WHERE slug = ?")) {
      return { first: db.products.find((p) => p.slug === a[0]) || null };
    }
    if (s.startsWith("SELECT id FROM products WHERE id IN (")) {
      const want = new Set(a);
      return { results: db.products.filter((p) => want.has(p.id)).map((p) => ({ id: p.id })) };
    }
    if (s.startsWith("SELECT id, slug, name, price_paise, visible FROM products WHERE id IN (")) {
      const want = new Set(a);
      return { results: db.products.filter((p) => want.has(p.id))
        .map((p) => project(p, ["id", "slug", "name", "price_paise", "visible"])) };
    }
    if (s.startsWith("SELECT id FROM products WHERE id = ?")) {
      return { first: db.products.find((p) => p.id === a[0]) || null };
    }
    if (s.startsWith("SELECT id, name FROM products WHERE id = ?")) {
      return { first: db.products.find((p) => p.id === a[0]) || null };
    }
    if (s.startsWith("INSERT INTO products")) {
      const [id, slug, name, description, price_paise, image, images, category, visible, sort, created_at, updated_at] = a;
      // Emulate the UNIQUE constraint on slug. Without it, the de-duplication
      // test would pass against a fake more permissive than the real database —
      // which is exactly how the collision shipped unnoticed in the first place.
      if (db.products.some((p) => p.slug === slug)) {
        throw new Error("UNIQUE constraint failed: products.slug");
      }
      db.products.push({ id, slug, name, description, price_paise, image, images, category, visible, sort, created_at, updated_at });
      return { meta: { changes: 1 } };
    }
    // Read by the batch planner to check slugs and already-listed images.
    if (s.startsWith("SELECT slug, image FROM products")) {
      return { results: db.products.map((p) => project(p, ["slug", "image"])) };
    }
    // describeProducts: fills a description that is MISSING.
    //
    // Must sit ABOVE the generic "UPDATE products SET" handler below, which reads the
    // LAST bind as a row id — this statement's last bind is a slug, so the generic
    // handler would look up id === "batman-figurine", find nothing, and report 0
    // changes for every write.
    //
    // The guard is honoured ONLY when the SQL actually carries it. That is
    // deliberate: a fake that refused overwrites unconditionally would be testing
    // itself, and deleting the WHERE clause from admin.js would still pass. This way
    // the mutation shows up as a failing assertion.
    if (s.startsWith("UPDATE products SET description = ?, category = COALESCE(")) {
      const [description, category, updated_at, slug] = a;
      const row = db.products.find((x) => x.slug === slug);
      if (!row) return { meta: { changes: 0 } };
      const guarded = s.includes("TRIM(description) = ''");
      if (guarded && String(row.description || "").trim()) return { meta: { changes: 0 } };
      row.description = description;
      if (category != null) row.category = category;
      row.updated_at = updated_at;
      return { meta: { changes: 1 } };
    }
    // Projected to two columns, so a test cannot pass because the fake handed back
    // the whole row — the mistake that let the coupon-edit bug through.
    if (s.startsWith("SELECT slug, description FROM products")) {
      // _raceDescriptions makes this read report every description as empty while the
      // stored rows keep theirs. That is exactly the race describeProducts' WHERE
      // clause exists for: a row gains a description between the validate pass and the
      // write. Without it the JS check answers 409 first and the SQL guard is never
      // reached, so deleting the guard broke no functional test — only a source-text
      // assertion, which proves the clause is PRESENT and not that it WORKS.
      const rows = db.products.map((p) => project(p, ["slug", "description"]));
      if (db._raceDescriptions) for (const r of rows) r.description = "";
      return { results: rows };
    }
    if (s.startsWith("UPDATE products SET")) {
      const id = a[a.length - 1];
      const p = db.products.find((x) => x.id === id);
      if (p) applySets(p, s, "UPDATE products SET ", a);
      return { meta: { changes: p ? 1 : 0 } };
    }
    if (s.startsWith("DELETE FROM products WHERE id = ?")) {
      const n = db.products.length;
      db.products = db.products.filter((p) => p.id !== a[0]);
      return { meta: { changes: n - db.products.length } };
    }
    if (s.startsWith("SELECT COUNT(*) AS n FROM order_items WHERE product_id = ?")) {
      return { first: { n: db.order_items.filter((i) => i.product_id === a[0]).length } };
    }
    if (s.startsWith("SELECT id, receipt, rzp_order_id,")) {
      const status = s.includes("WHERE status = ?") ? a[0] : null;
      const rows = status ? db.orders.filter((o) => o.status === status) : db.orders;
      return { results: [...rows].sort((x, y) => y.created_at - x.created_at) };
    }
    if (s.startsWith("SELECT order_id, name, price_paise, qty, personalisation, pos FROM order_items")) {
      const want = new Set(a);
      return { results: db.order_items.filter((i) => want.has(i.order_id)) };
    }
    if (s.startsWith("SELECT status, COUNT(*) AS n, SUM(total_paise) AS total FROM orders GROUP BY status")) {
      const m = new Map();
      for (const o of db.orders) {
        const e = m.get(o.status) || { status: o.status, n: 0, total: 0 };
        e.n++; e.total += o.total_paise; m.set(o.status, e);
      }
      return { results: [...m.values()] };
    }
    if (s.startsWith("SELECT id, status, receipt FROM orders WHERE id = ?")) {
      return { first: db.orders.find((o) => o.id === a[0]) || null };
    }
    // updateOrder reads the whole row now: the shipped email needs the customer's
    // name, email and address, and listing those columns would mean editing the
    // query every time the template wants another field.
    if (s.startsWith("SELECT * FROM orders WHERE id = ?")) {
      return { first: db.orders.find((o) => o.id === a[0]) || null };
    }
    if (s.startsWith("SELECT id, receipt, status, total_paise, rzp_payment_id FROM orders WHERE id = ?")) {
      return { first: db.orders.find((o) => o.id === a[0]) || null };
    }
    // Projected, not the whole row: a test asserting a column is NOT returned
    // must not pass because the fake handed back everything.
    if (s.startsWith("SELECT id, receipt, status, notes, paid_at, production_at, ready_at, shipped_at, delivered_at, courier, tracking_id FROM orders WHERE id = ?")) {
      const o = db.orders.find((x) => x.id === a[0]);
      return { first: o ? project(o, ["id", "receipt", "status", "notes", "paid_at",
        "production_at", "ready_at", "shipped_at", "delivered_at", "courier", "tracking_id"]) : null };
    }
    if (s.startsWith("SELECT id, receipt, status, notes, shipped_at FROM orders WHERE id = ?")) {
      const o = db.orders.find((x) => x.id === a[0]);
      return { first: o ? { id: o.id, receipt: o.receipt, status: o.status, notes: o.notes, shipped_at: o.shipped_at } : null };
    }
    if (s.startsWith("UPDATE orders SET notes = TRIM")) {
      const o = db.orders.find((x) => x.id === a[1]);
      if (o) o.notes = ((o.notes || "") + " " + a[0]).trim();
      return { meta: { changes: o ? 1 : 0 } };
    }
    if (s.startsWith("UPDATE orders SET status = 'refunded'")) {
      const o = db.orders.find((x) => x.id === a[0]);
      if (o) o.status = "refunded";
      return { meta: { changes: o ? 1 : 0 } };
    }
    if (s.startsWith("UPDATE orders SET")) {
      const id = a[a.length - 1];
      const o = db.orders.find((x) => x.id === id);
      if (o) applySets(o, s, "UPDATE orders SET ", a);
      return { meta: { changes: o ? 1 : 0 } };
    }
    if (s.startsWith("SELECT COUNT(*) AS orders, COALESCE(SUM(total_paise),0) AS revenue")) {
      // Parse the IN (...) list out of the SQL rather than hardcoding it, so
      // the fake cannot agree with the test while disagreeing with the query.
      const list = (s.match(/status IN \(([^)]*)\)/) || [])[1] || "";
      const statuses = list.split(",").map((x) => x.trim().replace(/^'|'$/g, ""));
      const rows = db.orders.filter((o) => statuses.includes(o.status));
      return { first: { orders: rows.length, revenue: rows.reduce((n, o) => n + o.total_paise, 0) } };
    }
    if (s.startsWith("SELECT COUNT(*) AS n FROM orders WHERE status = 'pending'")) {
      return { first: { n: db.orders.filter((o) => o.status === "pending").length } };
    }
    if (s.startsWith("SELECT COUNT(*) AS total, COALESCE(SUM(visible),0) AS visible FROM products")) {
      return { first: { total: db.products.length, visible: db.products.reduce((n, p) => n + (p.visible ? 1 : 0), 0) } };
    }
    if (s.startsWith("SELECT id, slug, name, description, price_paise, image, images, category, visible, sort, updated_at FROM products WHERE id = ?")) {
      return { first: db.products.find((p) => p.id === a[0]) || null };
    }
    throw new Error("unhandled SQL: " + s.slice(0, 100));
  };
  return {
    _db: db,
    prepare(sql) {
      // bind() returns a NEW statement, as real D1 does — it does not mutate and
      // return itself.
      //
      // batchCreateProducts() prepares ONE statement and binds it once per row,
      // collecting the results into an array for batch(). Against a fake that
      // returns `this`, every element of that array is the same object carrying
      // the LAST row's arguments — so a 4-photo batch would write one row four
      // times and the test would still see "4 rows written". The identical bug
      // hid a real defect in the invoicer's line items earlier today.
      const make = (args) => ({
        bind: (...a) => make(a),
        async all() { return { results: run(sql, args).results || [] }; },
        async first() { return run(sql, args).first ?? null; },
        async run() { return run(sql, args); },
      });
      return make([]);
    },
    // Real D1 batch() is a single transaction. Snapshot first so a throw
    // mid-way rolls back, matching production rather than leaving the fake in a
    // half-written state a real failure could never produce.
    async batch(stmts) {
      const snapshot = JSON.parse(JSON.stringify(db));
      try {
        const out = [];
        for (const st of stmts) out.push(await st.run());
        return out;
      } catch (e) {
        for (const k of Object.keys(snapshot)) db[k] = snapshot[k];
        throw e;
      }
    },
  };
}

const PRODUCT = {
  id: "11111111-1111-4111-8111-111111111111",
  slug: "kingfisher", name: "Kingfisher", description: "d",
  price_paise: 34900, image: "assets/images/k.jpg", images: "",
  category: "figurine", visible: 1, sort: 10, created_at: 1, updated_at: 1,
};
const ORDER = {
  id: "22222222-2222-4222-8222-222222222222",
  receipt: "AP-aaaaaaaa", rzp_order_id: "order_A", rzp_payment_id: "pay_A",
  status: "paid", subtotal_paise: 34900, shipping_paise: 9900, total_paise: 44800,
  delivery: "ship", cust_name: "Buyer", cust_email: "b@example.com", cust_phone: "9000090000",
  addr_line: "1 St", addr_city: "Pondicherry", addr_state: "PY", addr_pin: "605001",
  notes: "", created_at: 1000, paid_at: 2000, shipped_at: null,
};
// The image manifest, served through the ASSETS binding exactly as Cloudflare
// does. createProduct() now checks every image path against it — a Worker cannot
// list a directory, so this file is the only record of what exists.
const MANIFEST_FILES = ["n.jpg", "i.jpg", "kingfisher.jpg", "dragon.jpg", "extra1.jpg", "extra2.jpg"];

const makeAssets = (files = MANIFEST_FILES) => ({
  fetch: async (req) => {
    if (!String(req.url).endsWith("/assets/images.json")) return new Response("", { status: 404 });
    return new Response(JSON.stringify({
      generated_at: 1786000000000,
      count: files.length,
      images: files.map((f) => ({ file: f, bytes: 1000 })),
    }), { status: 200 });
  },
});

const envDB = (seed) => ({ ...BASE_ENV, DB: makeDB(seed), ASSETS: makeAssets() });
const read = async (res) => [res.status, await res.json()];

// ── products ──────────────────────────────────────────────────────
section("admin products — list includes hidden rows");
{
  const env = envDB({ products: [PRODUCT, { ...PRODUCT, id: "x", slug: "hidden-one", visible: 0 }] });
  const [, out] = await read(await listProducts(env));
  ok("returns both visible and hidden", out.products.length === 2);
  ok("exposes the visible flag", out.products.some((p) => p.visible === 0));
}

section("admin products — update checks the image against the manifest");
{
  const env = envDB({ products: [PRODUCT] });
  for (const image of ["https://evil.example/x.jpg", "//evil.example/x.jpg", "../../etc/passwd", "not-in-manifest.jpg"]) {
    const [status] = await read(await updateProduct(env, PRODUCT.id, { image }));
    ok(`rejects ${image}`, status === 400, String(status));
  }
  const [status] = await read(await updateProduct(env, PRODUCT.id, { image: "dragon.jpg", images: "extra1.jpg, assets/images/extra2.jpg" }));
  ok("accepts a file that exists", status === 200, String(status));
  const row = env.DB._db.products[0];
  ok("stores the canonical path", row.image === "assets/images/dragon.jpg", row.image);
  ok("extras are canonical too", row.images === "assets/images/extra1.jpg,assets/images/extra2.jpg", row.images);
  const [bad] = await read(await updateProduct(env, PRODUCT.id, { images: "extra1.jpg,ghost.jpg" }));
  ok("an unknown extra is refused", bad === 400);
}

section("admin products — price validation");
{
  for (const [label, price] of [
    ["float", 349.5], ["string float", "349.5"], ["negative", -100],
    ["NaN", "abc"], ["empty", ""], ["null", null], ["Infinity", Infinity],
  ]) {
    const env = envDB({ products: [PRODUCT] });
    const [status] = await read(await updateProduct(env, PRODUCT.id, { price_paise: price }));
    ok(`${label} price rejected`, status === 400);
    ok(`${label} leaves the price untouched`, env.DB._db.products[0].price_paise === 34900);
  }
  const env = envDB({ products: [PRODUCT] });
  const [status] = await read(await updateProduct(env, PRODUCT.id, { price_paise: 49900 }));
  ok("integer paise accepted", status === 200);
  ok("price actually changed", env.DB._db.products[0].price_paise === 49900);
  ok("zero is allowed (a free item is legitimate)",
     (await read(await updateProduct(envDB({ products: [PRODUCT] }), PRODUCT.id, { price_paise: 0 })))[0] === 200);
}

section("admin products — PATCH only touches supplied fields");
{
  const env = envDB({ products: [PRODUCT] });
  await updateProduct(env, PRODUCT.id, { visible: 0 });
  const p = env.DB._db.products[0];
  ok("visibility changed", p.visible === 0);
  ok("name untouched", p.name === "Kingfisher");
  ok("price untouched", p.price_paise === 34900);
  ok("updated_at bumped", p.updated_at !== 1);
}

section("admin products — pinning");
{
  // A toggle, so it is coerced rather than validated: there is no value a caller
  // could send that means anything other than on or off. What matters is that it
  // reaches the column as 1 or 0 and never as the caller's own value.
  const env = envDB({ products: [PRODUCT] });
  ok("pin accepted", (await read(await updateProduct(env, PRODUCT.id, { pinned: true })))[0] === 200);
  ok("stored as 1, not true", env.DB._db.products[0].pinned === 1);

  ok("unpin accepted", (await read(await updateProduct(env, PRODUCT.id, { pinned: false })))[0] === 200);
  ok("stored as 0, not false", env.DB._db.products[0].pinned === 0);

  // Truthy junk must not land in the column verbatim — that is what a bound
  // integer column is for, and what `? 1 : 0` guarantees before it gets there.
  for (const [label, val] of [
    ["a string", "yes"], ["a number", 7], ["an object", { on: 1 }], ["an array", [1]],
  ]) {
    const e = envDB({ products: [PRODUCT] });
    await updateProduct(e, PRODUCT.id, { pinned: val });
    ok(`${label} is coerced to 1`, e.DB._db.products[0].pinned === 1);
  }
  for (const [label, val] of [["null", null], ["empty string", ""], ["zero", 0]]) {
    const e = envDB({ products: [{ ...PRODUCT, pinned: 1 }] });
    await updateProduct(e, PRODUCT.id, { pinned: val });
    ok(`${label} is coerced to 0`, e.DB._db.products[0].pinned === 0);
  }

  // Pinning is one field among many; it must not drag anything else with it.
  const only = envDB({ products: [PRODUCT] });
  await updateProduct(only, PRODUCT.id, { pinned: true });
  ok("price untouched by a pin", only.DB._db.products[0].price_paise === 34900);
  ok("visibility untouched by a pin", only.DB._db.products[0].visible === 1);

  // Omitting the field must leave an existing pin alone, or an unrelated price
  // edit from the dashboard would silently unpin the product.
  const kept = envDB({ products: [{ ...PRODUCT, pinned: 1 }] });
  await updateProduct(kept, PRODUCT.id, { price_paise: 49900 });
  ok("a patch without `pinned` leaves the pin alone", kept.DB._db.products[0].pinned === 1);

  ok("a pin on an unknown id is still 404",
     (await read(await updateProduct(envDB({ products: [PRODUCT] }), "nope", { pinned: true })))[0] === 404);
}

section("admin products — pinning in bulk");
{
  const env = envDB({ products: [PRODUCT, { ...PRODUCT, id: "p2", slug: "second" }] });
  const [status] = await read(await bulkUpdateProducts(env, { items: [
    { id: PRODUCT.id, pinned: true },
    { id: "p2", pinned: false },
  ] }));
  ok("bulk accepts pinned", status === 200);
  ok("bulk pin stored as 1", env.DB._db.products.find((p) => p.id === PRODUCT.id).pinned === 1);
  ok("bulk unpin stored as 0", env.DB._db.products.find((p) => p.id === "p2").pinned === 0);

  // pinned alone is a real update — it must not trip the "nothing to update" guard.
  ok("pinned alone is not an empty patch",
     (await read(await bulkUpdateProducts(envDB({ products: [PRODUCT] }),
       { items: [{ id: PRODUCT.id, pinned: true }] })))[0] === 200);
}

section("admin products — misc validation");
{
  ok("unknown id → 404",
     (await read(await updateProduct(envDB({ products: [PRODUCT] }), "nope", { visible: 1 })))[0] === 404);
  ok("empty patch → 400",
     (await read(await updateProduct(envDB({ products: [PRODUCT] }), PRODUCT.id, {})))[0] === 400);
  ok("empty image rejected",
     (await read(await updateProduct(envDB({ products: [PRODUCT] }), PRODUCT.id, { image: "  " })))[0] === 400);
  ok("short name rejected",
     (await read(await updateProduct(envDB({ products: [PRODUCT] }), PRODUCT.id, { name: "a" })))[0] === 400);

  // Slug collisions would break the public URL space.
  const env = envDB({ products: [PRODUCT, { ...PRODUCT, id: "other", slug: "elephant" }] });
  ok("duplicate slug → 409",
     (await read(await updateProduct(env, PRODUCT.id, { slug: "elephant" })))[0] === 409);
  ok("own slug is not a collision",
     (await read(await updateProduct(env, PRODUCT.id, { slug: "kingfisher" })))[0] === 200);
}

section("admin products — create");
{
  const env = envDB();
  const [status, out] = await read(await createProduct(env, {
    name: "New Thing", price_paise: 55500, image: "assets/images/n.jpg", visible: true,
  }));
  ok("201", status === 201, String(status));
  ok("slug derived from the name", out.slug === "new-thing", out.slug);
  ok("row inserted", env.DB._db.products.length === 1);
  ok("defaults to the given visibility", env.DB._db.products[0].visible === 1);

  ok("duplicate slug → 409",
     (await read(await createProduct(env, { name: "New Thing", price_paise: 1000, image: "i.jpg" })))[0] === 409);
  ok("missing name → 400",
     (await read(await createProduct(envDB(), { price_paise: 1000, image: "i.jpg" })))[0] === 400);
  ok("missing price → 400",
     (await read(await createProduct(envDB(), { name: "Thing", image: "i.jpg" })))[0] === 400);
  ok("missing image → 400",
     (await read(await createProduct(envDB(), { name: "Thing", price_paise: 1000 })))[0] === 400);
  // A name of only punctuation yields an empty slug.
  ok("unsluggable name → 400",
     (await read(await createProduct(envDB(), { name: "!!!", price_paise: 1000, image: "i.jpg" })))[0] === 400);
}

// ── the image must be a file that actually exists ─────────────────
//
// THE tampering block for this feature. `image` is a client-controlled string,
// so without a check against the manifest a product could point at an external
// URL (the shop would render a stranger's image and leak referrer traffic), at a
// path traversal, or at a file that simply is not there — producing a listing
// with a broken image that looks live.
//
// Same rule as priceCart: the client NAMES a thing, the server decides whether
// it is real.
section("admin products — the image path cannot be forged");
{
  const attempts = [
    ["external URL", "https://evil.com/x.jpg"],
    ["protocol-relative URL", "//evil.com/x.jpg"],
    ["http URL", "http://evil.com/x.jpg"],
    ["path traversal", "../../etc/passwd"],
    ["traversal ending in a real name", "assets/images/../../../n.jpg"],
    ["a file that does not exist", "assets/images/not-a-real-photo.jpg"],
    ["a plausible but absent name", "IMG20260101_nope.jpg"],
    ["empty string", ""],
  ];
  for (const [label, image] of attempts) {
    const env = envDB();
    const [status] = await read(await createProduct(env, {
      name: "Attack " + label, price_paise: 9900, image,
    }));
    ok(`${label} → refused`, status === 400, String(status));
    ok(`${label} → no row written`, env.DB._db.products.length === 0);
  }
}
{
  // A real file is accepted with or without the assets/images/ prefix, and is
  // stored canonically either way — so a valid filename with a strange prefix
  // cannot reach the database verbatim.
  for (const [label, image] of [
    ["full path", "assets/images/n.jpg"],
    ["bare filename", "n.jpg"],
    ["a leading slash", "/assets/images/n.jpg"],
  ]) {
    const env = envDB();
    const [status, out] = await read(await createProduct(env, {
      name: "Real " + label, price_paise: 9900, image,
    }));
    ok(`${label} → accepted`, status === 201, String(status));
    ok(`${label} → stored canonically`, out.image === "assets/images/n.jpg", out.image);
  }
}
{
  // Secondary views are rendered on the product page exactly like the primary
  // image, so they get the same check.
  const env = envDB();
  const [okStatus] = await read(await createProduct(env, {
    name: "With extras", price_paise: 9900, image: "n.jpg", images: "extra1.jpg, extra2.jpg",
  }));
  ok("valid extra images accepted", okStatus === 201, String(okStatus));
  ok("extras stored canonically",
     env.DB._db.products[0].images === "assets/images/extra1.jpg,assets/images/extra2.jpg",
     env.DB._db.products[0].images);

  const env2 = envDB();
  const [badStatus] = await read(await createProduct(env2, {
    name: "Bad extras", price_paise: 9900, image: "n.jpg", images: "extra1.jpg,https://evil.com/x.jpg",
  }));
  ok("a forged extra image → refused", badStatus === 400, String(badStatus));
  ok("and no row written", env2.DB._db.products.length === 0);
}
{
  // Without a manifest the server cannot tell a real photo from an invented one.
  // Fails CLOSED — creating products that may render broken is worse than
  // refusing until `npm run images` has been run.
  const env = { ...BASE_ENV, DB: makeDB(), ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
  const [status] = await read(await createProduct(env, {
    name: "No manifest", price_paise: 9900, image: "n.jpg",
  }));
  ok("missing manifest → 503, not a guess", status === 503, String(status));
  ok("and no row written", env.DB._db.products.length === 0);
}

// ── batch listing ─────────────────────────────────────────────────
//
// The batch form used to take ONE price for the whole selection. It now submits each
// row's own price, so the assertions that matter are the ones proving the values do
// not bleed between rows: a single prepared statement is bound once per row inside
// batch(), and every way that can go wrong ends with several products sharing one
// price. That is money, so it is asserted from more than one angle.
section("admin products — batch list");
{
  const env = envDB();
  const [status, out] = await read(await batchCreateProducts(env, {
    items: [
      { file: "n.jpg", price_paise: 44900, category: "decor", name: "Nice Thing",
        description: "A described thing." },
      { file: "i.jpg", price_paise: 9900, category: "functional" },
      { file: "kingfisher.jpg", price_paise: 129900, category: "figurine" },
    ],
  }));
  ok("201", status === 201, String(status));
  ok("all three written", env.DB._db.products.length === 3, String(env.DB._db.products.length));
  ok("reports the count", out.created === 3);

  const bySlug = (frag) => env.DB._db.products.find((p) => p.image.includes(frag));

  // THE point of the change: three different prices, one click.
  ok("each row keeps its OWN price",
     bySlug("n.jpg").price_paise === 44900
     && bySlug("i.jpg").price_paise === 9900
     && bySlug("kingfisher.jpg").price_paise === 129900,
     env.DB._db.products.map((p) => p.price_paise).join(","));
  ok("prices are not all the same value",
     new Set(env.DB._db.products.map((p) => p.price_paise)).size === 3,
     "a shared price means the binding aliased across rows");

  ok("each row keeps its own category",
     bySlug("n.jpg").category === "decor"
     && bySlug("i.jpg").category === "functional"
     && bySlug("kingfisher.jpg").category === "figurine",
     env.DB._db.products.map((p) => p.category).join(","));

  // The description box exists on every row of the panel. writeProductRows used to
  // bind "" regardless, so anything typed there was silently discarded.
  ok("a row's description is written, not dropped",
     bySlug("n.jpg").description === "A described thing.",
     JSON.stringify(bySlug("n.jpg").description));
  ok("a row with no description gets an empty one, not undefined",
     bySlug("i.jpg").description === "");

  ok("every row is visible", env.DB._db.products.every((p) => p.visible === 1));

  // Each row must carry ITS OWN image — the bug a fake with an aliasing bind()
  // would hide entirely.
  const imgs = env.DB._db.products.map((p) => p.image).sort();
  ok("each row keeps its own image",
     imgs.join(",") === "assets/images/i.jpg,assets/images/kingfisher.jpg,assets/images/n.jpg",
     imgs.join(","));
  ok("a supplied name is used", bySlug("n.jpg").name === "Nice Thing", bySlug("n.jpg").name);
  // kingfisher.jpg, not i.jpg: suggestName("i.jpg") is legitimately the single
  // letter "I", so a length check there tests nothing about the fallback.
  ok("a missing name falls back to one derived from the filename",
     bySlug("kingfisher.jpg").name === "Kingfisher",
     bySlug("kingfisher.jpg").name);
  ok("names are distinct per file",
     new Set(env.DB._db.products.map((p) => p.name)).size === 3,
     env.DB._db.products.map((p) => p.name).join(","));
}
{
  // A dashboard tab opened before this shipped posts the old shape. Answer with an
  // instruction rather than "No photos selected.", which sends Aswin looking for a
  // selection bug that does not exist.
  const env = envDB();
  const [status, out] = await read(await batchCreateProducts(env, {
    images: ["n.jpg", "i.jpg"], price_paise: 9900,
  }));
  ok("the old {images, price_paise} shape is refused", status === 409, String(status));
  ok("and says to reload", /out of date|reload/i.test(out.error || ""), out.error);
  ok("and writes nothing", env.DB._db.products.length === 0);
}
{
  // THE case that motivated de-duplication. These two real filenames both
  // slugify to "poster-wall-staircase"; without handling, the second INSERT
  // violates UNIQUE(slug) and the batch dies partway.
  const env = { ...BASE_ENV, DB: makeDB(),
    ASSETS: makeAssets(["poster_wall_staircase.jpg", "poster_wall_staircase_v2.jpg"]) };

  // Caught rather than allowed to propagate: without de-duplication the fake's
  // UNIQUE constraint throws, which would abort the whole suite with a stack
  // trace instead of reporting which assertion failed.
  let status = 0, threw = "";
  try {
    [status] = await read(await batchCreateProducts(env, {
      items: [
        { file: "poster_wall_staircase.jpg", price_paise: 9900 },
        { file: "poster_wall_staircase_v2.jpg", price_paise: 9900 },
      ],
    }));
  } catch (e) {
    threw = String(e?.message || e);
  }
  ok("colliding slugs do not hit the UNIQUE constraint", !threw, threw);
  ok("colliding slugs still list", status === 201, String(status));
  ok("both rows written", env.DB._db.products.length === 2, String(env.DB._db.products.length));
  const slugs = env.DB._db.products.map((p) => p.slug);
  ok("slugs are made unique", new Set(slugs).size === 2, slugs.join(","));
  ok("the second is suffixed", slugs.some((s) => /-2$/.test(s)), slugs.join(","));
}
{
  // Nothing is written unless everything validates. A partial batch is the worst
  // outcome: some photos listed, some not, and no indication which.
  const cases = [
    ["one bad file among good", ["n.jpg", "not-in-manifest.jpg", "i.jpg"]],
    ["external URL", ["https://evil.com/x.jpg"]],
    ["path traversal", ["../../etc/passwd"]],
    ["traversal ending in a real name", ["assets/images/../../n.jpg"]],
    ["the same file twice", ["n.jpg", "n.jpg"]],
    ["empty selection", []],
  ];
  for (const [label, images] of cases) {
    const env = envDB();
    const items = images.map((file) => ({ file, price_paise: 9900 }));
    const [status] = await read(await batchCreateProducts(env, { items }));
    ok(`${label} → refused`, status === 400, String(status));
    ok(`${label} → NOTHING written`, env.DB._db.products.length === 0,
       `${env.DB._db.products.length} rows`);
  }
}
{
  const env = envDB();
  ok("a row with no price → refused",
     (await read(await batchCreateProducts(env, { items: [{ file: "n.jpg" }] })))[0] === 400);
  ok("a row with zero price → refused",
     (await read(await batchCreateProducts(env, { items: [{ file: "n.jpg", price_paise: 0 }] })))[0] === 400);

  // One unpriced row among priced ones must refuse the WHOLE batch. Skipping it
  // server-side would list some photos and silently ignore others.
  const [mixedStatus, mixedOut] = await read(await batchCreateProducts(env, {
    items: [
      { file: "n.jpg", price_paise: 9900 },
      { file: "i.jpg" },
      { file: "kingfisher.jpg", price_paise: 9900 },
    ],
  }));
  ok("one unpriced row refuses the whole batch", mixedStatus === 400, String(mixedStatus));
  ok("and the error names the offending file", /i\.jpg/.test(mixedOut.error || ""), mixedOut.error);
  ok("and nothing written", env.DB._db.products.length === 0,
     `${env.DB._db.products.length} rows`);

  const many = Array.from({ length: 101 }, () => ({ file: "n.jpg", price_paise: 100 }));
  ok("over 100 photos → refused",
     (await read(await batchCreateProducts(env, { items: many })))[0] === 400);
}
{
  // A photo that is already a product cannot be listed twice.
  const env = envDB();
  await batchCreateProducts(env, { items: [{ file: "n.jpg", price_paise: 9900 }] });
  const [status] = await read(await batchCreateProducts(env,
    { items: [{ file: "n.jpg", price_paise: 9900 }] }));
  ok("re-listing the same photo → refused", status === 400, String(status));
  ok("and still only one row", env.DB._db.products.length === 1);
}

// ── hiding photos ─────────────────────────────────────────────────
//
// The real requirement: an Instagram poster (including a GIVEAWAY card) must be
// removable from the storefront without deleting the file, which is still needed
// for Instagram.
section("admin products — hide photos");
{
  const env = envDB();
  const [status, out] = await read(await hideImages(env, { images: ["n.jpg", "i.jpg"] }));
  ok("201", status === 201, String(status));
  ok("reports the count", out.hidden === 2);
  ok("a row per image", env.DB._db.products.length === 2);
  ok("all hidden", env.DB._db.products.every((p) => p.visible === 0));
  // Priced at 0 so that even if one were made visible by accident, priceCart
  // refuses it — belt and braces with visible = 0.
  ok("all unpriced", env.DB._db.products.every((p) => p.price_paise === 0));
  ok("no price is required to hide", true);
}
{
  // The same guards as batch listing.
  for (const [label, images] of [
    ["a forged path", ["https://evil.com/x.jpg"]],
    ["a file not in the manifest", ["nope.jpg"]],
    ["an empty selection", []],
  ]) {
    const env = envDB();
    const [status] = await read(await hideImages(env, { images }));
    ok(`hide ${label} → refused`, status === 400, String(status));
    ok(`hide ${label} → nothing written`, env.DB._db.products.length === 0);
  }
}
{
  // What the user actually sees: a hidden photo leaves the unlisted panel.
  const env = envDB();
  const before = (await read(await unlistedImages(env)))[1].images.length;
  await hideImages(env, { images: ["kingfisher.jpg"] });
  const after = (await read(await unlistedImages(env)))[1];
  ok("a hidden photo leaves the unlisted list", after.images.length === before - 1,
     `${before} → ${after.images.length}`);
  ok("and it is specifically that photo",
     !after.images.some((i) => i.file === "kingfisher.jpg"));
}

// ── which photos still need listing ───────────────────────────────
section("admin products — unlisted photos");
{
  // Two products between them use three files; the manifest has six.
  const env = envDB({
    products: [
      { id: "p1", slug: "a", name: "A", price_paise: 100, image: "assets/images/n.jpg",
        images: "", category: "figurine", visible: 1, sort: 10, created_at: 1, updated_at: 1 },
      { id: "p2", slug: "b", name: "B", price_paise: 100, image: "assets/images/dragon.jpg",
        images: "assets/images/extra1.jpg", category: "decor", visible: 1, sort: 20,
        created_at: 1, updated_at: 1 },
    ],
  });
  const [status, out] = await read(await unlistedImages(env));
  ok("200", status === 200, String(status));

  const files = out.images.map((i) => i.file).sort();
  ok("returns exactly the unused files",
     files.join(",") === "extra2.jpg,i.jpg,kingfisher.jpg", files.join(","));

  // The one that is easy to get wrong: a photo used only as a SECONDARY view is
  // not unlisted, and offering to list it would create a duplicate product from
  // a photo of one that already exists.
  ok("a secondary-view image is not offered as unlisted", !files.includes("extra1.jpg"));
  ok("the primary image is not offered", !files.includes("n.jpg"));
  ok("counts are reported", out.total_images === 6 && out.listed === 3,
     `${out.total_images}/${out.listed}`);
  ok("each entry carries a usable path",
     out.images.every((i) => i.path === `assets/images/${i.file}`));
  ok("each entry carries a suggested name",
     out.images.every((i) => typeof i.suggested_name === "string"));
}
{
  // Listing one removes it from the next response.
  const env = envDB();
  const before = (await read(await unlistedImages(env)))[1].images.length;
  await createProduct(env, { name: "Kingfisher", price_paise: 34900, image: "kingfisher.jpg" });
  const after = (await read(await unlistedImages(env)))[1];
  ok("listing a photo removes it from unlisted", after.images.length === before - 1,
     `${before} → ${after.images.length}`);
  ok("and it is specifically that photo",
     !after.images.some((i) => i.file === "kingfisher.jpg"));
}
{
  // No manifest: say so rather than claiming every photo is listed, which would
  // read as "nothing to do".
  const env = { ...BASE_ENV, DB: makeDB(), ASSETS: { fetch: async () => new Response("", { status: 404 }) } };
  const [status, out] = await read(await unlistedImages(env));
  ok("missing manifest → reported, not silently empty",
     status === 200 && out.manifest_missing === true, JSON.stringify(out).slice(0, 60));
  ok("and the error names the fix", /npm run images/.test(out.error || ""));
}

// Deleting a sold product must not destroy order history.
section("admin products — delete protects order history");
{
  const env = envDB({
    products: [PRODUCT],
    order_items: [{ order_id: ORDER.id, product_id: PRODUCT.id, name: "Kingfisher", price_paise: 34900, qty: 1, pos: 0 }],
  });
  const [status, out] = await read(await deleteProduct(env, PRODUCT.id));
  ok("200", status === 200);
  ok("hidden, not deleted", out.hidden === true);
  ok("row still present", env.DB._db.products.length === 1);
  ok("row is now hidden", env.DB._db.products[0].visible === 0);
  ok("order line survives", env.DB._db.order_items.length === 1);
  ok("message explains why", /hidden rather than deleted/i.test(out.message));
}
{
  const env = envDB({ products: [PRODUCT] });
  const [, out] = await read(await deleteProduct(env, PRODUCT.id));
  ok("never-sold product is really deleted", out.deleted === true);
  ok("row gone", env.DB._db.products.length === 0);
}
ok("delete unknown id → 404", (await read(await deleteProduct(envDB(), "nope")))[0] === 404);

// ── orders ────────────────────────────────────────────────────────
section("admin orders — list");
{
  const env = envDB({
    orders: [ORDER, { ...ORDER, id: "o2", receipt: "AP-bbbbbbbb", status: "pending", created_at: 2000 }],
    order_items: [{ order_id: ORDER.id, product_id: PRODUCT.id, name: "Kingfisher", price_paise: 34900, qty: 1, pos: 0 }],
  });
  const [, out] = await read(await listOrders(env, new URL("http://x/api/admin/orders")));
  ok("returns both orders", out.orders.length === 2);
  ok("newest first", out.orders[0].receipt === "AP-bbbbbbbb");
  ok("line items attached", out.orders.find((o) => o.receipt === "AP-aaaaaaaa").items.length === 1);
  ok("status counts included", Array.isArray(out.counts) && out.counts.length === 2);
  // The dashboard needs these; the PUBLIC receipt endpoint must not return them.
  ok("includes the customer email (owner-only view)", "cust_email" in out.orders[0]);
  ok("includes the address", "addr_line" in out.orders[0]);

  const [, filtered] = await read(await listOrders(env, new URL("http://x/api/admin/orders?status=paid")));
  ok("status filter works", filtered.orders.length === 1 && filtered.orders[0].status === "paid");

  const [, bogus] = await read(await listOrders(env, new URL("http://x/api/admin/orders?status=nonsense")));
  ok("unknown status filter is ignored, not injected", bogus.orders.length === 2);
}

section("admin orders — status transitions");
{
  // The webhook owns 'paid'. Letting the dashboard set it would mean an unpaid
  // order could be marked paid by hand.
  const env = envDB({ orders: [{ ...ORDER, status: "pending" }] });
  const [status, out] = await read(await updateOrder(env, ORDER.id, { status: "paid" }));
  ok("cannot set paid by hand", status === 409, String(status));
  ok("explains why", /webhook/i.test(out.error));
  ok("order untouched", env.DB._db.orders[0].status === "pending");
}
{
  const env = envDB({ orders: [ORDER] });
  const [status] = await read(await updateOrder(env, ORDER.id, { status: "shipped" }));
  ok("paid → shipped allowed", status === 200);
  ok("shipped_at stamped", typeof env.DB._db.orders[0].shipped_at === "number");
}

// ── the production stages ─────────────────────────────────────────
//
// An order used to go paid -> shipped, so every day the print was being made was
// invisible to the customer. These assert the widened pipeline, and — more
// importantly — the things it could quietly have broken on the way past.
section("admin orders — the production stages");
{
  // Every legal step, walked end to end, checking the timestamp each stamps.
  const stamps = { in_production: "production_at", ready: "ready_at",
                   shipped: "shipped_at", delivered: "delivered_at" };
  const env = envDB({ orders: [ORDER] });
  stubResend();
  for (const next of ["in_production", "ready", "shipped", "delivered"]) {
    const [st] = await read(await updateOrder(env, ORDER.id, { status: next }));
    ok(`advances to ${next}`, st === 200, String(st));
    ok(`${next} stamps ${stamps[next]}`,
       typeof env.DB._db.orders[0][stamps[next]] === "number",
       JSON.stringify(env.DB._db.orders[0][stamps[next]]));
  }
  ok("ends delivered", env.DB._db.orders[0].status === "delivered");
}
{
  // Skipping forward must stay legal, or something already on the shelf would
  // need four clicks to ship instead of one.
  ok("paid → shipped still allowed in one step",
     (await read(await updateOrder(envDB({ orders: [ORDER] }), ORDER.id, { status: "shipped" })))[0] === 200);
  ok("paid → ready allowed (skips production)",
     (await read(await updateOrder(envDB({ orders: [ORDER] }), ORDER.id, { status: "ready" })))[0] === 200);
}
{
  // Backwards and sideways are refused.
  const cases = [
    ["shipped", "in_production", "cannot go back to production once shipped"],
    ["delivered", "shipped", "delivered is terminal"],
    ["ready", "in_production", "cannot go back from ready"],
    ["pending", "in_production", "production needs payment first"],
    ["cancelled", "shipped", "a cancelled order cannot ship"],
  ];
  for (const [from, to, label] of cases) {
    const env = envDB({ orders: [{ ...ORDER, status: from }] });
    const [st] = await read(await updateOrder(env, ORDER.id, { status: to }));
    ok(label, st === 409, `${from} → ${to} gave ${st}`);
    ok(`${label} — order untouched`, env.DB._db.orders[0].status === from);
  }
}
{
  // The invariants the stages must not have loosened.
  ok("'paid' is still webhook-only from in_production",
     (await read(await updateOrder(envDB({ orders: [{ ...ORDER, status: "in_production" }] }),
       ORDER.id, { status: "paid" })))[0] === 409);
  ok("'refunded' is still refund-action-only",
     (await read(await updateOrder(envDB({ orders: [{ ...ORDER, status: "delivered" }] }),
       ORDER.id, { status: "refunded" })))[0] === 409);
  ok("an unknown stage is refused",
     (await read(await updateOrder(envDB({ orders: [ORDER] }), ORDER.id, { status: "printing" })))[0] === 400);
}

// THE REGRESSION THIS FEATURE COULD HAVE CAUSED. refundOrder() guarded on
// ["paid","shipped"]; adding stages without widening it makes an order
// unrefundable the moment production starts, which is precisely when a customer
// is most likely to change their mind.
section("admin orders — a refund survives every stage");
{
  for (const st of ["paid", "in_production", "ready", "shipped", "delivered"]) {
    const env = envDB({ orders: [{ ...ORDER, status: st }] });
    globalThis.fetch = async (u) => String(u).includes("razorpay")
      ? new Response(JSON.stringify({ id: "rfnd_1", amount: ORDER.total_paise, status: "processed" }), { status: 200 })
      : new Response("{}", { status: 200 });
    const [code, out] = await read(await refundOrder(env, ORDER.id, {}));
    ok(`refundable at ${st}`, code === 200, `got ${code} ${JSON.stringify(out).slice(0, 80)}`);
  }
  for (const st of ["pending", "cancelled", "failed"]) {
    const env = envDB({ orders: [{ ...ORDER, status: st }] });
    ok(`not refundable at ${st}`, (await read(await refundOrder(env, ORDER.id, {})))[0] === 409);
  }
}

section("admin orders — which stages email, and which do not");
{
  // 'ready' being absent from STAGE_EMAIL is the whole implementation of "it
  // advances the tracker but sends nothing". Assert the absence directly.
  const cases = [
    ["in_production", 1, /started printing/i],
    ["ready", 0, null],
    ["shipped", 1, /shipped/i],
    ["delivered", 1, /delivered/i],
  ];
  for (const [next, expected, subjectRe] of cases) {
    const from = { in_production: "paid", ready: "in_production",
                   shipped: "ready", delivered: "shipped" }[next];
    const env = envDB({ orders: [{ ...ORDER, status: from }] });
    const calls = stubResend();
    const [, out] = await read(await updateOrder(env, ORDER.id, { status: next }));
    ok(`${next} sends ${expected} email(s)`, calls.length === expected,
       `${calls.length}: ${JSON.stringify(calls.map((c) => c.subject))}`);
    ok(`${next} reports emailed=${Boolean(expected)}`, out.emailed === Boolean(expected));
    if (subjectRe) ok(`${next} subject reads right`, subjectRe.test(calls[0]?.subject || ""), calls[0]?.subject);
  }
}
{
  // Re-saving must not re-notify. This is why the flag keys off the TRANSITION
  // rather than the resulting status — correcting a typo'd tracking number a day
  // later must not tell the customer their order shipped a second time.
  // A distinctive old value, so a re-stamp is visible rather than hidden by two
  // Date.now() calls landing in the same millisecond.
  const env = envDB({ orders: [{ ...ORDER, status: "in_production", production_at: 1234 }] });
  const calls = stubResend();

  await updateOrder(env, ORDER.id, { status: "in_production" });
  ok("re-saving the same stage sends nothing", calls.length === 0, String(calls.length));
  // The one that matters: re-sending the same status must not move the time the
  // stage was actually reached, or the customer's tracker would quietly rewrite
  // its own history every time the order is touched.
  ok("re-saving the same stage does not re-stamp its time",
     env.DB._db.orders[0].production_at === 1234,
     String(env.DB._db.orders[0].production_at));

  await updateOrder(env, ORDER.id, { status: "shipped", tracking_id: "TRK1" });
  const shippedAt = env.DB._db.orders[0].shipped_at;
  ok("shipping stamps a time", typeof shippedAt === "number");
  ok("and the earlier stage's time is untouched", env.DB._db.orders[0].production_at === 1234);
  calls.length = 0;

  // Correcting a typo'd tracking number a day later must not tell the customer
  // their order shipped a second time, nor move when it shipped.
  await updateOrder(env, ORDER.id, { tracking_id: "TRK2" });
  ok("editing tracking sends nothing", calls.length === 0, String(calls.length));
  ok("and does not re-stamp shipped_at", env.DB._db.orders[0].shipped_at === shippedAt);
  ok("the correction did land", env.DB._db.orders[0].tracking_id === "TRK2");

  await updateOrder(env, ORDER.id, { notes: "packed carefully" });
  ok("editing notes sends nothing", calls.length === 0, String(calls.length));
}

// ── the shipped notification ──────────────────────────────────────
// The confirmation email promises "I'll email you again when it ships". Until
// now nothing kept that promise; these assert that it is kept, once, with
// whatever tracking detail was supplied.
section("marking shipped emails the customer");
{
  const env = envDB({ orders: [ORDER] });
  const calls = stubResend();
  const [status, out] = await read(
    await updateOrder(env, ORDER.id, { status: "shipped", courier: "Blue Dart", tracking_id: "BD123456789" }));
  ok("200", status === 200);
  ok("reports that it emailed", out.emailed === true);
  ok("one email sent", calls.length === 1, String(calls.length));
  ok("addressed to the customer", [].concat(calls[0]?.to || []).includes(ORDER.cust_email), JSON.stringify(calls[0]?.to));
  ok("subject names the receipt", (calls[0]?.subject || "").includes(ORDER.receipt), calls[0]?.subject);
  ok("body carries the courier", (calls[0]?.html || "").includes("Blue Dart"));
  ok("body carries the tracking id", (calls[0]?.html || "").includes("BD123456789"));
  ok("courier stored", env.DB._db.orders[0].courier === "Blue Dart");
  ok("tracking stored", env.DB._db.orders[0].tracking_id === "BD123456789");
  // A recognised courier gets a direct tracking link.
  ok("links to the courier's tracking page", (calls[0]?.html || "").includes("bluedart.com"));
}
{
  // Both optional: a parcel handed to a local courier with no tracking number is
  // still shipped, and the customer should still be told.
  const env = envDB({ orders: [ORDER] });
  const calls = stubResend();
  const [status, out] = await read(
    await updateOrder(env, ORDER.id, { status: "shipped", courier: "", tracking_id: "" }));
  ok("shipping with no tracking detail still works", status === 200);
  ok("and still emails", out.emailed === true && calls.length === 1);
  ok("no empty Tracking block in the email", !(calls[0]?.html || "").includes("Tracking</td>"));
  ok("blank courier stored as null", env.DB._db.orders[0].courier === null);
}
{
  // Re-saving an order that is ALREADY shipped — to fix a typo'd tracking
  // number — must not send a second "your order has shipped".
  const env = envDB({ orders: [{ ...ORDER, status: "shipped" }] });
  const calls = stubResend();
  const [status, out] = await read(
    await updateOrder(env, ORDER.id, { status: "shipped", tracking_id: "CORRECTED99" }));
  ok("re-saving a shipped order is allowed", status === 200);
  ok("but sends NO second email", out.emailed === false && calls.length === 0, String(calls.length));
  ok("and still updates the tracking id", env.DB._db.orders[0].tracking_id === "CORRECTED99");
}
{
  // An unrecognised courier must not produce a guessed link — a wrong tracking
  // url is worse than none, because the customer clicks it and gets an error.
  const env = envDB({ orders: [ORDER] });
  const calls = stubResend();
  await updateOrder(env, ORDER.id, { status: "shipped", courier: "Ramesh Transport", tracking_id: "XYZ1" });
  const html = calls[0]?.html || "";
  ok("unknown courier still named in the email", html.includes("Ramesh Transport"));
  // The email always has a button; with no recognised courier it must fall back
  // to the receipt on our own domain rather than a guessed courier url.
  ok("falls back to the receipt link", /href="https:\/\/3d-prints[^"]*receipt=/.test(html));
  ok("no guessed courier tracking url", !/bluedart|delhivery|dtdc|xpressbees|ecomexpress/i.test(html));
}
{
  // A failing Resend must not fail the status change: the order IS shipped, and
  // an error would suggest otherwise.
  const env = envDB({ orders: [ORDER] });
  globalThis.fetch = async () => new Response("nope", { status: 500 });
  const [status] = await read(await updateOrder(env, ORDER.id, { status: "shipped" }));
  ok("a failed email does not fail the transition", status === 200);
  ok("order is still marked shipped", env.DB._db.orders[0].status === "shipped");
}
{
  const env = envDB({ orders: [{ ...ORDER, status: "pending" }] });
  ok("pending → shipped refused (nothing was paid)",
     (await read(await updateOrder(env, ORDER.id, { status: "shipped" })))[0] === 409);
}
{
  const env = envDB({ orders: [{ ...ORDER, status: "cancelled" }] });
  ok("cancelled → shipped refused",
     (await read(await updateOrder(env, ORDER.id, { status: "shipped" })))[0] === 409);
}
{
  const env = envDB({ orders: [ORDER] });
  ok("refunded must go through the refund action",
     (await read(await updateOrder(env, ORDER.id, { status: "refunded" })))[0] === 409);
  ok("unknown status → 400",
     (await read(await updateOrder(env, ORDER.id, { status: "teleported" })))[0] === 400);
  ok("unknown order → 404",
     (await read(await updateOrder(env, "nope", { status: "shipped" })))[0] === 404);
  ok("empty patch → 400", (await read(await updateOrder(env, ORDER.id, {})))[0] === 400);
}
{
  const env = envDB({ orders: [ORDER] });
  const [status] = await read(await updateOrder(env, ORDER.id, { notes: "Left with neighbour" }));
  ok("notes can be set", status === 200);
  ok("note stored", env.DB._db.orders[0].notes === "Left with neighbour");
}

// ── refunds ───────────────────────────────────────────────────────
function stubRefund(response) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify(response.body), { status: response.status });
  };
  return calls;
}

section("admin refunds — guards");
{
  const calls = stubRefund({ status: 200, body: { id: "rfnd_1" } });
  const env = envDB({ orders: [{ ...ORDER, status: "pending" }] });
  ok("cannot refund a pending order",
     (await read(await refundOrder(env, ORDER.id, {})))[0] === 409);
  ok("no Razorpay call made", calls.length === 0);
}
{
  const calls = stubRefund({ status: 200, body: { id: "rfnd_1" } });
  const env = envDB({ orders: [{ ...ORDER, rzp_payment_id: null }] });
  ok("cannot refund without a payment id",
     (await read(await refundOrder(env, ORDER.id, {})))[0] === 409);
  ok("no Razorpay call", calls.length === 0);
}
{
  const calls = stubRefund({ status: 200, body: { id: "rfnd_1" } });
  const env = envDB({ orders: [ORDER] });
  const [status, out] = await read(await refundOrder(env, ORDER.id, { amount_paise: 999999 }));
  ok("cannot refund more than was collected", status === 400, JSON.stringify(out));
  ok("no Razorpay call", calls.length === 0);
}
{
  const calls = stubRefund({ status: 200, body: { id: "rfnd_1" } });
  const env = envDB({ orders: [ORDER] });
  ok("sub-rupee refund rejected",
     (await read(await refundOrder(env, ORDER.id, { amount_paise: 50 })))[0] === 400);
  ok("float refund rejected",
     (await read(await refundOrder(env, ORDER.id, { amount_paise: 100.5 })))[0] === 400);
  ok("still no Razorpay call", calls.length === 0);
  ok("unknown order → 404", (await read(await refundOrder(envDB(), "nope", {})))[0] === 404);
}

section("admin refunds — full");
{
  const calls = stubRefund({ status: 200, body: { id: "rfnd_full", amount: 44800 } });
  const env = envDB({ orders: [ORDER] });
  const [status, out] = await read(await refundOrder(env, ORDER.id, {}));
  ok("200", status === 200, JSON.stringify(out));
  ok("marked as full", out.partial === false);
  ok("amount is the order total", out.amount_paise === 44800);
  ok("order status → refunded", env.DB._db.orders[0].status === "refunded");
  ok("hit the refund endpoint", /\/payments\/pay_A\/refund$/.test(calls[0].url), calls[0].url);
  ok("full refund sends no amount", Object.keys(calls[0].body || {}).length === 0);
}

section("admin refunds — partial");
{
  const calls = stubRefund({ status: 200, body: { id: "rfnd_part", amount: 10000 } });
  const env = envDB({ orders: [ORDER] });
  const [, out] = await read(await refundOrder(env, ORDER.id, { amount_paise: 10000 }));
  ok("marked as partial", out.partial === true, JSON.stringify(out));
  ok("amount sent to Razorpay", calls[0].body.amount === 10000);
  // A partial refund must leave the order fulfilable.
  ok("status stays paid", env.DB._db.orders[0].status === "paid");
  ok("recorded in the notes", /Partial refund of ₹100/.test(env.DB._db.orders[0].notes),
     env.DB._db.orders[0].notes);
}

section("admin refunds — a full-value 'partial' is treated as full");
{
  stubRefund({ status: 200, body: { id: "rfnd_x" } });
  const env = envDB({ orders: [ORDER] });
  const [, out] = await read(await refundOrder(env, ORDER.id, { amount_paise: 44800 }));
  ok("not flagged partial", out.partial === false);
  ok("status → refunded", env.DB._db.orders[0].status === "refunded");
}

section("admin refunds — Razorpay refuses");
{
  stubRefund({ status: 400, body: { error: { description: "The payment has been fully refunded" } } });
  const env = envDB({ orders: [ORDER] });
  const [status, out] = await read(await refundOrder(env, ORDER.id, {}));
  ok("502 to the client", status === 502, String(status));
  ok("Razorpay's reason is surfaced to the owner", /fully refunded/i.test(out.error));
  // The critical bit: a failed refund must NOT look refunded locally.
  ok("order NOT marked refunded", env.DB._db.orders[0].status === "paid");
}
{
  const env = { ...envDB({ orders: [ORDER] }), RAZORPAY_KEY_SECRET: "" };
  ok("unconfigured Razorpay → 503", (await read(await refundOrder(env, ORDER.id, {})))[0] === 503);
}

// ── stats ─────────────────────────────────────────────────────────
section("admin stats");
{
  const env = envDB({
    orders: [
      ORDER,
      { ...ORDER, id: "o2", status: "shipped", total_paise: 100000 },
      { ...ORDER, id: "o3", status: "pending", total_paise: 50000 },
      { ...ORDER, id: "o4", status: "cancelled", total_paise: 70000 },
      // Mid-pipeline. These used to drop out of revenue the moment an order was
      // marked "in production" and reappear when it shipped.
      { ...ORDER, id: "o5", status: "in_production", total_paise: 20000 },
      { ...ORDER, id: "o6", status: "ready", total_paise: 10000 },
      { ...ORDER, id: "o7", status: "delivered", total_paise: 5000 },
      { ...ORDER, id: "o8", status: "refunded", total_paise: 90000 },
    ],
    products: [PRODUCT, { ...PRODUCT, id: "p2", visible: 0 }],
  });
  const [, s] = await read(await stats(env));
  ok("counts every stage from paid to delivered as revenue", s.revenue_paise === 179800, String(s.revenue_paise));
  ok("excludes pending, cancelled and refunded from revenue", s.revenue_paise !== 264800 && s.revenue_paise < 269800);
  ok("paid order count spans the pipeline", s.paid_orders === 5, String(s.paid_orders));
  ok("pending count", s.pending_orders === 1);
  ok("product totals", s.products_total === 2 && s.products_visible === 1);
}


// ══ BULK UPDATE ══════════════════════════════════════════════════
// Added because a pricing pass over 26 seeded placeholders meant 26 separate
// requests. The property that matters is all-or-nothing: a partial write would
// leave the owner unable to tell which prices took.
section("bulk update — happy path");
{
  const env = envDB({ products: [
    { ...PRODUCT, id: "p1", slug: "one", price_paise: 10000 },
    { ...PRODUCT, id: "p2", slug: "two", price_paise: 20000 },
    { ...PRODUCT, id: "p3", slug: "three", price_paise: 30000, visible: 0 },
  ] });
  const [status, out] = await read(await bulkUpdateProducts(env, { items: [
    { id: "p1", price_paise: 15000 },
    { id: "p2", price_paise: 25000, visible: false },
    { id: "p3", visible: true },
  ] }));
  ok("200", status === 200, JSON.stringify(out));
  ok("reports the count", out.updated === 3, String(out.updated));

  const byId = Object.fromEntries(env.DB._db.products.map((p) => [p.id, p]));
  ok("first price applied", byId.p1.price_paise === 15000);
  ok("second price applied", byId.p2.price_paise === 25000);
  ok("visibility applied", byId.p2.visible === 0);
  ok("price-only row keeps its visibility", byId.p1.visible === 1);
  ok("visibility-only row keeps its price", byId.p3.price_paise === 30000);
  ok("visibility-only row became visible", byId.p3.visible === 1);
  ok("updated_at bumped", byId.p1.updated_at !== 1);
}

section("bulk update — ALL-OR-NOTHING on a bad row");
{
  for (const [label, badPrice] of [
    ["float", 149.5],
    ["negative", -100],
    ["NaN", "abc"],
    ["empty string", ""],
    ["null", null],
  ]) {
    const env = envDB({ products: [
      { ...PRODUCT, id: "p1", slug: "one", price_paise: 10000 },
      { ...PRODUCT, id: "p2", slug: "two", price_paise: 20000 },
    ] });
    const [status] = await read(await bulkUpdateProducts(env, { items: [
      { id: "p1", price_paise: 15000 },     // valid
      { id: "p2", price_paise: badPrice },  // not
    ] }));
    ok(`${label} rejects the batch`, status === 400);
    // The critical assertion: the VALID row must not have been written either.
    ok(`${label} leaves the valid row untouched`,
       env.DB._db.products.find((p) => p.id === "p1").price_paise === 10000,
       String(env.DB._db.products.find((p) => p.id === "p1").price_paise));
  }
}

section("bulk update — unknown ids reject the batch");
{
  const env = envDB({ products: [{ ...PRODUCT, id: "p1", slug: "one", price_paise: 10000 }] });
  const [status, out] = await read(await bulkUpdateProducts(env, { items: [
    { id: "p1", price_paise: 15000 },
    { id: "does-not-exist", price_paise: 20000 },
  ] }));
  ok("409", status === 409, String(status));
  ok("says to reload", /reload/i.test(out.error), out.error);
  // A typo'd id must not silently update nothing while reporting success.
  ok("valid row untouched", env.DB._db.products[0].price_paise === 10000);
}

section("bulk update — malformed requests");
{
  const mk = () => envDB({ products: [{ ...PRODUCT, id: "p1", slug: "one" }] });
  for (const [label, body] of [
    ["no items", {}],
    ["empty array", { items: [] }],
    ["items not an array", { items: { id: "p1" } }],
    ["null items", { items: null }],
    ["item without an id", { items: [{ price_paise: 100 }] }],
    ["item with an empty id", { items: [{ id: "", price_paise: 100 }] }],
    ["item with nothing to change", { items: [{ id: "p1" }] }],
  ]) {
    ok(`${label} → 400`, (await read(await bulkUpdateProducts(mk(), body)))[0] === 400);
  }
  // The same product twice would make the outcome depend on statement order.
  const [dupStatus, dupOut] = await read(await bulkUpdateProducts(mk(), { items: [
    { id: "p1", price_paise: 100 },
    { id: "p1", price_paise: 200 },
  ] }));
  ok("duplicate id → 400", dupStatus === 400);
  ok("explains why", /twice/i.test(dupOut.error), dupOut.error);

  const many = Array.from({ length: 250 }, (_, i) => ({ id: `p${i}`, price_paise: 100 }));
  ok("more than 200 items → 400", (await read(await bulkUpdateProducts(mk(), { items: many })))[0] === 400);
}

section("bulk update — zero is a legitimate price");
{
  const env = envDB({ products: [{ ...PRODUCT, id: "p1", slug: "one", price_paise: 10000 }] });
  const [status] = await read(await bulkUpdateProducts(env, { items: [{ id: "p1", price_paise: 0 }] }));
  ok("accepted", status === 200);
  ok("applied", env.DB._db.products[0].price_paise === 0);
}

// ── descriptions in bulk ────────────────────────────────────────────
// The dashboard edits price, visibility and description in one pass and saves them
// through this one endpoint, so a description must ride the same all-or-nothing
// transaction as the prices beside it. The failure this guards against is an edit
// that appears saved because the batch reported success while that field was
// quietly dropped.
section("bulk update — descriptions");
{
  const env = envDB({ products: [
    { ...PRODUCT, id: "p1", slug: "one", price_paise: 10000, description: "old copy" },
    { ...PRODUCT, id: "p2", slug: "two", price_paise: 20000, description: "" },
  ] });
  const [status, out] = await read(await bulkUpdateProducts(env, { items: [
    { id: "p1", price_paise: 15000, description: "New copy, written in the dashboard." },
    { id: "p2", description: "Filling in a blank one." },
  ] }));
  ok("200", status === 200, JSON.stringify(out));
  const byId = Object.fromEntries(env.DB._db.products.map((p) => [p.id, p]));
  ok("description written alongside a price", byId.p1.description === "New copy, written in the dashboard.",
     byId.p1.description);
  ok("the price in the same row still applied", byId.p1.price_paise === 15000);
  ok("a blank description can be filled", byId.p2.description === "Filling in a blank one.");
  ok("description-only row keeps its price", byId.p2.price_paise === 20000);
  ok("description-only row keeps its visibility", byId.p2.visible === 1);
}

section("bulk update — a description can be cleared, and is trimmed and clipped");
{
  const env = envDB({ products: [
    { ...PRODUCT, id: "p1", slug: "one", description: "something" },
    { ...PRODUCT, id: "p2", slug: "two", description: "something" },
    { ...PRODUCT, id: "p3", slug: "three", description: "something" },
  ] });
  const [status] = await read(await bulkUpdateProducts(env, { items: [
    { id: "p1", description: "" },
    { id: "p2", description: "   padded   " },
    { id: "p3", description: "x".repeat(5000) },
  ] }));
  ok("accepted", status === 200);
  const byId = Object.fromEntries(env.DB._db.products.map((p) => [p.id, p]));
  // Emptying is a legitimate edit: it is how you undo a description you dislike.
  ok("an empty string clears it", byId.p1.description === "");
  ok("whitespace is trimmed", byId.p2.description === "padded");
  // Clipped rather than rejected, so one over-long box cannot discard every other
  // edit in the batch.
  ok("over-long is clipped to 2000, not rejected", byId.p3.description.length === 2000,
     String(byId.p3.description.length));
}

section("bulk update — a bad price still rejects a batch carrying descriptions");
{
  const env = envDB({ products: [
    { ...PRODUCT, id: "p1", slug: "one", price_paise: 10000, description: "before" },
    { ...PRODUCT, id: "p2", slug: "two", price_paise: 20000, description: "before" },
  ] });
  const [status] = await read(await bulkUpdateProducts(env, { items: [
    { id: "p1", description: "a perfectly good description" },
    { id: "p2", price_paise: 12.5 },
  ] }));
  ok("400", status === 400);
  // The point of all-or-nothing: the good description must not have landed either.
  ok("the valid description was not written",
     env.DB._db.products.find((p) => p.id === "p1").description === "before");
}


// ── personalisation columns from the dashboard ────────────────────
section("bulk update — the personalisation prompt");
{
  const env = envDB({ products: [
    { ...PRODUCT, id: "p1", slug: "one" },
    { ...PRODUCT, id: "p2", slug: "two", personalise_label: "Name", personalise_required: 1 },
  ] });
  const [status] = await read(await bulkUpdateProducts(env, { items: [
    { id: "p1", personalise_label: "Name or text to print", personalise_required: true },
    // An EMPTY label is the off switch - it is how a product stops asking - so it
    // has to be settable back to empty, not merely to some other string.
    { id: "p2", personalise_label: "", personalise_required: false },
  ] }));
  ok("accepted", status === 200);
  const byId = Object.fromEntries(env.DB._db.products.map((p) => [p.id, p]));
  ok("prompt set", byId.p1.personalise_label === "Name or text to print");
  ok("required stored as 1", byId.p1.personalise_required === 1, String(byId.p1.personalise_required));
  ok("prompt cleared", byId.p2.personalise_label === "");
  ok("required stored as 0", byId.p2.personalise_required === 0, String(byId.p2.personalise_required));

  const long = envDB({ products: [{ ...PRODUCT, id: "p1", slug: "one" }] });
  await bulkUpdateProducts(long, { items: [{ id: "p1", personalise_label: "x".repeat(300) }] });
  ok("an over-long prompt is clipped to 80",
     long.DB._db.products[0].personalise_label.length === 80,
     String(long.DB._db.products[0].personalise_label.length));
}

section("single update — the personalisation prompt");
{
  const env = envDB({ products: [{ ...PRODUCT, id: "p1", slug: "one" }] });
  const [status, out] = await read(await updateProduct(env, "p1", {
    personalise_label: "Colour", personalise_required: false,
  }));
  ok("200", status === 200, JSON.stringify(out));
  ok("prompt set", env.DB._db.products[0].personalise_label === "Colour");
  // PATCH touches only what was sent - the price beside it must not move.
  ok("price untouched", env.DB._db.products[0].price_paise === PRODUCT.price_paise);
}

// ── describeProducts: fill a MISSING description ────────────────────
//
// The route the listing agent uses on rows it did not create, so the assertions that
// matter are the ones about NOT overwriting. Aswin's whole stated concern was an agent
// that "might change any existing thing".
{
  console.log("\ndescribeProducts — fills blanks, never overwrites");
  const seed = () => ({ products: [
    { id: "p1", slug: "blank-one", name: "Blank One", description: "",
      price_paise: 44900, image: "assets/images/a.jpg", images: "", category: "figurine",
      visible: 1, sort: 1, created_at: 1, updated_at: 1 },
    { id: "p2", slug: "already-done", name: "Already Done",
      description: "Existing copy that Aswin wrote himself and must survive.",
      price_paise: 59900, image: "assets/images/b.jpg", images: "", category: "decor",
      visible: 1, sort: 2, created_at: 1, updated_at: 1 },
    { id: "p3", slug: "whitespace-only", name: "Whitespace", description: "   ",
      price_paise: 19900, image: "assets/images/c.jpg", images: "", category: "set",
      visible: 1, sort: 3, created_at: 1, updated_at: 1 },
  ] });
  const LONG = "A properly written description that clears the sixty character floor easily.";

  {
    const env = envDB(seed());
    const [status, body] = await read(await describeProducts(env,
      { items: [{ slug: "blank-one", description: LONG }] }, "agent"));
    ok("fills an empty description", status === 200 && body.described === 1);
    ok("the text landed", env.DB._db.products[0].description === LONG);
    ok("price untouched", env.DB._db.products[0].price_paise === 44900);
    ok("name untouched", env.DB._db.products[0].name === "Blank One");
    ok("visible untouched", env.DB._db.products[0].visible === 1);
  }

  // THE assertion. If this ever fails, the agent can rewrite Aswin's copy.
  {
    const env = envDB(seed());
    const before = env.DB._db.products[1].description;
    const [status] = await read(await describeProducts(env,
      { items: [{ slug: "already-done", description: LONG }] }, "agent"));
    ok("refuses a row that already has a description (409)", status === 409);
    ok("the existing copy is untouched", env.DB._db.products[1].description === before);
  }

  // Whitespace is blank. TRIM in the SQL and .trim() in the check must agree, or a
  // row of spaces is unfillable through the API and unreachable except by migration.
  {
    const env = envDB(seed());
    const [status] = await read(await describeProducts(env,
      { items: [{ slug: "whitespace-only", description: LONG }] }, "agent"));
    ok("a whitespace-only description counts as empty", status === 200);
    ok("and gets filled", env.DB._db.products[2].description === LONG);
  }

  // Category may be corrected while filling, because a row with no description is
  // unfinished — but only to a real category, and only on such a row.
  {
    const env = envDB(seed());
    await read(await describeProducts(env,
      { items: [{ slug: "blank-one", description: LONG, category: "functional" }] }, "agent"));
    ok("category can be set while filling", env.DB._db.products[0].category === "functional");
  }
  {
    const env = envDB(seed());
    const [status] = await read(await describeProducts(env,
      { items: [{ slug: "blank-one", description: LONG, category: "gadgets" }] }, "agent"));
    ok("an invented category is refused", status === 400);
    ok("nothing was written", env.DB._db.products[0].description === "");
  }
  {
    const env = envDB(seed());
    await read(await describeProducts(env,
      { items: [{ slug: "blank-one", description: LONG }] }, "agent"));
    ok("omitting category leaves it alone", env.DB._db.products[0].category === "figurine");
  }

  {
    const env = envDB(seed());
    const [status] = await read(await describeProducts(env,
      { items: [{ slug: "no-such-product", description: LONG }] }, "agent"));
    ok("an unknown slug is 404", status === 404);
  }
  {
    const env = envDB(seed());
    const [status] = await read(await describeProducts(env,
      { items: [{ slug: "blank-one", description: "too short" }] }, "agent"));
    ok("a thin description is refused for the agent", status === 400);
    ok("and nothing was written", env.DB._db.products[0].description === "");
  }
  // All-or-nothing: one bad row must not let the good one through.
  {
    const env = envDB(seed());
    const [status] = await read(await describeProducts(env, { items: [
      { slug: "blank-one", description: LONG },
      { slug: "already-done", description: LONG },
    ] }, "agent"));
    ok("one refused row rejects the batch", status === 409);
    ok("the good row was NOT written", env.DB._db.products[0].description === "");
  }
  {
    const env = envDB(seed());
    const [status] = await read(await describeProducts(env, { items: [
      { slug: "blank-one", description: LONG },
      { slug: "blank-one", description: LONG },
    ] }, "agent"));
    ok("the same slug twice is refused", status === 400);
  }
  // The owner is not held to the agent's quality floor — a short note from the
  // dashboard is Aswin's business. The overwrite guard still applies to everyone,
  // because it is in the SQL.
  {
    const env = envDB(seed());
    const [status] = await read(await describeProducts(env,
      { items: [{ slug: "blank-one", description: "short" }] }, "owner"));
    ok("the owner may write a short description", status === 200);
  }
  {
    const env = envDB(seed());
    const [status] = await read(await describeProducts(env,
      { items: [{ slug: "already-done", description: LONG }] }, "owner"));
    ok("even the owner cannot overwrite through THIS route", status === 409);
  }
}


// The SQL guard, exercised rather than merely asserted.
{
  console.log("\ndescribeProducts — the WHERE clause catches what the check cannot");
  const env = envDB({ products: [
    { id: "p2", slug: "already-done", name: "Already Done",
      description: "Copy Aswin wrote himself.", price_paise: 59900,
      image: "assets/images/b.jpg", images: "", category: "decor",
      visible: 1, sort: 1, created_at: 1, updated_at: 1 },
  ] });
  // Validate pass sees an empty description and waves it through; the row actually
  // has one. Only the UPDATE's WHERE clause stands between that and an overwrite.
  env.DB._db._raceDescriptions = true;
  const [status, body] = await read(await describeProducts(env,
    { items: [{ slug: "already-done", description: "x".repeat(80) }] }, "agent"));
  ok("the request is accepted (the check was fooled)", status === 200);
  ok("but the DATABASE refused the write", body.described === 0);
  ok("the existing copy survived",
     env.DB._db.products[0].description === "Copy Aswin wrote himself.");
  ok("and the response says so rather than claiming success",
     typeof body.note === "string" && body.requested === 1);
}


// ── the notification the agent's listings trigger ──────────────────
//
// Shipped broken. It read r.price_paise; planRowsFor() names that field `price`, so
// the arithmetic was undefined/100 and a real ₹1,999 listing was announced as
// "Marvel Wall Art — ₹NaN". The row written to the database was perfectly correct —
// only the mail reporting it was wrong, which is the nastiest shape for this kind of
// bug, because the thing telling you the state is the broken part.
//
// Nothing caught it because the mail was built inline inside a waitUntil callback
// and had no seam to test. It is a pure exported function now for exactly this.
{
  console.log("\nagentListingEmail — the price must survive into the mail");
  // Rows shaped as planRowsFor actually returns them: `price`, not `price_paise`.
  const rows = [
    { id: "a", slug: "marvel-wall-art", name: "Marvel Wall Art", price: 199900 },
    { id: "b", slug: "cheap-thing", name: "Cheap <Thing> & Co", price: 4900 },
  ];
  const e = agentListingEmail(rows, "https://shop.test");

  ok("no NaN anywhere in the text", !/NaN/.test(e.text), e.text);
  ok("no NaN anywhere in the html", !/NaN/.test(e.html), e.html);
  ok("the rupee amount is right", e.text.includes("₹1999"), e.text);
  ok("and for the second row too", e.text.includes("₹49"), e.text);
  ok("html carries the amount as well", e.html.includes("₹1999"), e.html);
  ok("subject counts the rows", e.subject.startsWith("2 new products"), e.subject);
  ok("singular subject for one row",
     agentListingEmail([rows[0]], "https://x").subject.startsWith("1 new product listed"));
  ok("links to the product page", e.text.includes("https://shop.test/p/marvel-wall-art"));
  ok("names are html-escaped in the html body",
     e.html.includes("Cheap &lt;Thing&gt; &amp; Co"), e.html);

  // Reading the WRONG field is the mistake that happened. If someone reintroduces
  // it, the price is missing rather than NaN, and it says so in words.
  const wrongShape = [{ slug: "x", name: "X", price_paise: 199900 }];
  const w = agentListingEmail(wrongShape, "https://x");
  ok("a row with no `price` says so instead of rendering NaN",
     w.text.includes("price missing") && !/NaN/.test(w.text), w.text);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
