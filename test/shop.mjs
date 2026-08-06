// Offline tests for the pricing engine. No wrangler, no D1 — env.DB is faked
// just far enough to satisfy prepare().bind().all().
//
// These are the tests that matter most in the whole project: priceCart() is the
// only thing between a tampered cart and a wrong charge.

import { priceCart, shippingFor, shippingConfig, MAX_QTY, listProducts } from "../src/shop.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);

const ENV = { FLAT_SHIP_PAISE: "9900", FREE_SHIP_THRESHOLD_PAISE: "200000" };

// Fake catalogue: two visible products, one hidden, one visible-but-unpriced.
//
// p-quote is the interesting one. A price of 0 means "in the shop but not priced
// yet" — every pushed photo is auto-listed that way. It is visible = 1, so
// without the price guard in priceCart it would be perfectly buyable for free.
const CATALOGUE = [
  { id: "p-small", name: "Kingfisher",  price_paise: 34900, visible: 1 },
  { id: "p-large", name: "Elephant",    price_paise: 89900, visible: 1 },
  { id: "p-hidden", name: "Spider-Man", price_paise: 54900, visible: 0 },
  { id: "p-quote", name: "Unpriced Photo", price_paise: 0,  visible: 1 },
];

// Minimal D1 stand-in. Records every query so tests can assert on what was
// asked, and only ever returns rows from CATALOGUE — never from test input.
function fakeDB(rows = CATALOGUE) {
  const queries = [];
  return {
    queries,
    prepare(sql) {
      const q = { sql, args: [] };
      queries.push(q);
      return {
        bind(...args) { q.args = args; return this; },
        async all() {
          // Mirror the real WHERE, INCLUDING the price guard.
          //
          // Read off the SQL rather than hardcoded, so removing `price_paise > 0`
          // from the query changes what this fake returns and the zero-price
          // tests fail. A fake that always filtered would make those tests pass
          // no matter what the real query said — which is the failure mode this
          // whole file exists to avoid.
          const guarded = /price_paise\s*>\s*0/.test(sql);
          const wanted = new Set(q.args);
          return {
            results: rows.filter((r) =>
              r.visible === 1 && wanted.has(r.id) && (!guarded || r.price_paise > 0)),
          };
        },
      };
    },
  };
}
const envWith = (rows) => ({ ...ENV, DB: fakeDB(rows) });

// ── shipping config ───────────────────────────────────────────────
section("shippingConfig()");
{
  const c = shippingConfig(ENV);
  ok("parses flat rate", c.flat_paise === 9900, String(c.flat_paise));
  ok("parses threshold", c.free_threshold_paise === 200000, String(c.free_threshold_paise));

  // Vars are strings from wrangler.toml; a missing or junk one must not make
  // shipping NaN (which would produce a NaN total sent to Razorpay).
  const d = shippingConfig({});
  // The fallback must equal the wrangler.toml value, else a deploy where the var
// did not arrive would quietly ship free from ₹1,500 again.
ok("missing vars fall back", d.flat_paise === 9900 && d.free_threshold_paise === 200000);
  const e = shippingConfig({ FLAT_SHIP_PAISE: "abc", FREE_SHIP_THRESHOLD_PAISE: "-5" });
  ok("junk vars fall back", e.flat_paise === 9900 && e.free_threshold_paise === 200000);
  const z = shippingConfig({ FLAT_SHIP_PAISE: "0" });
  ok("explicit 0 flat rate is honoured, not treated as missing", z.flat_paise === 0);
}

// ── shipping edges ────────────────────────────────────────────────
section("shippingFor() — threshold edges");
ok("one paise under threshold → flat", shippingFor(199999, "ship", ENV) === 9900);
ok("exactly at threshold → free", shippingFor(200000, "ship", ENV) === 0);
ok("one paise over → free", shippingFor(200001, "ship", ENV) === 0);
ok("well under → flat", shippingFor(34900, "ship", ENV) === 9900);
// Pickup was withdrawn, and with it the `if (delivery === "pickup") return 0`
// branch — a free-shipping path any client able to set that field could reach.
// The parameter is still accepted, so assert it changes NOTHING: this is the test
// that would fail if someone reintroduced the branch.
for (const mode of ["pickup", "PICKUP", "Pickup", "", null, undefined, "collect"]) {
  ok(`delivery=${JSON.stringify(mode)} still charged`, shippingFor(34900, mode, ENV) === 9900);
}
ok("threshold still applies whatever delivery says", shippingFor(500000, "pickup", ENV) === 0);
// The old threshold must NOT still grant free shipping.
ok("₹1,500 no longer ships free", shippingFor(150000, "ship", ENV) === 9900);
ok("₹1,999 still charged", shippingFor(199900, "ship", ENV) === 9900);

