/* Customer account: order history (read-only), cart, profile.
 *
 * Everything from the API is rendered with textContent or created as a DOM node.
 * The values here are the customer's own, but order notes are admin-editable, so
 * innerHTML interpolation would still be a stored-XSS path. */

const $ = (id) => document.getElementById(id);

const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;
  return n;
};

const rupees = (paise) =>
  '₹' + (Math.round(Number(paise) || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });

const when = (ms) => {
  if (!ms) return '—';
  const d = new Date(Number(ms));
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });
};

let catalogue = [];

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts });
  if (res.status === 401) {
    // Session lapsed. Send them to sign in and come back here afterwards.
    location.href = '/login?next=/account';
    throw new Error('Signed out');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function flash(message, isError = false) {
  const okBox = $('accountOk');
  const errBox = $('accountError');
  okBox.hidden = true; errBox.hidden = true;
  if (!message) return;
  const box = isError ? errBox : okBox;
  box.textContent = message;
  box.hidden = false;
  if (!isError) setTimeout(() => { box.hidden = true; }, 4000);
}

/* ── boot ──────────────────────────────────────────────────────── */
async function boot() {
  let me;
  try {
    me = await (await fetch('/api/me')).json();
  } catch {
    me = { signedIn: false };
  }

  if (!me.signedIn) {
    $('guestPanel').hidden = false;
    $('accountMain').hidden = true;
    return;
  }

  $('guestPanel').hidden = true;
  $('accountMain').hidden = false;
  $('signOutBtn').hidden = false;
  const who = $('accountWho');
  who.textContent = me.name || me.email;
  who.hidden = false;
  $('profileEmail').value = me.email;
  $('profileName').value = me.name || '';

  // Owner? Offer the dashboard. This only shows a link — /api/admin/* re-checks
  // the allowlist itself, so the flag can't grant anything.
  if (me.is_admin) {
    const link = el('a', 'admin-btn', 'Dashboard →');
    link.href = '/shop';
    $('accountWho').insertAdjacentElement('beforebegin', link);
  }

  // If a merge failed during sign-in, localStorage still holds a guest cart.
  // Reconcile it now rather than leaving it stranded.
  await reconcileGuestCart();

  catalogue = await loadCatalogue();
  await Promise.all([loadMyOrders(), loadMyCart()]);
}

async function loadCatalogue() {
  try {
    return (await (await fetch('/api/products')).json()).products || [];
  } catch {
    return [];
  }
}

async function reconcileGuestCart() {
  let raw;
  try {
    raw = JSON.parse(localStorage.getItem('ap_cart') || '[]');
  } catch { raw = []; }
  if (!Array.isArray(raw) || !raw.length) return;

  const items = raw
    .filter((x) => x && typeof x.id === 'string')
    .map((x) => ({ product_id: x.id, qty: parseInt(x.qty, 10) || 1 }));
  if (!items.length) { localStorage.removeItem('ap_cart'); return; }

  try {
    await api('/api/me/cart/merge', { method: 'POST', body: JSON.stringify({ items }) });
    localStorage.removeItem('ap_cart');
  } catch { /* try again next load */ }
}

/* ── orders ────────────────────────────────────────────────────── */
async function loadMyOrders() {
  const box = $('myOrdersList');
  box.innerHTML = '';
  try {
    const { orders } = await api('/api/me/orders');
    if (!orders.length) {
      box.appendChild(el('p', 'admin-muted', "You haven't placed any orders yet."));
      const link = el('a', 'admin-link', 'Browse the shop →');
      link.href = '/#shop';
      box.appendChild(link);
      return;
    }
    for (const o of orders) box.appendChild(orderCard(o));
  } catch (e) {
    box.appendChild(el('p', 'admin-muted', e.message));
  }
}

// Read-only by design: there is no control here that mutates an order. Status
// changes and refunds are the owner's, via the dashboard.
function orderCard(o) {
  const card = el('div', 'order-card');

  const top = el('div', 'order-top');
  const ref = el('div', 'order-ref');
  ref.append(document.createTextNode(o.receipt));
  ref.appendChild(el('span', 'badge badge-' + o.status, o.status));
  ref.appendChild(el('span', 'order-date', when(o.created_at)));
  top.append(ref, el('div', 'order-amount', rupees(o.total_paise)));
  card.appendChild(top);

  const items = el('ul', 'order-items');
  for (const it of o.items || []) {
    const li = el('li');
    li.append(
      el('span', null, `${it.name} × ${it.qty}`),
      el('strong', null, rupees(it.price_paise * it.qty)),
    );
    items.appendChild(li);
  }
  card.appendChild(items);

  const grid = el('dl', 'order-grid');
  const pair = (label, value) => {
    if (!value) return;
    const cell = el('div', 'order-pair');
    cell.append(el('dt', null, label), el('dd', null, value));
    grid.appendChild(cell);
  };
  pair('Delivery', o.delivery === 'pickup' ? 'Local pickup' : 'Shipping');
  pair('Shipping', o.shipping_paise === 0 ? 'Free' : rupees(o.shipping_paise));
  pair('Paid', o.paid_at ? when(o.paid_at) : null);
  pair('Shipped', o.shipped_at ? when(o.shipped_at) : null);
  pair('Note', o.notes);
  card.appendChild(grid);

  return card;
}

/* ── cart ──────────────────────────────────────────────────────── */
async function loadMyCart() {
  const box = $('myCartList');
  box.innerHTML = '';
  try {
    const { items } = await api('/api/me/cart');
    const lines = items
      .map((it) => ({ it, p: catalogue.find((c) => c.id === it.product_id) }))
      .filter((r) => r.p);

    if (!lines.length) {
      box.appendChild(el('p', 'admin-muted', 'Your cart is empty.'));
      $('myCartFoot').hidden = false;
      return;
    }

    let subtotal = 0;
    for (const { it, p } of lines) {
      subtotal += p.price_paise * it.qty;
      box.appendChild(cartRow(it, p));
    }

    const total = el('div', 'order-card');
    const row = el('div', 'order-top');
    row.append(el('div', 'order-ref', 'Subtotal'), el('div', 'order-amount', rupees(subtotal)));
    total.appendChild(row);
    total.appendChild(el('p', 'admin-muted',
      'Shipping is calculated at checkout. Final price is confirmed by the server.'));
    box.appendChild(total);
    $('myCartFoot').hidden = false;
  } catch (e) {
    box.appendChild(el('p', 'admin-muted', e.message));
  }
}

function cartRow(it, p) {
  const row = el('div', 'product-row');

  const img = document.createElement('img');
  img.src = p.image;
  img.alt = '';
  img.loading = 'lazy';
  row.appendChild(img);

  const info = el('div', 'pr-info');
  info.append(el('div', 'pr-name', p.name), el('div', 'pr-slug', rupees(p.price_paise) + ' each'));
  row.appendChild(info);

  const qtyWrap = el('div', 'cart-qty');
  const minus = el('button', null, '−');
  minus.type = 'button';
  minus.setAttribute('aria-label', 'Decrease quantity of ' + p.name);
  minus.addEventListener('click', () => changeQty(it.product_id, it.qty - 1));
  const n = el('span', null, String(it.qty));
  const plus = el('button', null, '+');
  plus.type = 'button';
  plus.setAttribute('aria-label', 'Increase quantity of ' + p.name);
  plus.addEventListener('click', () => changeQty(it.product_id, it.qty + 1));
  qtyWrap.append(minus, n, plus);
  row.appendChild(qtyWrap);

  const lineTotal = el('div', 'pr-info');
  lineTotal.appendChild(el('div', 'pr-name', rupees(p.price_paise * it.qty)));
  row.appendChild(lineTotal);

  const actions = el('div', 'pr-actions');
  const remove = el('button', 'admin-btn-ghost', 'Remove');
  remove.type = 'button';
  remove.addEventListener('click', () => changeQty(it.product_id, 0));
  actions.appendChild(remove);
  row.appendChild(actions);

  return row;
}

// The whole cart is PUT back, which is what the endpoint expects and avoids
// per-line patch semantics.
async function changeQty(productId, qty) {
  try {
    const { items } = await api('/api/me/cart');
    const next = items
      .map((it) => (it.product_id === productId ? { ...it, qty } : it))
      .filter((it) => it.qty > 0);
    await api('/api/me/cart', { method: 'PUT', body: JSON.stringify({ items: next }) });
    await loadMyCart();
  } catch (e) {
    flash(e.message, true);
  }
}

/* ── profile ───────────────────────────────────────────────────── */
$('profileForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('saveProfileBtn');
  btn.disabled = true;
  try {
    const out = await api('/api/me', {
      method: 'PATCH',
      body: JSON.stringify({ name: $('profileName').value.trim() }),
    });
    $('accountWho').textContent = out.name || $('profileEmail').value;
    flash('Saved.');
  } catch (err) {
    flash(err.message, true);
  } finally {
    btn.disabled = false;
  }
});

$('signOutBtn')?.addEventListener('click', async () => {
  try { await api('/api/me/logout', { method: 'POST' }); } catch { /* ignore */ }
  location.href = '/';
});

/* ── tabs ──────────────────────────────────────────────────────── */
function selectTab(which) {
  const map = {
    orders: ['tabMyOrders', 'myOrdersPanel'],
    cart: ['tabMyCart', 'myCartPanel'],
    profile: ['tabProfile', 'profilePanel'],
  };
  for (const [key, [tabId, panelId]] of Object.entries(map)) {
    const active = key === which;
    $(tabId).classList.toggle('active', active);
    $(tabId).setAttribute('aria-selected', String(active));
    $(panelId).hidden = !active;
  }
}

$('tabMyOrders')?.addEventListener('click', () => selectTab('orders'));
$('tabMyCart')?.addEventListener('click', () => selectTab('cart'));
$('tabProfile')?.addEventListener('click', () => selectTab('profile'));

boot();
