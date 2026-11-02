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
    <section class="ks-hero" aria-labelledby="ksTitle">
      <h1 id="ksTitle" class="ks-title">Your name,<br>ten ways.</h1>
      <p class="ks-lede">Type it once. Every keychain below redraws with your name, so you can pick the one you like best. Printed to order in Pondicherry, free shipping across India.</p>
      <label class="ks-name-label" for="kcText">Your name or text <span id="kcCount" class="ks-count"></span></label>
      <div class="ks-name">
        <input id="kcText" class="ks-input" autocomplete="off" autocapitalize="words" spellcheck="false" placeholder="Type a name" maxlength="16">
      </div>
      <p id="kcError" class="ks-error" role="status" aria-live="polite"></p>
      <p class="ks-price-line">${r(PRICE_ONE_PAISE)} in one colour · ${r(PRICE_TWO_PAISE)} in two or three</p>
    </section>

    <section class="ks-gallery" aria-label="Keychain styles">
      <div id="kcGallery" class="ks-grid"></div>
    </section>

    <section id="studio" class="ks-studio" aria-labelledby="ksStudioTitle">
      <div class="ks-stage">
        <div id="kcCanvas" class="ks-canvas" role="img" aria-label="3D preview of your keychain. Drag to rotate."></div>
        <p class="ks-hint">Drag to turn it · shown to scale</p>
      </div>
      <div class="ks-panel">
        <h2 id="ksStudioTitle" class="ks-h2"><span id="kcStyleName">Heart tag</span></h2>
        <p class="ks-panel-sub">Fine-tune it here. <a href="#kcGallery" class="ks-back">See all ten styles</a></p>
        <p class="ks-label">Style</p>
        <div id="kcStyles" class="ks-chips" role="group" aria-label="Style"></div>
        <p class="ks-label">Font</p>
        <div id="kcFonts" class="ks-fonts" role="group" aria-label="Font"></div>
        <p class="ks-label">Base colour</p>
        <div id="kcBase" class="ks-swatches" role="group" aria-label="Base colour"></div>
        <label class="ks-check"><input type="checkbox" id="kcTwoTone"> More than one colour <span class="ks-extra">+${r(PRICE_TWO_PAISE - PRICE_ONE_PAISE)}</span></label>
        <div id="kcInkRow" hidden><p class="ks-label">Text colour</p><div id="kcInk" class="ks-swatches" role="group" aria-label="Text colour"></div></div>
        <div id="kcAccentRow" hidden><p class="ks-label" id="kcAccentLabel">Accent colour</p><div id="kcAccent" class="ks-swatches" role="group" aria-labelledby="kcAccentLabel"></div></div>
        <div class="ks-buy">
          <p class="ks-buy-price"><span id="kcPrice" class="ks-price"></span> <span id="kcPriceNote" class="ks-note"></span></p>
          <p id="kcSummary" class="ks-summary"></p>
          <div class="ks-actions">
            <button id="kcAdd" type="button" class="ks-btn ks-btn-ghost">Add to cart</button>
            <button id="kcBuy" type="button" class="ks-btn">Buy now</button>
          </div>
          <p id="kcAdded" class="ks-added" role="status" hidden>Added to your cart. <a href="/#cart">View cart</a> or design another.</p>
        </div>
      </div>
    </section>

    <section class="ks-how" aria-labelledby="ksHowTitle">
      <h2 id="ksHowTitle" class="ks-h2">From your screen to your keys</h2>
      <ol class="ks-steps">
        <li><strong>You design it.</strong> Name, style, font and up to three colours, checked in 3D before you pay.</li>
        <li><strong>We print it in Pondicherry.</strong> Layer by layer in PLA, usually within two working days.</li>
        <li><strong>It ships free.</strong> Anywhere in India, with tracking on <a href="/track">your order page</a>.</li>
      </ol>
      <p class="ks-limit">Up to ${MAX_TEXT} characters: letters, numbers, spaces and &amp; . - ' !</p>
    </section>
    <script type="module" src="/assets/js/keychain.js"></script>`
    : `<section class="ks-hero"><h1 class="ks-title">Custom keychains</h1><p class="ks-lede">The keychain designer isn't available right now. <a href="/#shop">Browse the shop</a>.</p></section>`;

  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Design your name keychain — AswinPrints</title>
<meta name="description" content="Design a custom 3D-printed name keychain: type your text, choose a font and colours, and see a live 3D preview. ${r(PRICE_ONE_PAISE)}, shipped free across India.">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Baloo+2:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap">
<link rel="stylesheet" href="/assets/css/keychain.css">
</head><body><header class="ks-top"><a class="ks-home" href="/">AswinPrints</a><nav class="ks-nav" aria-label="Keychain studio"><a class="ks-pill" href="/#shop">Shop</a><a class="ks-pill ks-cart" href="/#cart">Cart</a></nav></header>
<main>${body}</main>
<script src="/assets/js/activity.js" defer></script>
</body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" } });
}
