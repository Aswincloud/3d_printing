/* Product detail page — the small amount of interactivity a static page needs.
 *
 * Deliberately NOT main.js. That file is 2,287 lines built around the homepage:
 * the grid, filters, lightbox, cart drawer, checkout modal and Razorpay flow.
 * A product page needs four things — swap the photo, change a quantity, add to
 * the cart, and hand off to checkout — and loading the whole homepage script to
 * get them would mean every product page carries code for a grid it does not
 * have.
 *
 * What it MUST share is the cart contract. The key, the shape and the quantity
 * cap are duplicated here as constants because there is no module system on
 * these pages; they are marked so a change to one is a change to both.
 */

// ── the cart contract, shared with main.js ────────────────────────
// MUST match main.js:442-443 and MAX_QTY in src/shop.js. If these drift, an item
// added here becomes invisible or over-quantity in the drawer.
const CART_KEY = 'ap_cart';
const MAX_QTY = 100;

function readCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
    // Same normalisation main.js does: coalesce duplicate ids and clamp, so a
    // hand-edited localStorage cannot produce a cart the server will reject.
    const seen = new Map();
    for (const it of raw) {
      const id = typeof it?.id === 'string' ? it.id : '';
      const qty = parseInt(it?.qty, 10);
      if (!id || !Number.isFinite(qty) || qty < 1) continue;
      seen.set(id, Math.min(MAX_QTY, (seen.get(id) || 0) + qty));
    }
    return [...seen].map(([id, qty]) => ({ id, qty }));
  } catch {
    return [];
  }
}

function writeCart(cart) {
  try {
    localStorage.setItem(CART_KEY, JSON.stringify(cart));
  } catch { /* private mode, quota — the add just does not persist */ }
}

// ── page state ────────────────────────────────────────────────────
const el = (id) => document.getElementById(id);

// The product id is not in the markup — the page is rendered from a slug, and
// the cart keys on id. Fetched once from the catalogue, which is already cached
// at the edge, rather than embedding an id in the HTML that could go stale
// against a re-created product.
let productId = null;
const slug = location.pathname.startsWith('/p/')
  ? decodeURIComponent(location.pathname.slice(3)).replace(/\/+$/, '')
  : '';

async function resolveProductId() {
  if (productId || !slug) return productId;
  try {
    const res = await fetch('/api/products');
    if (!res.ok) return null;
    const data = await res.json();
    const hit = (data.products || []).find((p) => p.slug === slug);
    productId = hit?.id || null;
  } catch { /* offline; the buttons report failure below */ }
  return productId;
}

// Warm it up so the first click does not wait on a round trip.
resolveProductId();

// ── gallery ───────────────────────────────────────────────────────
// Only present when a product has more than one image, which is one product of
// 59 today — hence the null guard rather than an assumption.
for (const thumb of document.querySelectorAll('.pdp-thumb')) {
  thumb.addEventListener('click', () => {
    const hero = el('pdpHero');
    if (!hero) return;
    hero.src = thumb.dataset.full;
    for (const t of document.querySelectorAll('.pdp-thumb')) t.classList.remove('is-active');
    thumb.classList.add('is-active');
  });
}

// ── zoom ──────────────────────────────────────────────────────────
//
// Grid clicks navigate to this page now instead of opening the old lightbox, so
// this is the only place left to see a photo full size. Kept minimal on purpose:
// the grid's lightbox carried prev/next and buy controls because it WAS the
// product view, and this page already has all of that.
const zoom = el('pdpZoom');
const zoomImg = el('pdpZoomImg');

function openZoom() {
  const hero = el('pdpHero');
  if (!zoom || !zoomImg || !hero) return;
  zoomImg.src = hero.src;
  zoom.hidden = false;
  // Stop the page behind from scrolling under the overlay.
  document.body.style.overflow = 'hidden';
  el('pdpZoomClose')?.focus();
}

function closeZoom() {
  if (!zoom) return;
  zoom.hidden = true;
  document.body.style.overflow = '';
  // Return focus to what opened it, or a keyboard user is dumped at the top of
  // the document with no idea where they were.
  el('pdpZoomOpen')?.focus();
}

el('pdpZoomOpen')?.addEventListener('click', openZoom);
el('pdpZoomClose')?.addEventListener('click', closeZoom);

// Click the backdrop to close, but not the photo itself — clicking the thing you
// just asked to see closing it is a small, constant annoyance.
zoom?.addEventListener('click', (e) => {
  if (e.target === zoom) closeZoom();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && zoom && !zoom.hidden) closeZoom();
});

// ── quantity ──────────────────────────────────────────────────────
const qtyInput = el('pdpQty');
const readQty = () => {
  const n = parseInt(qtyInput?.value, 10);
  return Number.isFinite(n) && n >= 1 ? Math.min(MAX_QTY, n) : 1;
};
const setQty = (n) => { if (qtyInput) qtyInput.value = String(Math.min(MAX_QTY, Math.max(1, n))); };

el('pdpMinus')?.addEventListener('click', () => setQty(readQty() - 1));
el('pdpPlus')?.addEventListener('click', () => setQty(readQty() + 1));
// Normalise on blur so a pasted "abc" or "999" becomes something the cart can
// hold, rather than silently reverting at add time.
qtyInput?.addEventListener('blur', () => setQty(readQty()));

