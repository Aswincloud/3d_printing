// Offline tests for the product detail page.
//
// Run: node test/pdp.mjs
//
// The design constraint this file exists to protect: of 59 products, ONE has
// extra images and the median description is 80 characters. A page that only
// looks right when fed a rich product is a page that looks broken 58 times out
// of 59 — so the sparse cases are the primary tests here, not edge cases.

import { renderProductPage, breadcrumbJsonLd } from "../src/pdp.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);

const ENV = {
  APP_NAME: "AswinPrints",
  APP_BASE_URL: "https://3d-prints.aswincloud.com",
  FLAT_SHIP_PAISE: "9900",
  FREE_SHIP_THRESHOLD_PAISE: "200000",
};

const PRODUCT = (over = {}) => ({
  slug: "dragon-sculpture",
  name: "Dragon Sculpture",
  description: "Detailed dragon with scaled body and outstretched wings.",
  price_paise: 89900,
  image: "assets/images/dragon.jpg",
  images: "",
  category: "figurine",
  ...over,
});

const RELATED = [
  { slug: "elephant", name: "Elephant Sculpture", price_paise: 89900, image: "assets/images/e.jpg" },
  { slug: "jeep", name: "Jeep 4×4 Model", price_paise: 89900, image: "assets/images/j.jpg" },
];

const render = (p, related = RELATED) =>
  renderProductPage(ENV, { product: p, related, headExtra: "<title>x</title>" });

// ── the page exists at all ────────────────────────────────────────
section("a complete product renders");
{
  const h = render(PRODUCT());
  ok("is a full document", h.startsWith("<!DOCTYPE html>") && h.includes("</html>"));
  ok("names the product in an h1", /<h1>Dragon Sculpture<\/h1>/.test(h));
  ok("shows the price", h.includes("₹899"));
  ok("has add to cart", h.includes('id="pdpAdd"'));
  ok("has buy now", h.includes('id="pdpBuy"'));
  ok("has a quantity stepper", h.includes('id="pdpQty"'));
  ok("shows the description", h.includes("outstretched wings"));
  ok("loads the page script", h.includes("/assets/js/product.js"));
  ok("does NOT load the homepage script", !h.includes("/assets/js/main.js"),
     "main.js is 2,287 lines of homepage; the point was not to ship it here");
}

