// The price a customer sees is the price they pay — and any struck-through
// price beside it is one the shop genuinely charged before.
//
//   node test/pricing-display.mjs
//
// HISTORY, because it decides what this file guards. The storefront once showed
// a struck-through "MRP": the selling price + 15%, computed on the way to the
// page. Nothing had ever been sold at that figure — the pattern India's CCPA
// Guidelines for Prevention and Regulation of Dark Patterns (2023) call a false
// discount, with "MRP" itself a defined term under the Legal Metrology (Packaged
// Commodities) Rules. PR #28 removed it and this file asserted its absence.
//
// The struck price is BACK, as the honest version #28 itself proposed: a real
// `compare_at_paise` column, set per product by the owner as a claim about a
// price he actually sold at, shown only when it is above today's. So this file
// no longer guards absence. It guards the properties that keep the relanded
// version honest:
//
//   1. NEVER COMPUTED. No multiplier, no helper that derives a former price.
//   2. ONLY WHEN TRUE. Exposed only when price > 0 and former > price.
//   3. NEVER "MRP". The label is "Was" — a former-price claim.
//   4. FLOORS. 1499 → 1299 is 13%, never 14; a shop must not round its
//      discount up. And the two copies of the arithmetic agree.
//   5. NOWHERE ELSE. The cart, checkout and JSON-LD state the selling price only.
import { readFileSync } from "node:fs";
import * as lib from "../src/lib.js";
import { listProducts } from "../src/shop.js";
import { renderProductPage } from "../src/pdp.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");

const STOREFRONT = [
  "public/assets/js/main.js", "public/assets/js/product.js", "public/assets/js/quote-modal.js",
  "public/assets/css/style.css", "public/assets/css/pdp.css", "public/index.html",
  "src/pdp.js", "src/productpage.js", "src/seo.js", "src/shop.js", "src/lib.js",
  "src/emails.js", "src/orders.js", "src/cart.js", "src/invoicing.js", "src/coupons.js",
  "src/admin.js", "public/assets/js/admin.js",
];

// ── 1. never computed ──────────────────────────────────────────────
console.log("\n1. a former price is never computed");
for (const name of ["compareAtPaise", "comparePercentOff", "COMPARE_AT_MULTIPLIER"]) {
  ok(`lib.js does not export ${name}`, !(name in lib));
}
// The multiplier by name, by value, and any helper that DERIVES a former price
// from the selling price. `percentOff` is fine: it compares two stored numbers.
const COMPUTED = /compareAtPaise|COMPARE_AT|comparePercentOff|\*\s*1\.15\b|price_paise\s*\*\s*1\./;
for (const f of STOREFRONT) {
  const m = read(f).match(COMPUTED);
  ok(`${f} derives no former price`, !m, m && `matched ${JSON.stringify(m[0])}`);
}
// The only path a former price can take: a column, written by the owner.
ok("migration 0022 adds the column and nothing computes into it",
   /ADD COLUMN compare_at_paise INTEGER;/.test(read("migrations/0022_compare_at.sql")) &&
   !/UPDATE products SET compare_at_paise/.test(read("migrations/0022_compare_at.sql")));

