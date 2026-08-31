// Offline tests for the pricing engine. No wrangler, no D1 — env.DB is faked
// just far enough to satisfy prepare().bind().all().
//
// These are the tests that matter most in the whole project: priceCart() is the
// only thing between a tampered cart and a wrong charge.

import { priceCart, shippingFor, shippingConfig, MAX_QTY, listProducts } from "../src/shop.js";
import { readFileSync } from "node:fs";

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
  // Personalised. p-name cannot be printed without an answer; p-colour has a
  // default and the question is an upsell, so a blank is a real answer.
  { id: "p-name", name: "Plate Keychain", price_paise: 29900, visible: 1,
    personalise_label: "Name or text to print", personalise_required: 1 },
  { id: "p-colour", name: "PS5 Stand", price_paise: 89900, visible: 1,
    personalise_label: "Colour", personalise_required: 0 },
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
        // A deterministic stand-in for the real content hash, so the ?v= stamping in
        // listProducts is actually exercised rather than skipped for want of a hash.
        images: manifest.map((f) => ({ file: f, bytes: 1000, hash: `h${f.length}` })),
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
  visible: o.visible ?? 1, pinned: o.pinned ?? 0,
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
  // Compared without the ?v= suffix: the identity being asserted is WHICH photo,
  // and the content hash on the end is a caching detail that would otherwise make
  // this test fail every time the file changed.
  const bare = (u) => String(u).split("?")[0];
  ok("and it is the new one", bare(synth[0].image) === "assets/images/brand-new.jpg", synth[0].image);

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
  // Retiring a duplicate listing: hide it, never DELETE the row.
  //
  // This is the inverse of "a hidden product's photo is not resurrected" above,
  // and it is the reason 0013 retires the duplicate staircase with visible = 0.
  // Deleting the row leaves its photo used by nothing, so the shop synthesises a
  // quote-only card for it on the very next request — the same print back on the
  // shop as a third listing, seconds after being removed. Asserted from both
  // directions because the safe option and the destructive one look equally
  // reasonable in a migration until you know this.
  const withRow = catalogueEnv({
    products: [
      row({ id: "keep", image: "staircase.jpg" }),
      row({ id: "dupe", image: "staircase-poster.jpg", visible: 0 }),   // retired
    ],
    manifest: ["staircase.jpg", "staircase-poster.jpg"],
  });
  const a = await (await listProducts(withRow)).json();
  ok("a retired duplicate is off the shop", !a.products.some((p) => p.id === "dupe"));
  ok("and its photo is NOT synthesised back",
     !a.products.some((p) => p.id === null),
     a.products.filter((p) => p.id === null).map((p) => p.image).join(","));

  // Now the same catalogue with the row deleted outright, which is what a DELETE
  // migration would leave behind.
  const rowGone = catalogueEnv({
    products: [row({ id: "keep", image: "staircase.jpg" })],
    manifest: ["staircase.jpg", "staircase-poster.jpg"],
  });
  const b = await (await listProducts(rowGone)).json();
  const ghost = b.products.filter((p) => p.id === null);
  ok("DELETING the row instead brings the photo back as a card", ghost.length === 1,
     "if this ever fails, the hazard is gone and 0013's reasoning is stale");
  ok("and the ghost is the retired duplicate's photo",
     String(ghost[0]?.image).split("?")[0] === "assets/images/staircase-poster.jpg",
     ghost[0]?.image);
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