// ── happy path ────────────────────────────────────────────────────
section("priceCart() — amounts");
{
  const r = await priceCart(envWith(), [{ product_id: "p-small", qty: 2 }], "ship");
  ok("subtotal = 2 × 34900", r.subtotal_paise === 69800, String(r.subtotal_paise));
  ok("shipping flat", r.shipping_paise === 9900);
  ok("total = subtotal + shipping", r.total_paise === 79700, String(r.total_paise));
  ok("one line item", r.items.length === 1);
  ok("name snapshotted from DB", r.items[0].name === "Kingfisher");
  ok("price snapshotted from DB", r.items[0].price_paise === 34900);
  ok("pos assigned", r.items[0].pos === 0);
  ok("no error", !r.error);
}
{
  // 179800 USED to clear the ₹1,500 threshold and ship free. With the threshold at
  // ₹2,000 it no longer does, so this block now asserts the charged case and a
  // separate one below covers actually crossing the line.
  const r = await priceCart(envWith(), [{ product_id: "p-large", qty: 2 }], "ship");
  ok("2 × 89900 = 179800 subtotal", r.subtotal_paise === 179800, String(r.subtotal_paise));
  ok("just under the new threshold → charged", r.shipping_paise === 9900, String(r.shipping_paise));
  ok("total includes shipping", r.total_paise === 189700, String(r.total_paise));
}
{
  // Three large items (269700) clear ₹2,000, so shipping is free.
  const r = await priceCart(envWith(), [{ product_id: "p-large", qty: 3 }], "ship");
  ok("3 × 89900 = 269700 subtotal", r.subtotal_paise === 269700, String(r.subtotal_paise));
  ok("crosses threshold → free shipping", r.shipping_paise === 0);
  ok("total equals subtotal when shipping free", r.total_paise === 269700);
}
{
  const r = await priceCart(envWith(), [
    { product_id: "p-small", qty: 1 },
    { product_id: "p-large", qty: 1 },
  ], "pickup");
  ok("mixed cart subtotal", r.subtotal_paise === 124800, String(r.subtotal_paise));
  // 124800 is under the 200000 free-shipping threshold, so shipping is charged
  // even though the caller passed "pickup" — that is the point of removing the
  // pickup branch from shippingFor(). This assertion previously expected 0.
  ok("a pickup claim does not waive shipping", r.shipping_paise === 9900, String(r.shipping_paise));
  ok("two line items", r.items.length === 2);
  ok("client order preserved", r.items[0].product_id === "p-small" && r.items[1].product_id === "p-large");
  ok("pos increments", r.items[1].pos === 1);
}

// ── PRICE TAMPERING ───────────────────────────────────────────────
// Plan invariant 1. The client sends a price; the server must ignore it.
section("priceCart() — price tampering (invariant 1)");
{
  const r = await priceCart(envWith(), [
    { product_id: "p-large", qty: 1, price_paise: 1, price: 1, amount: 1, total: 1 },
  ], "ship");
  ok("injected price_paise ignored", r.items[0].price_paise === 89900, String(r.items[0].price_paise));
  ok("subtotal from DB, not payload", r.subtotal_paise === 89900, String(r.subtotal_paise));
  ok("total from DB, not payload", r.total_paise === 99800, String(r.total_paise));
}
{
  // Injecting a name would let a buyer change what appears on the invoice.
  const r = await priceCart(envWith(), [
    { product_id: "p-small", qty: 1, name: "Free Sample" },
  ], "ship");
  ok("injected name ignored", r.items[0].name === "Kingfisher", r.items[0].name);
}
{
  // Injecting shipping directly.
  const r = await priceCart(envWith(), [{ product_id: "p-small", qty: 1 }], "ship");
  const r2 = await priceCart({ ...envWith(), FLAT_SHIP_PAISE: "9900" },
    [{ product_id: "p-small", qty: 1, shipping_paise: 0 }], "ship");
  ok("injected shipping_paise ignored", r2.shipping_paise === r.shipping_paise && r2.shipping_paise === 9900);
}

