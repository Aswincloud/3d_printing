// GET /keychain — the custom name keychain designer (2026-11-02). The page is
// static HTML; the designer itself is public/assets/js/keychain.js (an ES
// module, loaded from this site only — the CSP allows no third-party script).
// Served by the Worker so it carries the security headers and can show the
// live keychain price and image from the product row.
import { KEYCHAIN_SLUG, PRICE_ONE_PAISE, PRICE_TWO_PAISE, MAX_TEXT } from "./keychain.js";

export async function keychainPage(env) {
  const row = await env.DB.prepare(`SELECT name FROM products WHERE slug = ? AND visible = 1 AND price_paise > 0`)
    .bind(KEYCHAIN_SLUG).first();
  const available = Boolean(row);
  const r = (p) => "₹" + (p / 100).toLocaleString("en-IN");
  const body = available ? `
    <div class="kc-wrap">
      <div class="kc-stage"><div id="kcCanvas" class="kc-canvas" role="img" aria-label="3D preview of your keychain. Drag to rotate."></div>
        <p class="kc-hint">Drag to rotate · preview, not to exact scale</p></div>
      <div class="kc-panel">
        <h1>Design your name keychain</h1>
        <p class="kc-sub">Type a name, pick a font and colours, and see it in 3D. Printed to order in Pondicherry.</p>
        <label class="kc-label" for="kcText">Your text <span id="kcCount" class="kc-count"></span></label>
        <input id="kcText" class="kc-input" autocomplete="off" autocapitalize="characters" spellcheck="false" placeholder="e.g. ASWIN">
        <p id="kcError" class="kc-error" role="status" aria-live="polite"></p>
        <p class="kc-label">Font</p>
        <div id="kcFonts" class="kc-fonts" role="group" aria-label="Font"></div>
        <p class="kc-label">Base colour</p>
        <div id="kcBase" class="kc-swatches" role="group" aria-label="Base colour"></div>
        <label class="kc-check"><input type="checkbox" id="kcTwoTone"> Text in a different colour <span class="kc-extra">(+${r(PRICE_TWO_PAISE - PRICE_ONE_PAISE)})</span></label>
        <div id="kcInkRow" hidden><p class="kc-label">Text colour</p><div id="kcInk" class="kc-swatches" role="group" aria-label="Text colour"></div></div>
        <div class="kc-buy">
          <div><span id="kcPrice" class="kc-price"></span> <span id="kcPriceNote" class="kc-note"></span></div>
          <p id="kcSummary" class="kc-summary"></p>
          <div class="kc-actions">
            <button id="kcAdd" type="button" class="kc-btn kc-btn-ghost">Add to cart</button>
            <button id="kcBuy" type="button" class="kc-btn">Buy now</button>
          </div>
          <p id="kcAdded" class="kc-added" role="status" hidden>Added to your cart. <a href="/#cart">View cart</a> or design another.</p>
        </div>
        <p class="kc-small">${r(PRICE_ONE_PAISE)} in one colour, ${r(PRICE_TWO_PAISE)} with the text in a second colour. Up to ${MAX_TEXT} characters. Free shipping across India.</p>
      </div>
    </div>
    <script type="module" src="/assets/js/keychain.js"></script>`
    : `<h1>Custom keychains</h1><p>The keychain designer isn't available right now. <a href="/#shop">Browse the shop</a>.</p>`;

  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Design your name keychain — AswinPrints</title>
<meta name="description" content="Design a custom 3D-printed name keychain: type your text, choose a font and colours, and see a live 3D preview. ${r(PRICE_ONE_PAISE)}, shipped free across India.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/css/keychain.css">
</head><body><header class="kc-top"><a class="kc-home" href="/">← AswinPrints</a><a class="kc-cart" href="/#cart">Cart</a></header>
<main>${body}</main>
<script src="/assets/js/activity.js" defer></script>
</body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" } });
}
