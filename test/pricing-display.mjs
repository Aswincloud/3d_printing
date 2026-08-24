// The struck-through "MRP" — what it is, and everywhere it must NOT appear.
//
//   node test/pricing-display.mjs
//
// The number is the selling price + 15%. Nothing has ever been sold at it: it is a
// fabricated reference price, added at Aswin's explicit direction after he was told
// that India's CCPA Guidelines for Prevention and Regulation of Dark Patterns (2023)
// describe exactly this, and that "MRP" is a defined term under the Legal Metrology
// (Packaged Commodities) Rules. His shop, his call.
//
// Which makes the CONTAINMENT the valuable part of this file, and why most of the
// assertions below are negative. A struck price on a product card is one thing; the
// same invented figure appearing beside a real charged total, on an invoice, or in
// structured data handed to Google is a materially different claim. These tests are
// the thing standing between the two, so if one starts failing, the question is not
// "how do I make it pass".
import { compareAtPaise, comparePercentOff, COMPARE_AT_MULTIPLIER, rupees } from "../src/lib.js";
import { readFileSync } from "node:fs";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");

console.log("\nthe arithmetic");
ok("multiplier is 15%", COMPARE_AT_MULTIPLIER === 1.15);
ok("₹399 → ₹459", compareAtPaise(39900) === 45900, String(compareAtPaise(39900)));
ok("₹449 → ₹516", compareAtPaise(44900) === 51600, String(compareAtPaise(44900)));
ok("₹1,999 → ₹2,299", compareAtPaise(199900) === 229900, String(compareAtPaise(199900)));

// Whole rupees. A reference price with two decimals looks like something a computer
// produced, which is the one thing it must not look like — the first version showed
// ₹458.85 because it rounded to whole PAISE.
for (const p of [9900, 12900, 34900, 39900, 44900, 48900, 59900, 199900, 1200000]) {
  const was = compareAtPaise(p);
  ok(`₹${p/100} → no paise in the struck figure`, was % 100 === 0, rupees(was));
}
ok("and rupees() therefore renders it without decimals",
   !rupees(compareAtPaise(44900)).includes("."), rupees(compareAtPaise(44900)));

console.log("\nit never appears where there is no price");
// -10000 as well as -1. Mutation showed the `p > 0` guard could be deleted with
// every test still green, because -1 rounds to zero through the arithmetic anyway
// and nothing here went far enough negative to notice. A stored -₹100 would have
// produced a struck price of -₹100 sitting above the real one.
for (const p of [0, -1, -10000, null, undefined, NaN, "abc", ""]) {
  ok(`${JSON.stringify(p)} → 0, so quote-only shows no struck price`, compareAtPaise(p) === 0);
  ok(`${JSON.stringify(p)} → 0% off`, comparePercentOff(p) === 0);
}

console.log("\nthe badge matches the two numbers beside it");
// +15% on the price is 13% off the result. A badge hardcoded to "15%" would
// contradict the arithmetic printed next to it.
for (const p of [9900, 39900, 44900, 199900]) {
  const was = compareAtPaise(p);
  const shown = comparePercentOff(p);
  const actual = Math.round(((was - p) / was) * 100);
  ok(`₹${p/100}: badge says ${shown}%, which is what the figures show`, shown === actual);
  ok(`₹${p/100}: badge is not the naive 15`, shown === 13, String(shown));
}

console.log("\nthe client mirror cannot drift from the server");
const main = read("public/assets/js/main.js");
ok("main.js declares the same multiplier",
   /const COMPARE_AT_MULTIPLIER = 1\.15;/.test(main));
ok("main.js rounds to whole rupees the same way",
   /Math\.round\(\(p \* COMPARE_AT_MULTIPLIER\) \/ 100\) \* 100/.test(main));
ok("main.js returns 0 for an unpriced product",
   /if \(!\(p > 0\)\) return 0;/.test(main));

console.log("\nWHERE IT MUST NOT GO");
// Money actually charged. A fabricated "you saved ₹X" against a real total is not a
// presentational flourish, it is a claim about the transaction.
for (const f of ["src/emails.js", "src/orders.js", "src/cart.js", "src/invoicing.js",
                 "src/razorpay.js", "src/coupons.js", "src/shop.js"]) {
  const src = read(f);
  ok(`${f} does not use the reference price`,
     !/compareAtPaise|COMPARE_AT_MULTIPLIER|comparePercentOff/.test(src));
}
ok("the cart drawer does not show a struck price",
   !/product-was|compareAtPaise/.test(main.slice(main.indexOf("function renderCart"),
                                                 main.indexOf("function renderCart") + 4000)));

// Structured data is a machine-readable claim to Google. The JSON-LD keeps
// declaring the real selling price.
const pdp = read("src/pdp.js");
const ld = pdp.slice(pdp.indexOf("productJsonLd"), pdp.indexOf("productJsonLd") + 200);
ok("pdp.js does emit the struck price for DISPLAY", /wasBlock/.test(pdp));
const seo = read("src/seo.js");
ok("seo.js (all structured data) has no reference price",
   !/compareAtPaise|COMPARE_AT_MULTIPLIER|highPrice|listPrice/.test(seo));
ok("the JSON-LD offer still uses price_paise",
   /price_paise/.test(seo), "structured data must state the real selling price");

console.log(`\n  pricing-display: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