// ── hidden and unknown products ───────────────────────────────────
section("priceCart() — unavailable products");
{
  const r = await priceCart(envWith(), [{ product_id: "p-hidden", qty: 1 }], "ship");
  ok("hidden product rejected", !!r.error, JSON.stringify(r));
  ok("hidden product yields no amounts", r.total_paise === undefined);
}
{
  const r = await priceCart(envWith(), [{ product_id: "does-not-exist", qty: 1 }], "ship");
  ok("unknown id rejected", !!r.error);
}
{
  // The dangerous variant: one good item and one bad. Silently dropping the
  // bad one would charge for a different basket than the customer saw.
  const r = await priceCart(envWith(), [
    { product_id: "p-small", qty: 1 },
    { product_id: "p-hidden", qty: 1 },
  ], "ship");
  ok("partial cart rejected, not silently trimmed", !!r.error);
  ok("no items returned on partial failure", r.items === undefined);
}

// ══ AN UNPRICED PRODUCT CANNOT BE BOUGHT ═════════════════════════
//
// Every photo pushed to the repo is auto-listed as a "Price on request" card, so
// the catalogue now contains VISIBLE products with price_paise = 0. Those are
// exactly one missing WHERE clause away from being free.
//
// Hiding the Add-to-cart button is not the control — a stale tab, a scripted
// POST, or a hand-edited localStorage all bypass the UI entirely. The control is
// `AND price_paise > 0` in priceCart, and this is what proves it is there.
section("priceCart() — a quote-only product is unbuyable (invariant)");
{
  const r = await priceCart(envWith(), [{ product_id: "p-quote", qty: 1 }], "ship");
  ok("unpriced product rejected", !!r.error, JSON.stringify(r));
  ok("no total is produced", r.total_paise === undefined);
  // Same message as a hidden item: the customer does not need to know why, and
  // a distinct message would leak which ids exist but are unpriced.
  ok("refused the same way as an unavailable item", /no longer available/i.test(r.error || ""),
     r.error);
}
{
  // The dangerous variant, again: a real product plus an unpriced one. If only
  // the unpriced item were dropped, the customer would be charged for a basket
  // they did not assemble — and if it were kept at 0, they would get it free.
  const r = await priceCart(envWith(), [
    { product_id: "p-small", qty: 1 },
    { product_id: "p-quote", qty: 2 },
  ], "ship");
  ok("mixed cart rejected entirely", !!r.error);
  ok("the real item is not charged for alone", r.total_paise === undefined);
  ok("no line items leak", r.items === undefined);
}
{
  // A cart of nothing but unpriced items must not become a ₹0 order, or an order
  // for the shipping alone — which is the shape a naive fix produces.
  const r = await priceCart(envWith(), [
    { product_id: "p-quote", qty: 1 },
    { product_id: "p-quote", qty: 3 },
  ], "ship");
  ok("an all-unpriced cart is refused", !!r.error);
  ok("never a shipping-only charge", r.total_paise === undefined,
     "an order for ₹99 shipping and no goods would still be a real charge");
}
{
  // A coupon must not be able to launder an unpriced item into a cart: the
  // product lookup happens before any discount is applied, so this should fail
  // for the same reason, not with a coupon error.
  const r = await priceCart(envWith(), [{ product_id: "p-quote", qty: 1 }], "ship", "SAVE10");
  ok("a coupon does not make it buyable", !!r.error);
  ok("and it fails on availability, not on the coupon",
     /no longer available/i.test(r.error || ""), r.error);
}
{
  // 1 paise is a real price. The guard must be `> 0`, not a truthiness check on
  // something that could treat a small value as absent.
  const rows = [{ id: "p-cheap", name: "One Paisa", price_paise: 1, visible: 1 }];
  const r = await priceCart(envWith(rows), [{ product_id: "p-cheap", qty: 1 }], "ship");
  ok("a 1-paise product is still buyable", !r.error, r.error || "");
  ok("and priced exactly", r.subtotal_paise === 1, String(r.subtotal_paise));
}

// ── malformed input ───────────────────────────────────────────────
section("priceCart() — malformed input");
for (const [label, items] of [
  ["empty array", []],
  ["null", null],
  ["undefined", undefined],
  ["object not array", { product_id: "p-small", qty: 1 }],
  ["string", "p-small"],
]) {
  const r = await priceCart(envWith(), items, "ship");
  ok(`${label} rejected`, !!r.error);
}

for (const [label, qty] of [
  ["zero qty", 0],
  ["negative qty", -5],
  ["NaN qty", "abc"],
  ["missing qty", undefined],
  ["null qty", null],
  ["Infinity qty", Infinity],
]) {
  const r = await priceCart(envWith(), [{ product_id: "p-small", qty }], "ship");
  ok(`${label} rejected`, !!r.error, JSON.stringify(r));
}

