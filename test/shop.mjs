// Offline tests for the pricing engine. No wrangler, no D1 — env.DB is faked
// just far enough to satisfy prepare().bind().all().
//
// These are the tests that matter most in the whole project: priceCart() is the
// only thing between a tampered cart and a wrong charge.

import { priceCart, shippingFor, shippingConfig, MAX_QTY } from "../src/shop.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);

const ENV = { FLAT_SHIP_PAISE: "9900", FREE_SHIP_THRESHOLD_PAISE: "150000" };

// Fake catalogue: two visible products, one hidden.
const CATALOGUE = [
  { id: "p-small", name: "Kingfisher",  price_paise: 34900, visible: 1 },
  { id: "p-large", name: "Elephant",    price_paise: 89900, visible: 1 },
  { id: "p-hidden", name: "Spider-Man", price_paise: 54900, visible: 0 },
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
          // Mirror the real WHERE: visible = 1 AND id IN (...)
          const wanted = new Set(q.args);
          return { results: rows.filter((r) => r.visible === 1 && wanted.has(r.id)) };
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
  ok("parses threshold", c.free_threshold_paise === 150000, String(c.free_threshold_paise));

  // Vars are strings from wrangler.toml; a missing or junk one must not make
  // shipping NaN (which would produce a NaN total sent to Razorpay).
  const d = shippingConfig({});
  ok("missing vars fall back", d.flat_paise === 9900 && d.free_threshold_paise === 150000);
  const e = shippingConfig({ FLAT_SHIP_PAISE: "abc", FREE_SHIP_THRESHOLD_PAISE: "-5" });
  ok("junk vars fall back", e.flat_paise === 9900 && e.free_threshold_paise === 150000);
  const z = shippingConfig({ FLAT_SHIP_PAISE: "0" });
  ok("explicit 0 flat rate is honoured, not treated as missing", z.flat_paise === 0);
}

// ── shipping edges ────────────────────────────────────────────────
section("shippingFor() — threshold edges");
ok("one paise under threshold → flat", shippingFor(149999, "ship", ENV) === 9900);
ok("exactly at threshold → free", shippingFor(150000, "ship", ENV) === 0);
ok("one paise over → free", shippingFor(150001, "ship", ENV) === 0);
ok("well under → flat", shippingFor(34900, "ship", ENV) === 9900);
ok("pickup always free", shippingFor(100, "pickup", ENV) === 0);
ok("pickup free even above threshold", shippingFor(500000, "pickup", ENV) === 0);
// An unrecognised delivery mode must not silently mean "free".
ok("unknown delivery mode is charged", shippingFor(34900, "", ENV) === 9900);
ok("unknown delivery mode string is charged", shippingFor(34900, "PICKUP", ENV) === 9900);

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
  // Two large items cross the free-shipping threshold.
  const r = await priceCart(envWith(), [{ product_id: "p-large", qty: 2 }], "ship");
  ok("2 × 89900 = 179800 subtotal", r.subtotal_paise === 179800, String(r.subtotal_paise));
  ok("crosses threshold → free shipping", r.shipping_paise === 0);
  ok("total equals subtotal when shipping free", r.total_paise === 179800);
}
{
  const r = await priceCart(envWith(), [
    { product_id: "p-small", qty: 1 },
    { product_id: "p-large", qty: 1 },
  ], "pickup");
  ok("mixed cart subtotal", r.subtotal_paise === 124800, String(r.subtotal_paise));
  ok("pickup → no shipping", r.shipping_paise === 0);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
