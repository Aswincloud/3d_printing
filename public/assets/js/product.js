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
// Adds to the cart and hands off to the homepage, which owns the checkout modal
// and the whole Razorpay flow. Duplicating that here would mean two
// implementations of the payment path — the one thing in this codebase that
// must have exactly one.
//
// #checkout is read by main.js on load to open the modal straight away.
el('pdpBuy')?.addEventListener('click', async (e) => {
  const btn = e.currentTarget;
  btn.disabled = true;
  btn.textContent = 'Opening…';
  const ok = await addToCart(readQty());
  if (!ok) {
    btn.textContent = 'Try again';
    btn.disabled = false;
    return;
  }
  location.href = '/#checkout';
});