// A fractional qty must not produce a fractional charge.
{
  const r = await priceCart(envWith(), [{ product_id: "p-small", qty: 2.7 }], "ship");
  ok("fractional qty truncated to integer", r.items?.[0].qty === 2, JSON.stringify(r.items));
  ok("fractional qty gives integer subtotal", Number.isInteger(r.subtotal_paise));
}

for (const [label, id] of [
  ["missing product_id", undefined],
  ["empty product_id", ""],
  ["whitespace product_id", "   "],
  ["null product_id", null],
]) {
  const r = await priceCart(envWith(), [{ product_id: id, qty: 1 }], "ship");
  ok(`${label} rejected`, !!r.error);
}

// ── quantity caps ─────────────────────────────────────────────────
section("priceCart() — quantity caps");
{
  const r = await priceCart(envWith(), [{ product_id: "p-small", qty: MAX_QTY }], "ship");
  ok(`qty ${MAX_QTY} allowed`, !r.error, JSON.stringify(r.error));
  const r2 = await priceCart(envWith(), [{ product_id: "p-small", qty: MAX_QTY + 1 }], "ship");
  ok(`qty ${MAX_QTY + 1} rejected`, !!r2.error);
}
{
  // Duplicate lines are collapsed, so splitting a huge order across lines must
  // not bypass the cap.
  const r = await priceCart(envWith(), [
    { product_id: "p-small", qty: 60 },
    { product_id: "p-small", qty: 60 },
  ], "ship");
  ok("split lines can't bypass the qty cap", !!r.error, JSON.stringify(r));
}
{
  const r = await priceCart(envWith(), [
    { product_id: "p-small", qty: 2 },
    { product_id: "p-small", qty: 3 },
  ], "ship");
  ok("duplicate ids collapse to one line", r.items?.length === 1, JSON.stringify(r.items));
  ok("collapsed qty summed", r.items?.[0].qty === 5);
  ok("collapsed subtotal correct", r.subtotal_paise === 5 * 34900, String(r.subtotal_paise));
}
{
  const many = Array.from({ length: 51 }, (_, i) => ({ product_id: `p-${i}`, qty: 1 }));
  const r = await priceCart(envWith(), many, "ship");
  ok("more than 50 distinct lines rejected", !!r.error);
}

// ── the DB query itself ───────────────────────────────────────────
section("priceCart() — query shape");
{
  const env = envWith();
  await priceCart(env, [{ product_id: "p-small", qty: 1 }], "ship");
  const q = env.DB.queries[0];
  ok("filters on visible = 1 in SQL", /visible\s*=\s*1/.test(q.sql), q.sql);
  ok("ids are bound, not interpolated", q.args.includes("p-small") && !q.sql.includes("p-small"));
  ok("one placeholder per id", (q.sql.match(/\?/g) || []).length === 1);
  ok("selects price from DB", /price_paise/.test(q.sql));
}
{
  // A quoted id must be a bound parameter, never concatenated into SQL.
  const env = envWith();
  const evil = "' OR 1=1 --";
  const r = await priceCart(env, [{ product_id: evil, qty: 1 }], "ship");
  ok("sql-ish id is rejected as unknown", !!r.error);
  ok("sql-ish id never reaches the query text", !env.DB.queries[0].sql.includes("OR 1=1"));
  ok("sql-ish id is passed as a bound arg", env.DB.queries[0].args.includes(evil));
}
{
  // No Razorpay call and no DB read should happen for an empty cart.
  const env = envWith();
  await priceCart(env, [], "ship");
  ok("empty cart makes no DB query", env.DB.queries.length === 0);
}

// ── integer discipline ────────────────────────────────────────────
// Razorpay rejects a non-integer amount. Everything must stay in paise.
section("integer amounts");
{
  const r = await priceCart(envWith(), [
    { product_id: "p-small", qty: 3 },
    { product_id: "p-large", qty: 1 },
  ], "ship");
  for (const k of ["subtotal_paise", "shipping_paise", "total_paise"]) {
    ok(`${k} is an integer`, Number.isInteger(r[k]), String(r[k]));
  }
  ok("no floating point in line totals",
     r.items.every((i) => Number.isInteger(i.price_paise * i.qty)));
}

// ── the public catalogue ──────────────────────────────────────────
//
// listProducts() decides what a customer sees, and it now synthesises cards for
// photos that have no product row at all. Nothing tested it before this change.
section("listProducts() — what reaches the shop");