// ── 2. only when true ──────────────────────────────────────────────
console.log("\n2. exposed only when it is a genuine reduction");
{
  const rows = (list) => ({
    ASSETS: undefined,
    DB: { prepare(sql) {
      const s = sql.replace(/\s+/g, " ");
      return { bind() { return this; }, async all() {
        if (s.includes("WHERE visible = 1 ORDER BY")) return { results: list };
        if (s.includes("WHERE visible = 0")) return { results: [] };
        return { results: [] };
      }, async first() { return null; } };
    } },
  });
  const base = (id, price, was) => ({ id, slug: id, name: id, description: "", price_paise: price,
    image: `assets/images/${id}.jpg`, images: "", category: "", sort: 0, visible: 1, pinned: 0,
    compare_at_paise: was });
  const out = await (await listProducts(rows([
    base("higher", 129900, 149900), base("equal", 129900, 129900),
    base("lower", 129900, 99900), base("none", 129900, null), base("unpriced", 0, 500),
  ]))).json();
  const by = Object.fromEntries(out.products.map((p) => [p.id, p.compare_at_paise]));
  ok("higher → exposed", by.higher === 149900);
  ok("equal → null", by.equal === null);
  ok("lower → null", by.lower === null);
  ok("unset → null", by.none === null);
  ok("unpriced product → null even with a value in the column", by.unpriced === null);
}
{
  const ENV = { APP_NAME: "AswinPrints", APP_BASE_URL: "https://x", FLAT_SHIP_PAISE: "9900", FREE_SHIP_THRESHOLD_PAISE: "200000" };
  const page = (price, was) => renderProductPage(ENV, {
    product: { slug: "p", name: "P", description: "", price_paise: price, image: "assets/images/p.jpg",
               images: "", category: "", compare_at_paise: was },
    related: [], headExtra: "<title>x</title>" });
  ok("PDP: higher → struck", /pdp-was/.test(page(129900, 149900)));
  ok("PDP: equal → nothing", !/pdp-was|pdp-off/.test(page(129900, 129900)));
  ok("PDP: lower → nothing", !/pdp-was|pdp-off/.test(page(129900, 99900)));
  ok("PDP: unpriced → nothing", !/pdp-was|pdp-off|<del/.test(page(0, 500)));
}
// The card guards on the SHAPED value: main.js must only ever create a <del>
// inside the branch that checks it. Everything after the check up to the
// matching close is one block, and `del` may appear nowhere else in the file.
{
  const main = read("public/assets/js/main.js");
  const dels = [...main.matchAll(/createElement\(['"]del['"]\)/g)].map((m) => m.index);
  ok("main.js creates exactly one <del>", dels.length === 1, String(dels.length));
  const guard = main.indexOf("if (p.compare_at_paise) {");
  ok("…and only inside the compare_at_paise guard",
     guard > 0 && dels.length === 1 && dels[0] > guard && dels[0] - guard < 600,
     `guard at ${guard}, del at ${dels[0]}`);
  const cartStart = main.indexOf("function renderCart");
  const cartEnd = main.indexOf("\n}\n", cartStart);
  ok("the cart drawer shows no former price",
     cartStart > 0 && !/product-was|compare_at|<del|'del'/.test(main.slice(cartStart, cartEnd)));
}

// ── 3. never "MRP" ─────────────────────────────────────────────────
console.log("\n3. nothing the shop shows says MRP");
for (const f of STOREFRONT) {
  // Comments may name the term while explaining why it is avoided; strings and
  // markup may not. Strip // and /* */ comments first.
  const src = read(f).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  ok(`${f} contains no MRP outside comments`, !/\bMRP\b/.test(src));
}
ok("the screen-reader label is \"Was\" on the card", /textContent = 'Was '/.test(read("public/assets/js/main.js")));
ok("the screen-reader label is \"Was\" on the PDP", /sr-only">Was <\/span>/.test(read("src/pdp.js")));

// ── 4. floors, and the two copies agree ────────────────────────────
console.log("\n4. the percentage floors and never overstates");
const { percentOff } = lib;
ok("1499 → 1299 is 13, not 14", percentOff(149900, 129900) === 13, String(percentOff(149900, 129900)));
ok("1000 → 999 is 0 (sub-1% shows no pill)", percentOff(100000, 99900) === 0);
ok("1000 → 990 is exactly 1", percentOff(100000, 99000) === 1);
ok("2000 → 1000 is 50", percentOff(200000, 100000) === 50);
ok("equal → 0", percentOff(129900, 129900) === 0);
ok("inverted → 0", percentOff(99900, 129900) === 0);
ok("unpriced → 0", percentOff(500, 0) === 0);
ok("garbage → 0", percentOff("x", 100) === 0 && percentOff(null, 100) === 0);
{
  // main.js cannot import lib.js, so it carries a copy. Hold both to Math.floor and
  // to the same formula, so a future "let's round it" in one place fails here.
  const main = read("public/assets/js/main.js"), l = read("src/lib.js");
  const formula = /Math\.floor\(\(\(was - now\) \/ was\) \* 100\)/;
  ok("lib.js percentOff floors", formula.test(l));
  ok("main.js percentOff floors, same formula", formula.test(main));
  ok("neither rounds", !/Math\.round\(\(\(was - now\)/.test(main + l));
}

// ── 5. nowhere else ────────────────────────────────────────────────
console.log("\n5. structured data and money paths state the selling price only");
const seo = read("src/seo.js");
ok("seo.js has no highPrice / listPrice", !/highPrice|listPrice/.test(seo));
ok("seo.js does not read compare_at_paise", !/compare_at/.test(seo));
ok("the JSON-LD offer uses price_paise", /price_paise/.test(seo));
for (const f of ["src/cart.js", "src/orders.js", "src/invoicing.js", "src/coupons.js", "src/emails.js"]) {
  ok(`${f} never touches compare_at_paise`, !/compare_at/.test(read(f)));
}
// The PDP can only render what its row loader selects.
ok("productpage.js selects the column for the PDP", /compare_at_paise/.test(read("src/productpage.js")));

console.log(`\n  pricing-display: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
