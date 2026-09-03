// The price a customer sees is the price they pay — and nothing else.
//
//   node test/pricing-display.mjs
//
// This file used to guard the CONTAINMENT of a struck-through "MRP": the selling
// price + 15%, shown crossed out beside the real one on cards and product pages.
// Nothing had ever been sold at that figure, which made it a fabricated reference
// price — the pattern India's CCPA Guidelines for Prevention and Regulation of Dark
// Patterns (2023) describe as a false discount, with "MRP" itself a defined term
// under the Legal Metrology (Packaged Commodities) Rules. It also contradicted the
// shop's own copy: "Prices are all-inclusive — what you see is what you pay."
//
// The figure is gone. These assertions are what stop it coming back quietly —
// through a helper in lib.js, a class in the CSS, or a "listPrice" in the JSON-LD.
// The only struck-through money on the site should be a real coupon's saving in
// the cart, which has its own line and comes from the server.
import { readFileSync } from "node:fs";
import * as lib from "../src/lib.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");

console.log("\nno reference-price helper exists to call");
for (const name of ["compareAtPaise", "comparePercentOff", "COMPARE_AT_MULTIPLIER"]) {
  ok(`lib.js does not export ${name}`, !(name in lib));
}

console.log("\nno surface computes or renders one");
// "% off" itself is fine — the promo banner says "10% off" about a real coupon.
const FABRICATED = /compareAt|COMPARE_AT|comparePercentOff|wasBlock|product-was|pdp-was|pdp-off/i;
for (const f of [
  "public/assets/js/main.js", "public/assets/js/product.js", "public/assets/js/quote-modal.js",
  "public/assets/css/style.css", "public/assets/css/pdp.css", "public/index.html",
  "src/pdp.js", "src/productpage.js", "src/seo.js", "src/shop.js", "src/lib.js",
  "src/emails.js", "src/orders.js", "src/cart.js", "src/invoicing.js", "src/coupons.js",
]) {
  const src = read(f);
  const m = src.match(FABRICATED);
  ok(`${f} has no reference-price code`, !m, m && `matched ${JSON.stringify(m[0])}`);
}

// A <del> anywhere in the storefront would be a struck price by another name. The
// cart drawer's coupon line uses its own class, not <del>, so this stays clean.
for (const f of ["public/assets/js/main.js", "src/pdp.js", "public/index.html"]) {
  ok(`${f} creates no <del>`, !/createElement\(['"]del['"]\)|<del[\s>]/.test(read(f)));
}

console.log("\nstructured data states the real selling price and only that");
const seo = read("src/seo.js");
ok("seo.js has no highPrice / listPrice", !/highPrice|listPrice/.test(seo));
ok("the JSON-LD offer uses price_paise", /price_paise/.test(seo));

console.log(`\n  pricing-display: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