// A D1 that answers both the visible-products query and the hidden-images one,
// plus an ASSETS binding serving a manifest. Throws on anything else, so a new
// query has to be added here deliberately.
function catalogueEnv({ products = [], manifest = null } = {}) {
  return {
    ...ENV,
    ASSETS: manifest === null ? undefined : {
      fetch: async () => new Response(JSON.stringify({
        count: manifest.length,
        images: manifest.map((f) => ({ file: f, bytes: 1000 })),
      }), { status: 200 }),
    },
    DB: {
      prepare(sql) {
        const s = sql.replace(/\s+/g, " ").trim();
        return {
          bind() { return this; },
          async all() {
            if (s.includes("WHERE visible = 1 ORDER BY")) {
              return { results: products.filter((p) => p.visible === 1) };
            }
            if (s.includes("WHERE visible = 0")) {
              return { results: products.filter((p) => p.visible === 0) };
            }
            throw new Error("unhandled SQL in catalogue fake: " + s.slice(0, 70));
          },
        };
      },
    },
  };
}

const row = (o) => ({
  id: o.id, slug: o.slug || o.id, name: o.name || o.id, description: "",
  price_paise: o.price_paise ?? 34900, image: `assets/images/${o.image}`,
  images: o.images || "", category: "figurine", sort: o.sort ?? 10,
  visible: o.visible ?? 1,
});

{
  const env = catalogueEnv({
    products: [
      row({ id: "a", image: "a.jpg", price_paise: 34900 }),
      row({ id: "b", image: "b.jpg", price_paise: 0 }),          // priced at zero
      row({ id: "c", image: "c.jpg", visible: 0 }),              // hidden
      row({ id: "d", image: "d.jpg", images: "extra.jpg" }),     // has a second view
    ],
    manifest: ["a.jpg", "b.jpg", "c.jpg", "d.jpg", "extra.jpg", "brand-new.jpg"],
  });
  const out = await (await listProducts(env)).json();
  const byName = (n) => out.products.find((p) => p.name === n);

  ok("hidden products are not returned", !out.products.some((p) => p.id === "c"));
  ok("a priced product is not quote_only", byName("a").quote_only === false);
  ok("a zero-priced product IS quote_only", byName("b").quote_only === true);

  const synth = out.products.filter((p) => p.id === null);
  ok("exactly one photo is synthesised", synth.length === 1,
     synth.map((s) => s.image).join(","));
  ok("and it is the new one", synth[0].image === "assets/images/brand-new.jpg", synth[0].image);

  // The three ways a photo is already spoken for.
  ok("a photo used as a primary image is not synthesised",
     !synth.some((s) => /a\.jpg|b\.jpg|d\.jpg/.test(s.image)));
  ok("a photo used only as a SECONDARY view is not synthesised",
     !synth.some((s) => /extra\.jpg/.test(s.image)),
     "it would appear twice: once inside product d, once as its own card");
  ok("a HIDDEN product's photo is not resurrected",
     !synth.some((s) => /c\.jpg/.test(s.image)),
     "hiding a product must not bring it back as a quote-only card");

  // Synthesised cards must be inert.
  ok("synthesised cards have no id", synth.every((s) => s.id === null));
  ok("synthesised cards have no slug", synth.every((s) => s.slug === null));
  ok("synthesised cards are quote_only", synth.every((s) => s.quote_only === true));
  ok("synthesised cards cost nothing", synth.every((s) => s.price_paise === 0));
  ok("synthesised cards still get a name", synth.every((s) => s.name.length > 1));

  // Buyable first: a customer should meet what they can purchase before what
  // they have to ask about.
  const firstQuote = out.products.findIndex((p) => p.quote_only);
  const lastBuyable = out.products.map((p) => p.quote_only).lastIndexOf(false);
  ok("buyable products are listed before quote-only ones", lastBuyable < firstQuote,
     `last buyable at ${lastBuyable}, first quote-only at ${firstQuote}`);
}
{
  // No manifest: degrade to the old behaviour rather than breaking the shop.
  const env = catalogueEnv({
    products: [row({ id: "a", image: "a.jpg" })],
    manifest: null,
  });
  const out = await (await listProducts(env)).json();
  ok("no ASSETS binding → no synthesised cards, shop still works",
     out.products.length === 1 && out.products[0].id === "a");
  ok("and shipping config is still returned", out.shipping.flat_paise === 9900);
}
{
  // Every photo already listed: nothing synthesised, no empty cards.
  const env = catalogueEnv({
    products: [row({ id: "a", image: "a.jpg" })],
    manifest: ["a.jpg"],
  });
  const out = await (await listProducts(env)).json();
  ok("nothing synthesised when every photo is listed", out.products.length === 1);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