// ── image URLs carry a content version ────────────────────────────
//
// The ?v=<hash> is what makes a long browser cache safe. Photos get REPLACED under
// the same filename — all eight posters were re-cropped in place — so without a
// version in the URL, caching an image by path means serving the old crop until it
// expires, with no way to clear it.
section("listProducts() — image versioning");
{
  const env = catalogueEnv({
    products: [
      { id: "p1", slug: "listed", name: "Listed", description: "d", price_paise: 34900,
        image: "assets/images/listed.jpg", images: "", category: "figurine", visible: 1, sort: 1 },
    ],
    manifest: ["listed.jpg", "unlisted.jpg"],
  });
  const out = await (await listProducts(env)).json();
  const listed = out.products.find((p) => p.id === "p1");
  const synth = out.products.find((p) => p.id === null);

  ok("a listed product's image carries ?v=", /\?v=h\d+$/.test(listed.image), listed.image);
  ok("a synthesised card's image carries ?v=", /\?v=h\d+$/.test(synth.image), synth.image);
  ok("the path itself is unchanged",
     listed.image.split("?")[0] === "assets/images/listed.jpg", listed.image);
  ok("the version is the manifest's hash for THAT file",
     listed.image.endsWith("?v=h" + "listed.jpg".length), listed.image);
  ok("every image in the response is versioned",
     out.products.every((p) => p.image.includes("?v=")),
     out.products.map((p) => p.image).join(" "));
}
{
  // A photo in the database but missing from the manifest gets NO version — and
  // must not get a broken one. index.js/_headers then treats an unversioned URL as
  // the short-cache case, which is the safe way round.
  const env = catalogueEnv({
    products: [
      { id: "p1", slug: "orphan", name: "Orphan", description: "d", price_paise: 100,
        image: "assets/images/not-in-manifest.jpg", images: "", category: "", visible: 1, sort: 1 },
    ],
    manifest: ["something-else.jpg"],
  });
  const out = await (await listProducts(env)).json();
  const orphan = out.products.find((p) => p.id === "p1");
  ok("a photo missing from the manifest is left unversioned",
     orphan.image === "assets/images/not-in-manifest.jpg", orphan.image);
  ok("and no empty ?v= is appended", !orphan.image.includes("?v="), orphan.image);
}
{
  // No ASSETS binding at all: the shop must still price and list.
  const env = catalogueEnv({
    products: [
      { id: "p1", slug: "x", name: "X", description: "", price_paise: 100,
        image: "assets/images/x.jpg", images: "", category: "", visible: 1, sort: 1 },
    ],
    manifest: null,
  });
  const out = await (await listProducts(env)).json();
  ok("no manifest → still lists, just unversioned",
     out.products.length === 1 && out.products[0].image === "assets/images/x.jpg",
     JSON.stringify(out.products.map((p) => p.image)));
}