// ── THE degradation cases ─────────────────────────────────────────
//
// 58 of 59 products hit at least one of these.
section("sparse content still produces a complete page");
{
  // One photo, no extras — the common case.
  const h = render(PRODUCT({ images: "" }));
  ok("no thumbnail rail when there is one photo", !h.includes("pdp-thumbs"),
     "an empty strip under the photo reads as a broken gallery");
  ok("the hero image is still there", h.includes('id="pdpHero"'));
}
{
  // No description — ten products.
  const h = render(PRODUCT({ description: "" }));
  ok("no empty description block", !h.includes("pdp-desc"),
     "a bordered empty box reads as a page that failed to load");
  ok("the spec list still carries the page", h.includes("Bambu Lab A1"));
  ok("and the page is still complete", h.includes("</html>") && h.includes("pdpAdd"));
}
{
  // The worst case: no description, no extra images, no category.
  const h = render(PRODUCT({ description: "", images: "", category: "" }), []);
  ok("the sparsest possible product still renders", h.includes("</html>"));
  ok("still has a price and a buy button", h.includes("₹899") && h.includes("pdpAdd"));
  ok("still has the spec list", h.includes("Material") && h.includes("PLA"));
  ok("no empty related section", !h.includes("pdp-related"),
     "a heading with nothing under it is worse than no heading");
}
{
  // Gallery only when it earns its place.
  const h = render(PRODUCT({ images: "assets/images/b.jpg,assets/images/c.jpg" }));
  ok("thumbnail rail appears with extra images", h.includes("pdp-thumbs"));
  ok("all three photos are thumbs", (h.match(/pdp-thumb"/g) || []).length
     + (h.match(/pdp-thumb is-active/g) || []).length === 3,
     String((h.match(/class="pdp-thumb/g) || []).length));
  ok("the first is active", h.includes("pdp-thumb is-active"));
}

// ── unpriced products ─────────────────────────────────────────────
//
// price_paise = 0 means "not priced yet". priceCart refuses these server-side,
// so the page must not offer a button it cannot honour.
section("a quote-only product cannot be bought from the page");
{
  const h = render(PRODUCT({ price_paise: 0 }));
  ok("shows Price on request", h.includes("Price on request"));
  ok("NO add to cart", !h.includes('id="pdpAdd"'),
     "priceCart would refuse it — offering the button is a dead end for the customer");
  ok("NO buy now", !h.includes('id="pdpBuy"'));
  ok("NO quantity stepper", !h.includes('id="pdpQty"'));
  ok("offers a quote instead", h.includes("Request a quote"));
  ok("and says why", /isn't priced yet/.test(h));
}

// ── buy now: the ambiguity prompt ─────────────────────────────────
//
// "Buy now" with other things in the cart could mean this piece or the whole
// basket. The grid lightbox has asked since the shop launched; the product page
// must ask too, or moving grid clicks here would have quietly turned every
// buy-now into "charge me for everything".
section("buy now can ask which items to charge for");
{
  const h = render(PRODUCT());
  ok("the choice prompt exists", h.includes('id="pdpBuyChoice"'));
  ok("it starts hidden", /id="pdpBuyChoice" hidden/.test(h),
     "with an empty cart there is nothing to disambiguate");
  ok("has a just-this option", h.includes('id="pdpChoiceJustThis"'));
  ok("has an everything option", h.includes('id="pdpChoiceEverything"'));
  ok("the question text has a slot", h.includes('id="pdpBuyChoiceText"'));
  // The count depends on the visitor's cart, which the server has never seen, so
  // the text must be filled in by the page rather than rendered here.
  ok("the question is left empty server-side", /id="pdpBuyChoiceText"><\/p>/.test(h));
}
{
  const h = render(PRODUCT({ price_paise: 0 }));
  ok("no choice prompt on an unpriced product", !h.includes('id="pdpBuyChoice"'),
     "there is no buy button to raise the question");
}

// ── zoom ──────────────────────────────────────────────────────────
//
// Clicking a grid photo navigates here now instead of opening the old overlay,
// so this page is the only place left to see a photo full size. Without it there
// is no way to look closely at what you are buying.
section("the photo can be enlarged");
{
  const h = render(PRODUCT());
  ok("the hero is a button, not a plain div", h.includes('id="pdpZoomOpen"'));
  ok("it says what it does", /aria-label="View Dragon Sculpture full size"/.test(h));
  ok("there is a zoom overlay", h.includes('id="pdpZoom"'));
  ok("it starts hidden", /id="pdpZoom" hidden/.test(h));
  ok("it is a dialog", /role="dialog"/.test(h) && /aria-modal="true"/.test(h));
  ok("it has a close button", h.includes('id="pdpZoomClose"'));
  // The overlay's <img> src is filled in at open time from the hero, so a
  // swapped thumbnail zooms the photo actually on screen rather than the first.
  ok("the overlay image starts empty", /id="pdpZoomImg" src=""/.test(h));
}
{
  // A quote-only product has no buy controls but still has a photo worth seeing.
  const h = render(PRODUCT({ price_paise: 0 }));
  ok("zoom works on an unpriced product too", h.includes('id="pdpZoomOpen"'));
}

// ── breadcrumbs ───────────────────────────────────────────────────
section("breadcrumbs");
{
  const h = render(PRODUCT());
  ok("renders a trail", h.includes("pdp-crumbs"));
  ok("starts at Home", h.includes(">Home</a>"));
  ok("names the category", h.includes(">Figurines</a>"));
  ok("ends on the product, not a link", h.includes('aria-current="page">Dragon Sculpture'));
}
{
  // Ten products have no category. The trail must not read "Home › undefined ›".
  const h = render(PRODUCT({ category: "" }));
  ok("no category → two-level trail, not 'undefined'", !h.includes("undefined"), "found 'undefined' in the trail");
  ok("still starts at Home", h.includes(">Home</a>"));
  ok("still ends on the product", h.includes('aria-current="page">Dragon Sculpture'));
}
{
  const ld = breadcrumbJsonLd(ENV, PRODUCT());
  ok("BreadcrumbList type", ld["@type"] === "BreadcrumbList");
  ok("three levels", ld.itemListElement.length === 3, String(ld.itemListElement.length));
  ok("positions are 1-indexed and ordered",
     ld.itemListElement.map((i) => i.position).join(",") === "1,2,3");
  ok("every item has an absolute url",
     ld.itemListElement.every((i) => String(i.item).startsWith("https://")));
  // Structured data that disagrees with the visible trail is a Search Console
  // error, so they are generated from the same function.
  ok("last item is the product page",
     ld.itemListElement[2].item === "https://3d-prints.aswincloud.com/p/dragon-sculpture");

  const noCat = breadcrumbJsonLd(ENV, PRODUCT({ category: "" }));
  ok("no category → two levels in the JSON too", noCat.itemListElement.length === 2);
  ok("and positions still start at 1", noCat.itemListElement[0].position === 1);
}

// ── related ───────────────────────────────────────────────────────
section("related products");
{
  const h = render(PRODUCT());
  ok("renders the section", h.includes("pdp-related"));
  ok("names the category", h.includes("More in Figurines"));
  ok("one card per related product", (h.match(/pdp-rel-card/g) || []).length === 2);
  ok("cards link to product pages", h.includes("/p/elephant"));
}
{
  // A related item with no price shows "Price on request" rather than ₹0.
  const h = render(PRODUCT(), [
    { slug: "x", name: "Unpriced", price_paise: 0, image: "assets/images/x.jpg" },
  ]);
  ok("an unpriced related card says Price on request", h.includes("Price on request"));
  ok("and never shows ₹0", !h.includes("₹0"));
}
{
  const h = render(PRODUCT({ category: "" }), RELATED);
  ok("no category → generic heading, not 'More in undefined'",
     h.includes("More prints") && !h.includes("undefined"));
}

// ── escaping ──────────────────────────────────────────────────────
//
// Product names and descriptions are owner-editable free text, so a quote or a
// bracket in one must not break the document.
section("owner-editable text cannot break the page");
{
  const nasty = render(PRODUCT({
    name: 'Dragon "Large" <script>alert(1)</script>',
    description: "A & B <b>bold</b>",
  }));
  ok("no raw script tag survives", !nasty.includes("<script>alert(1)</script>"));
  ok("the name is escaped", nasty.includes("&lt;script&gt;"));
  ok("ampersand is escaped", nasty.includes("A &amp; B"));
  ok("quotes are escaped in the heading", nasty.includes("&quot;Large&quot;"));
  ok("the document still closes", nasty.trim().endsWith("</html>"));
  // The alt attribute takes the name too — an unescaped quote there would break
  // out of the attribute.
  ok("alt attribute is safe", !/alt="[^"]*"[^>]*alert/.test(nasty));
}

// ── shipping figures come from config ─────────────────────────────
section("delivery line reflects the real shipping config");
{
  const h = render(PRODUCT());
  ok("states the flat rate", h.includes("₹99"));
  ok("states the free threshold", h.includes("₹2,000"));

  // Changing the env must change the page — otherwise the spec line becomes a
  // hardcoded claim that drifts from what checkout actually charges.
  const other = renderProductPage(
    { ...ENV, FLAT_SHIP_PAISE: "14900", FREE_SHIP_THRESHOLD_PAISE: "300000" },
    { product: PRODUCT(), related: [], headExtra: "" },
  );
  ok("a different flat rate shows through", other.includes("₹149"), "hardcoded shipping");
  ok("a different threshold shows through", other.includes("₹3,000"));
}

// ── reaching the cart from here ───────────────────────────────────
//
// This page had no route to the cart. Adding something said "Added ✓" on the
// button and then offered nothing — you had to navigate to the homepage to see
// what was in it, and on a phone the nav was the only thing to fall back on.
//
// It is a LINK, not a drawer of its own: the drawer, the pricing and the
// Razorpay flow all live in main.js, and "Buy now" on this page already hands
// off to the homepage for that reason. Two implementations of the cart is the
// thing to avoid, so the test asserts the handoff rather than a local cart.
section("the cart is reachable from the product page");
{
  const h = render(PRODUCT());
  ok("a cart control exists in the nav", /id="pdpCartLink"/.test(h));
  ok("it links to the homepage cart", /href="\/#cart"/.test(h));
  ok("it is a link, not a button that does nothing here",
     /<a[^>]+id="pdpCartLink"/.test(h));
  ok("it is labelled for a screen reader", /id="pdpCartLink"[^>]*aria-label="Open cart"/.test(h)
     || /aria-label="Open cart"[^>]*id="pdpCartLink"/.test(h));
  ok("it carries a badge for the count", /id="pdpCartBadge"/.test(h));

  // Server-rendered, so the count is not knowable here — product.js fills it in
  // from localStorage. It must therefore start HIDDEN, or every page would flash
  // a "0" badge before the script runs.
  ok("the badge starts hidden", /id="pdpCartBadge"[^>]*hidden/.test(h));
  ok("the badge does not ship a misleading count",
     />0<\/span>/.test(h) === false || /id="pdpCartBadge"[^>]*hidden/.test(h));

  // Reuses the homepage's classes so it looks like the same control, and so the
  // 44px touch target and badge styling come from style.css rather than a copy.
  ok("reuses the homepage cart styling", /class="nav-cart pdp-cart"/.test(h));

  // Still reachable on a quote-only product: the cart may hold other things.
  const q = render({ ...PRODUCT(), price_paise: 0 });
  ok("present on a quote-only product too", /id="pdpCartLink"/.test(q));

  // And the existing way out is untouched.
  ok("All prints still there", /class="btn-secondary nav-back"/.test(h));
}

console.log(`\n  pdp: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