// ── add to cart ───────────────────────────────────────────────────
async function addToCart(qty) {
  const id = await resolveProductId();
  if (!id) return false;

  const cart = readCart();
  const line = cart.find((it) => it.id === id);
  if (line) line.qty = Math.min(MAX_QTY, line.qty + qty);
  else cart.push({ id, qty });
  writeCart(cart);
  return true;
}

const addBtn = el('pdpAdd');
addBtn?.addEventListener('click', async () => {
  const label = addBtn.textContent;
  addBtn.disabled = true;
  const ok = await addToCart(readQty());
  if (!ok) {
    addBtn.textContent = 'Could not add';
    setTimeout(() => { addBtn.textContent = label; addBtn.disabled = false; }, 1600);
    return;
  }
  addBtn.textContent = 'Added ✓';
  addBtn.classList.add('is-done');
  setTimeout(() => {
    addBtn.textContent = label;
    addBtn.classList.remove('is-done');
    addBtn.disabled = false;
  }, 1400);
});

// ── buy now ───────────────────────────────────────────────────────
//
// Checkout and the whole Razorpay flow live in main.js, so this hands off to the
// homepage rather than reimplementing them — the payment path is the one thing
// in this codebase that must have exactly one implementation.
//
// What it must NOT do is flatten the two meanings of "buy now". With an empty
// cart it is unambiguous. With other things in the cart it could mean this one
// piece or the whole basket, and guessing wrong either overcharges someone or
// silently drops the rest of their order, so the customer is asked. The grid
// lightbox has asked that question since the shop launched; a product page that
// just added-and-charged-everything would be a regression in the checkout path,
// which is the worst place in the site to have one.
//
// BUY_NOW_KEY is how "just this" survives the navigation. sessionStorage rather
// than a URL parameter: the intent is single-use and tab-local, and a URL
// carrying item ids would be shareable, bookmarkable and forgeable. Being
// client-side changes no threat model — priceCart prices whatever ids the
// payload carries, server-side, exactly as it does for the cart itself.
const BUY_NOW_KEY = 'ap_buynow';

function handOffToCheckout(items) {
  if (items) {
    try {
      sessionStorage.setItem(BUY_NOW_KEY, JSON.stringify(items));
    } catch {
      // Private mode or quota. Falling through would charge for the whole cart
      // when the customer asked for one item, so refuse rather than overcharge.
      return false;
    }
  }
  location.href = '/#checkout';
  return true;
}

const buyBtn = el('pdpBuy');
const choiceBox = el('pdpBuyChoice');

function closeChoice() {
  if (choiceBox) choiceBox.hidden = true;
  if (buyBtn) { buyBtn.disabled = false; buyBtn.textContent = 'Buy now'; }
}

buyBtn?.addEventListener('click', async () => {
  const id = await resolveProductId();
  if (!id) {
    buyBtn.textContent = 'Try again';
    return;
  }
  const qty = readQty();
  const others = readCart().filter((it) => it.id !== id);

  if (!others.length) {
    // Nothing to confuse it with: add and check the cart out, one code path,
    // same as the cart button.
    buyBtn.disabled = true;
    buyBtn.textContent = 'Opening…';
    if (!(await addToCart(qty))) { closeChoice(); buyBtn.textContent = 'Try again'; return; }
    handOffToCheckout(null);
    return;
  }

  const otherCount = others.reduce((n, it) => n + it.qty, 0);
  const text = el('pdpBuyChoiceText');
  if (text) {
    text.textContent = `Your cart already has ${otherCount} other item` +
      (otherCount === 1 ? '' : 's') + '. Check out just this one, or all ' +
      (otherCount + qty) + '?';
  }
  if (choiceBox) {
    choiceBox.hidden = false;
    // Scroll it to the middle of the viewport, for two reasons found by measuring
    // at 390px rather than by guessing.
    //
    // The chat bubble is fixed to the bottom-right at z-index 2147483000 and is
    // 64px square. At 390px the prompt rendered exactly there, and the bubble
    // covered the label of "Everything in cart" — the more expensive of the two
    // options, which is the worst one to obscure. Out-z-indexing a third-party
    // widget at that value is not a fight worth having; moving the question away
    // from the corner it squats in costs nothing.
    //
    // And the prompt can open below the fold on a small screen, which would look
    // like the button had simply done nothing.
    choiceBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
  el('pdpChoiceJustThis')?.focus();
});

el('pdpChoiceJustThis')?.addEventListener('click', async () => {
  const id = await resolveProductId();
  if (!id) return;
  if (choiceBox) choiceBox.hidden = true;
  // The cart is left exactly as it was. Deliberately does NOT call addToCart:
  // adding then charging only that line would leave the item sitting in the cart
  // after it had already been paid for.
  if (!handOffToCheckout([{ id, qty: readQty() }])) {
    if (buyBtn) buyBtn.textContent = 'Try again';
  }
});

el('pdpChoiceEverything')?.addEventListener('click', async () => {
  if (choiceBox) choiceBox.hidden = true;
  if (buyBtn) { buyBtn.disabled = true; buyBtn.textContent = 'Opening…'; }
  if (!(await addToCart(readQty()))) {
    closeChoice();
    if (buyBtn) buyBtn.textContent = 'Try again';
    return;
  }
  handOffToCheckout(null);
});

// Escape and a click outside dismiss the question without choosing, so it is not
// a trap. Merged into the zoom keydown handler below would couple two unrelated
// overlays; a separate listener is fine here because they are never both open.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && choiceBox && !choiceBox.hidden) closeChoice();
});
