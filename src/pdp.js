// The product detail page.
//
// Until now /p/<slug> served the whole homepage with rewritten meta tags, and
// JavaScript opened a lightbox over the grid. That works — the link is shareable
// and it converts — but it is not a page: no description in the HTML, no
// gallery, no delivery terms, and nothing a crawler can read as a product. To
// Google, every /p/<slug> is "the AswinPrints homepage with a different title".
//
// This renders a real document, server-side, so the content exists before any
// JavaScript runs.
//
// ── The constraint that shapes the whole layout ──────────────────────────────
//
// Of 59 products, ONE has extra images and the median description is 80
// characters. A full marketplace layout — gallery rail, long copy, spec table —
// would be an empty frame on 58 of them.
//
// So every optional block is genuinely optional: the thumbnail rail only exists
// when there are extra images, the description block only when there is a
// description. What holds the page together instead is a spec line that is true
// for every product (material, printer, delivery), so even the sparsest page
// reads as finished rather than unfinished.

import { esc, rupees } from "./lib.js";

const CATEGORY_LABEL = {
  figurine: "Figurines",
  decor: "Home Décor",
  functional: "Functional",
  set: "Sets",
};

const baseUrl = (env) =>
  String(env.APP_BASE_URL || "https://3d-prints.aswincloud.com").replace(/\/$/, "");

// Rupees for display. `rupees()` from lib.js already handles the Indian digit
// grouping every other surface uses, so prices read the same here as in the
// cart, the emails and the invoice.
const price = (paise) => rupees(paise);

// ── breadcrumbs ───────────────────────────────────────────────────
//
// Two jobs: a real navigation trail, and the BreadcrumbList structured data that
// turns a bare URL in a Google result into "Home › Figurines › Dragon".
//
// A product with no category still gets a valid two-level trail rather than
// "Home › undefined › Dragon". Ten products have no category today.
function breadcrumbs(env, product) {
  const base = baseUrl(env);
  const label = CATEGORY_LABEL[product.category];

  const trail = [{ name: "Home", url: base + "/" }];
  if (label) {
    // Links back to the filtered grid, which the homepage reads from the hash.
    trail.push({ name: label, url: `${base}/#shop` });
  }
  trail.push({ name: product.name, url: `${base}/p/${product.slug}` });
  return trail;
}

export function breadcrumbJsonLd(env, product) {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: breadcrumbs(env, product).map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: c.url,
    })),
  };
}

