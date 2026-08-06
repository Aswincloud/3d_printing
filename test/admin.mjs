// Offline tests for the admin surface: the auth gate first, then the handlers.
//
// The gate matters more than anything else here. /api/admin/orders returns
// customer names, addresses, phone numbers and Razorpay payment ids, and
// /refund moves real money — so "unauthenticated request is refused" is not a
// nice-to-have, it's the feature.

import { ownerAllowed, ssoConfigured, currentOwner } from "../src/auth.js";
import {
  listProducts, createProduct, updateProduct, deleteProduct, unlistedImages,
  listOrders, updateOrder, refundOrder, stats, bulkUpdateProducts,
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

    if (s.startsWith("SELECT id, slug, name, description, price_paise, image, images, category, visible, sort, created_at, updated_at FROM products")) {
      return { results: [...db.products].sort((x, y) => x.sort - y.sort) };
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
      db.products.push({ id, slug, name, description, price_paise, image, images, category, visible, sort, created_at, updated_at });
      return { meta: { changes: 1 } };
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
    if (s.startsWith("SELECT order_id, name, price_paise, qty, pos FROM order_items")) {
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
    if (s.startsWith("SELECT id, receipt, status, notes, shipped_at, courier, tracking_id FROM orders WHERE id = ?")) {
      const o = db.orders.find((x) => x.id === a[0]);
      return { first: o ? project(o, ["id", "receipt", "status", "notes", "shipped_at", "courier", "tracking_id"]) : null };
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
      const rows = db.orders.filter((o) => ["paid", "shipped"].includes(o.status));
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
      return {
        bind(...args) { this._a = args; return this; },
        async all() { return { results: run(sql, this._a || []).results || [] }; },
        async first() { return run(sql, this._a || []).first ?? null; },
        async run() { return run(sql, this._a || []); },
      };
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
    ],
    products: [PRODUCT, { ...PRODUCT, id: "p2", visible: 0 }],
  });
  const [, s] = await read(await stats(env));
  ok("counts paid + shipped as revenue", s.revenue_paise === 144800, String(s.revenue_paise));
  ok("excludes pending and cancelled from revenue", s.revenue_paise !== 264800);
  ok("paid order count", s.paid_orders === 2);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