// ── the _headers file is what actually applies the cache policy ───
//
// src/index.js cannot: run_worker_first is scoped to the HTML entry points, so the
// asset server answers /assets/images/* and the Worker never runs. A cache-control
// helper was written there first and did nothing at all.
section("public/_headers");
{
  const raw = readFileSync(new URL("../public/_headers", import.meta.url), "utf8");
  // Comment lines stripped before matching. The first version tested the whole file
  // and failed on the word "immutable" inside the comment that explains why it is
  // NOT used — a test that reads documentation as configuration.
  const h = raw.split("\n").filter((l) => !l.trim().startsWith("#")).join("\n");
  ok("covers product photos", /^\/assets\/images\/\*/m.test(h));
  ok("photos are cached for a day, not zero",
     /\/assets\/images\/\*[\s\S]{0,120}?max-age=86400/.test(h));
  ok("with stale-while-revalidate behind it",
     /\/assets\/images\/\*[\s\S]{0,160}?stale-while-revalidate=\d+/.test(h));
  // The trap this whole design avoids. _headers matches on PATH only, so it cannot
  // see ?v= — an immutable rule here would apply to bare paths too and pin a
  // re-cropped photo forever.
  ok("NOTHING is marked immutable, because _headers cannot see ?v=",
     !/immutable/.test(h), "an immutable path rule would pin a replaced photo");
  // Reads the numbers and compares them, rather than pinning the literal that
  // happened to be there. The previous version asserted `max-age=3600`, which is
  // not what its own name claims and made a correct change look like a break.
  const ttl = (path) => {
    const m = h.match(new RegExp(path + "[\\s\\S]{0,160}?max-age=(\\d+)"));
    return m ? Number(m[1]) : null;
  };
  const photoTtl = ttl("\\/assets\\/images\\/\\*");
  const cssTtl = ttl("\\/assets\\/css\\/\\*");
  const jsTtl = ttl("\\/assets\\/js\\/\\*");
  ok("css and js are cached for less than the photos",
     cssTtl !== null && jsTtl !== null && cssTtl < photoTtl && jsTtl < photoTtl,
     `css ${cssTtl}, js ${jsTtl}, photos ${photoTtl}`);

  // The lesson from a layout fix that was live and correct while a phone still
  // rendered the old stylesheet. stale-while-revalidate does not revalidate
  // quietly and serve fresh — it serves the STALE file to that visitor. On an
  // asset whose filename is not fingerprinted, a long stale window means the
  // same URL keeps meaning the old thing long after a deploy.
  const unversioned = h.match(/\/assets\/(?:css|js)\/\*[\s\S]{0,160}?Cache-Control:([^\n]+)/g) || [];
  ok("neither carries a long stale-while-revalidate window",
     unversioned.length === 2 && unversioned.every((r) => {
       const m = r.match(/stale-while-revalidate=(\d+)/);
       return !m || Number(m[1]) <= 60;
     }),
     unversioned.join(" | "));
  ok("the manifest is kept short, or a new photo would not appear",
     /images\.json[\s\S]{0,120}?max-age=60/.test(h));
  ok("the API and HTML are NOT given a cache rule here",
     !/^\/api\//m.test(h) && !/^\/\*$/m.test(h));
}

// ══ PERSONALISATION ══════════════════════════════════════════════
// The reason this exists: three live products asked the buyer for a name or a
// colour, and checkout collected nothing, so an order could be paid in full with
// no idea what to print. The refusal has to live HERE and not in the browser —
// Buy-now hands off straight to checkout, and the API takes a cart from anywhere.
section("personalisation — a required value is enforced server-side");
{
  const missing = await priceCart(envWith(), [{ product_id: "p-name", qty: 1 }], "ship");
  ok("required + blank is refused", Boolean(missing.error), JSON.stringify(missing));
  ok("names the product", /Plate Keychain/.test(missing.error || ""), missing.error);
  ok("names the field", /Name or text to print/.test(missing.error || ""), missing.error);

  const blank = await priceCart(envWith(),
    [{ product_id: "p-name", qty: 1, personalisation: "   " }], "ship");
  ok("whitespace is not an answer", Boolean(blank.error), JSON.stringify(blank));

  const filled = await priceCart(envWith(),
    [{ product_id: "p-name", qty: 1, personalisation: "SUNNY" }], "ship");
  ok("a value is accepted", !filled.error, JSON.stringify(filled.error));
  ok("and is snapshotted onto the line", filled.items[0].personalisation === "SUNNY");
}

section("personalisation — optional, absent, and unasked-for");
{
  const opt = await priceCart(envWith(), [{ product_id: "p-colour", qty: 1 }], "ship");
  ok("optional + blank checks out fine", !opt.error, JSON.stringify(opt.error));
  ok("stores an empty string, not undefined", opt.items[0].personalisation === "");

  // A product that does not ask must never carry one, whatever the client sends.
  // The client decides what to SHOW; the row decides what is real.
  const unasked = await priceCart(envWith(),
    [{ product_id: "p-small", qty: 1, personalisation: "engrave this" }], "ship");
  ok("a value on an unpersonalised product is stripped",
     unasked.items[0].personalisation === "", JSON.stringify(unasked.items[0]));

  const long = await priceCart(envWith(),
    [{ product_id: "p-name", qty: 1, personalisation: "x".repeat(500) }], "ship");
  // Clipped rather than rejected: losing a real order over a long line of text
  // is the worse failure.
  ok("over-long is clipped to 120", long.items[0].personalisation.length === 120,
     String(long.items[0].personalisation.length));
}

section("personalisation — survives the duplicate collapse");
{
  // priceCart collapses duplicate ids so the qty cap cannot be bypassed. One
  // value per product is what makes that safe to keep: the two lines become one
  // line, so they are one personalisation.
  const dup = await priceCart(envWith(), [
    { product_id: "p-name", qty: 1, personalisation: "SUNNY" },
    { product_id: "p-name", qty: 2 },
  ], "ship");
  ok("collapses to one line", dup.items.length === 1, String(dup.items.length));
  ok("quantities still sum", dup.items[0].qty === 3, String(dup.items[0].qty));
  ok("the non-empty value wins", dup.items[0].personalisation === "SUNNY");

  // The cap is the security control the collapse exists for. Varying the text
  // must not become a way around it.
  const over = await priceCart(envWith(), [
    { product_id: "p-name", qty: MAX_QTY, personalisation: "A" },
    { product_id: "p-name", qty: 1, personalisation: "B" },
  ], "ship");
  ok("the qty cap still applies across differing values", Boolean(over.error), JSON.stringify(over));
}

// ══ THE PROMO BANNER ═════════════════════════════════════════════
//
// A banner is a promise. If it says 10% off and checkout disagrees, the customer
// is the one who finds out — so every reason a code could be unusable is checked
// HERE, and the banner simply does not render rather than advertising something
// that will be refused at the till.
section("featured promo — only ever a code that actually works");
{
  const COUPON = {
    code: "WELCOME10", kind: "percent", value: 10, min_order_paise: 0,
    max_discount_paise: 10000, expires_at: null, max_uses: null, uses: 0,
    active: 1, once_per_customer: 1,
  };
  const env = (over = {}, promoCode = "WELCOME10") => ({
    ...ENV,
    PROMO_CODE: promoCode,
    DB: {
      prepare(sql) {
        return {
          bind() { return this; },
          async first() {
            if (!/FROM coupons/.test(sql)) return null;
            return { ...COUPON, ...over };
          },
          async all() { return { results: [] } ; },
        };
      },
    },
    ASSETS: { fetch: async () => new Response("{}", { status: 200 }) },
  });

  const promoOf = async (...a) => (await (await listProducts(env(...a))).json()).promo;

  const live = await promoOf();
  ok("a usable code is offered", live && live.code === "WELCOME10", JSON.stringify(live));
  ok("carries the terms the banner must state",
     live.kind === "percent" && live.value === 10 && live.max_discount_paise === 10000
       && live.once_per_customer === true, JSON.stringify(live));

  // Every way a code stops working. Each must take the banner down on its own,
  // with nothing for Aswin to remember to do.
  for (const [label, over] of [
    ["paused in the dashboard", { active: 0 }],
    ["expired", { expires_at: Date.now() - 1000 }],
    ["out of uses", { max_uses: 5, uses: 5 }],
    ["a shipping code, which has no banner terms", { kind: "shipping" }],
  ]) {
    ok(`${label} → no banner`, (await promoOf(over)) === null, label);
  }

  ok("expiring in the future is still offered",
     (await promoOf({ expires_at: Date.now() + 86400000 })) !== null);
  ok("uses below the cap is still offered",
     (await promoOf({ max_uses: 5, uses: 4 })) !== null);

  // The off switch that does not touch the coupon: clearing the var stops
  // advertising it while anyone already holding the code can still redeem it.
  ok("PROMO_CODE unset → no banner", (await promoOf({}, "")) === null);
  ok("PROMO_CODE naming a code that does not exist → no banner",
     (await (await listProducts({
       ...ENV, PROMO_CODE: "NOSUCH",
       DB: { prepare: () => ({ bind() { return this; }, async first() { return null; },
                               async all() { return { results: [] }; } }) },
       ASSETS: { fetch: async () => new Response("{}", { status: 200 }) },
     })).json()).promo === null);
}

// ── pinning, and the ordering bug it uncovered ──────────────────────────────
//
// The catalogue has always said ORDER BY sort ASC. 49 of 85 products carry
// hand-set sort values (10, 20, 30 …) and the other 36 sit at the default 0 —
// which sorts FIRST. So the curated order was buried under everything that was
// never curated, and the live shop opened on "Banana Bowl, Batman Figurine,
// Buddha Incense Holder" instead of the order actually chosen.
//
// The fake DB in catalogueEnv() does not implement ORDER BY, so a test through
// it would prove nothing about the clause. These run the SQL SHIPPED IN
// src/shop.js against real SQLite. The expected order is written out by hand
// here; only the clause under test is imported.
section("listProducts() — catalogue ordering (real SQLite, shipped SQL)");
{
  const { DatabaseSync } = await import("node:sqlite");

  // Pull the ORDER BY out of the source rather than restating it, so this test
  // cannot silently drift away from the query that actually runs.
  const src = readFileSync(new URL("../src/shop.js", import.meta.url), "utf8");
  const clause = src.match(/ORDER BY pinned DESC[^`]*?(?=`)/);
  // If the ordering is ever reverted this must report a failure, not throw on
  // clause[0] two lines down and take the rest of the file with it.
  ok("the shipped query still orders by pinned then curated sort", clause !== null,
     "no `ORDER BY pinned DESC ...` found in listProducts()");
  const ORDER = clause ? clause[0].trim() : "ORDER BY name ASC";

  const orderOf = (rows) => {
    const db = new DatabaseSync(":memory:");
    db.exec("CREATE TABLE products (name TEXT, sort INTEGER, pinned INTEGER, visible INTEGER)");
    const ins = db.prepare("INSERT INTO products VALUES (?, ?, ?, 1)");
    for (const r of rows) ins.run(r.name, r.sort, r.pinned ? 1 : 0);
    return db.prepare(
      `SELECT name FROM products WHERE visible = 1 ${ORDER}`
    ).all().map((r) => r.name);
  };

  // The live shape: curated rows interleaved with uncurated ones, inserted in an
  // order that is neither the input order nor alphabetical.
  const live = [
    { name: "Banana Bowl", sort: 0 },
    { name: "Elephant Sculpture", sort: 20 },
    { name: "Batman Figurine", sort: 0 },
    { name: "Articulated Dinosaur", sort: 10 },
    { name: "Christmas House", sort: 0 },
  ];

  ok("curated products lead, in their sort order",
     orderOf(live).slice(0, 2).join(" | ") === "Articulated Dinosaur | Elephant Sculpture",
     orderOf(live).join(" | "));

  ok("uncurated products follow, alphabetically",
     orderOf(live).slice(2).join(" | ") === "Banana Bowl | Batman Figurine | Christmas House",
     orderOf(live).join(" | "));

  // The regression this replaced: sort=0 used to win outright.
  ok("a sort=0 product no longer outranks a curated one",
     orderOf(live).indexOf("Articulated Dinosaur") < orderOf(live).indexOf("Banana Bowl"));

  // A pin beats both groups, whatever its own sort value is.
  const pinned = [...live, { name: "Zebra Vase", sort: 0, pinned: true }];
  ok("a pinned product leads everything", orderOf(pinned)[0] === "Zebra Vase",
     orderOf(pinned).join(" | "));

  const pinnedLate = [...live.map((r) => ({ ...r })), { name: "Zulu Mask", sort: 570, pinned: true }];
  ok("a pin beats a high sort value too", orderOf(pinnedLate)[0] === "Zulu Mask",
     orderOf(pinnedLate).join(" | "));

  ok("unpinning restores the normal order",
     orderOf([...live, { name: "Zebra Vase", sort: 0, pinned: false }])[0] === "Articulated Dinosaur");
}

// The JS pass that runs AFTER the query, which is where pin has to outrank the
// buyable/quote-only split. SQL cannot express this one: quote_only is derived
// from price_paise in shape(), not stored.
section("listProducts() — pin outranks the buyable split");
{
  const env = catalogueEnv({
    products: [
      row({ id: "buyable", image: "buyable.jpg", price_paise: 34900 }),
      row({ id: "pinned-unpriced", image: "pinned-unpriced.jpg", price_paise: 0, pinned: 1 }),
    ],
    manifest: ["buyable.jpg", "pinned-unpriced.jpg"],
  });
  const out = await (await listProducts(env)).json();
  const ids = out.products.map((p) => p.id);

  // Without the pin key this is exactly backwards: quote_only sorts last.
  ok("a pinned unpriced product still leads a buyable one",
     ids[0] === "pinned-unpriced", ids.join(" | "));

  ok("pinned is exposed on the card", out.products[0].pinned === true);
  ok("unpinned reads false, not undefined",
     out.products.find((p) => p.id === "buyable").pinned === false);

  // A synthesised card has no row, so there is nothing to pin — but it must still
  // carry the field, or the frontend has to special-case it.
  const synth = out.products.find((p) => p.id === null);
  ok("a synthesised card carries pinned: false", synth === undefined || synth.pinned === false);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