// ── the page ──────────────────────────────────────────────────────
export function renderProductPage(env, { product, related, headExtra = "" }) {
  const base = baseUrl(env);
  const trail = breadcrumbs(env, product);

  // A price of 0 means "not priced yet" — the same sentinel the grid and
  // priceCart use. Those products cannot be bought at all (priceCart refuses
  // them server-side), so the page must not offer a buy button it cannot honour.
  const quoteOnly = !(product.price_paise > 0);

  // The gallery. `images` is comma-separated; the primary image leads.
  const gallery = [product.image, ...String(product.images || "").split(",")]
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  const hasGallery = gallery.length > 1;

  const flatShip = Number(env.FLAT_SHIP_PAISE || 9900);
  const freeOver = Number(env.FREE_SHIP_THRESHOLD_PAISE || 200000);

  const crumbHtml = trail.map((c, i) =>
    i === trail.length - 1
      ? `<span aria-current="page">${esc(c.name)}</span>`
      : `<a href="${esc(c.url)}">${esc(c.name)}</a>`
  ).join('<span class="pdp-crumb-sep" aria-hidden="true">›</span>');

  const thumbs = hasGallery
    ? `<div class="pdp-thumbs" role="group" aria-label="Product photos">` +
      gallery.map((img, i) =>
        `<button type="button" class="pdp-thumb${i === 0 ? " is-active" : ""}"
                 data-full="/${esc(img)}" aria-label="Photo ${i + 1} of ${gallery.length}">
           <img src="/${esc(img)}" alt="" loading="lazy" width="80" height="80">
         </button>`
      ).join("") +
      `</div>`
    : "";

  // Buy controls, or a quote button when there is no price. Mirrors the grid so
  // the two surfaces cannot disagree about what is purchasable.
  const buyBlock = quoteOnly
    ? `<div class="pdp-price is-quote">Price on request</div>
       <div class="pdp-actions">
         <a class="pdp-btn pdp-btn-primary" href="${base}/#quote">Request a quote</a>
       </div>
       <p class="pdp-note">This piece isn't priced yet — ask and you'll get a
          quote, usually within 24–48 hours.</p>`
    : `<div class="pdp-price">${esc(price(product.price_paise))}</div>
       <div class="pdp-actions">
         <div class="pdp-qty">
           <button type="button" id="pdpMinus" aria-label="Decrease quantity">−</button>
           <input id="pdpQty" type="text" inputmode="numeric" value="1" aria-label="Quantity">
           <button type="button" id="pdpPlus" aria-label="Increase quantity">+</button>
         </div>
         <button type="button" class="pdp-btn pdp-btn-ghost" id="pdpAdd">Add to cart</button>
         <button type="button" class="pdp-btn pdp-btn-primary" id="pdpBuy">Buy now</button>
       </div>

       <!-- "Buy now" is ambiguous once the cart has other things in it: it could
            mean this one piece or the whole basket, and guessing wrong either
            overcharges or loses the rest of the order. So it asks. Rendered
            hidden and shown by product.js only when there IS something else in
            the cart — with an empty cart there is nothing to disambiguate. -->
       <div class="pdp-buychoice" id="pdpBuyChoice" hidden>
         <p id="pdpBuyChoiceText"></p>
         <div class="pdp-buychoice-btns">
           <button type="button" class="pdp-btn pdp-btn-ghost" id="pdpChoiceJustThis">Just this item</button>
           <button type="button" class="pdp-btn pdp-btn-primary" id="pdpChoiceEverything">Everything in cart</button>
         </div>
       </div>

       <p class="pdp-note"><a href="${base}/#quote">Want it in another colour or size? Ask for a quote</a></p>`;

  // Always present, for every product. This is what stops a page with one photo
  // and one line of text from looking unfinished.
  const specs = [
    ["Material", "PLA"],
    ["Printed on", "Bambu Lab A1"],
    CATEGORY_LABEL[product.category] ? ["Category", CATEGORY_LABEL[product.category]] : null,
    ["Made", "To order, in Pondicherry"],
    ["Delivery", `India-wide · flat ${price(flatShip)}, free over ${price(freeOver)}`],
  ].filter(Boolean);

  const relatedHtml = related.length
    ? `<section class="pdp-related">
         <h2>${CATEGORY_LABEL[product.category] ? `More in ${esc(CATEGORY_LABEL[product.category])}` : "More prints"}</h2>
         <div class="pdp-related-grid">` +
       related.map((r) => `
           <a class="pdp-rel-card" href="${base}/p/${esc(r.slug)}">
             <img src="/${esc(r.image)}" alt="${esc(r.name)}" loading="lazy" width="200" height="200">
             <span class="pdp-rel-name">${esc(r.name)}</span>
             <span class="pdp-rel-price">${r.price_paise > 0 ? esc(price(r.price_paise)) : "Price on request"}</span>
           </a>`).join("") +
       `</div>
       </section>`
    : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${headExtra}
  <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
  <link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48" />
  <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
  <link rel="manifest" href="/site.webmanifest" />
  <meta name="theme-color" content="#ff6b00" />
  <link rel="preconnect" href="https://fonts.googleapis.com" />
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet" />
  <link rel="stylesheet" href="/assets/css/style.css" />
  <link rel="stylesheet" href="/assets/css/pdp.css" />
</head>
<body class="pdp-body">

<nav>
  <a class="nav-logo" href="/">
    <svg width="32" height="32" viewBox="0 0 32 32" fill="none" xmlns="http://www.w3.org/2000/svg">
      <rect width="32" height="32" rx="8" fill="url(#lg)"/>
      <path d="M8 22V14l8-6 8 6v8M13 22v-5h6v5" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
      <defs><linearGradient id="lg" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
        <stop stop-color="#ff6b00"/><stop offset="1" stop-color="#ff8c38"/></linearGradient></defs>
    </svg>
    <span>AswinPrints</span>
  </a>
  <div class="nav-actions">
    <a href="/#shop" class="btn-secondary nav-back">All prints</a>
  </div>
</nav>

<main class="pdp-main">
  <nav class="pdp-crumbs" aria-label="Breadcrumb">${crumbHtml}</nav>

  <div class="pdp-top">
    <div class="pdp-media">
      <!-- Click to zoom. Grid clicks now navigate here instead of opening an
           overlay, so without this there is nowhere left to see a photo full
           size — the product page is the only place a close look still makes
           sense, and it is the place someone deciding to buy actually wants it. -->
      <button type="button" class="pdp-hero" id="pdpZoomOpen"
              aria-label="View ${esc(product.name)} full size">
        <img id="pdpHero" src="/${esc(product.image)}" alt="${esc(product.name)}" width="800" height="800">
        <span class="pdp-zoom-hint" aria-hidden="true">Click to enlarge</span>
      </button>
      ${thumbs}
    </div>

    <div class="pdp-info">
      <h1>${esc(product.name)}</h1>
      ${buyBlock}

      ${product.description
        ? `<div class="pdp-desc"><p>${esc(product.description)}</p></div>`
        : ""}

      <dl class="pdp-specs">
        ${specs.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join("")}
      </dl>
    </div>
  </div>

  ${relatedHtml}
</main>

<!-- Zoom overlay. Deliberately minimal: one image, a close button, and a
     backdrop that closes on click. The grid's lightbox carried prev/next and
     buy controls because it WAS the product view; here the page already has all
     of that, so the overlay only has to show the photo bigger. -->
<div class="pdp-zoom" id="pdpZoom" hidden role="dialog" aria-modal="true"
     aria-label="${esc(product.name)} full size">
  <button type="button" class="pdp-zoom-close" id="pdpZoomClose" aria-label="Close">✕</button>
  <img id="pdpZoomImg" src="" alt="${esc(product.name)}">
</div>

<footer class="pdp-footer">
  <div class="pdp-footer-links">
    <a href="/3d-printing-in-pondicherry">3D Printing in Pondicherry</a>
    <a href="/shipping">Shipping &amp; Exchange</a>
    <a href="/refunds">Cancellation &amp; Refunds</a>
    <a href="/contact">Contact Us</a>
  </div>
  <p>© 2026 AswinPrints · Pondicherry, India</p>
</footer>

<script src="/assets/js/product.js" defer></script>
<script src="/assets/js/chat.js" defer></script>
</body>
</html>`;
}
