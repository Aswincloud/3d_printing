/* Dashboard behaviour.
 *
 * Every value that comes back from the API is rendered with textContent or
 * created as a DOM node — never interpolated into innerHTML. That matters more
 * here than on the public site: this page displays customer-supplied strings
 * (names, addresses, order notes) to the one person whose session can issue
 * refunds, so a stored-XSS here would be a privilege-escalation bug. */

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
  return d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) +
    ' ' + d.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
};

/* ── api ───────────────────────────────────────────────────────── */
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
  });
  // A 401 means the session lapsed or OWNER_EMAIL changed. Drop straight back
  // to the sign-in panel rather than showing half a dashboard.
  if (res.status === 401) {
    showSignin();
    throw new Error('Your session has expired. Please sign in again.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function flash(message, isError = false) {
  const okBox = $('adminOk');
  const errBox = $('adminError');
  okBox.hidden = true;
  errBox.hidden = true;
  const box = isError ? errBox : okBox;
  box.textContent = message;
  box.hidden = false;
  if (!isError) setTimeout(() => { box.hidden = true; }, 4000);
  box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

/* ── auth ──────────────────────────────────────────────────────── */
const AUTH_MESSAGES = {
  denied: "That account isn't an owner of this shop.",
  state: 'Sign-in expired or was tampered with. Please try again.',
  config: 'Sign-in is not configured on this deployment yet.',
};

function showSignin() {
  $('signinPanel').hidden = false;
  $('adminMain').hidden = true;
  $('signOutBtn').hidden = true;
  $('adminWho').hidden = true;
}

async function boot() {
  // Surface ?auth=… from the OAuth redirect, then strip it so a refresh doesn't
  // re-show a stale error.
  const params = new URLSearchParams(location.search);
  const authFlag = params.get('auth');
  if (authFlag && authFlag !== 'ok') {
    const box = $('signinError');
    box.textContent = AUTH_MESSAGES[authFlag] || 'Sign-in failed. Please try again.';
    box.hidden = false;
  }
  if (authFlag) history.replaceState({}, '', location.pathname);

  let me;
  try {
    me = await api('/api/auth/me');
  } catch {
    showSignin();
    await loadProviders();
    return;
  }

  if (!me.signedIn) {
    showSignin();
    await loadProviders();
    if (!me.configured) {
      const box = $('signinError');
      box.textContent = AUTH_MESSAGES.config;
      box.hidden = false;
    }
    return;
  }

  $('signinPanel').hidden = true;
  $('adminMain').hidden = false;
  $('signOutBtn').hidden = false;
  const who = $('adminWho');
  who.textContent = me.email;
  who.hidden = false;

  await Promise.all([loadStats(), loadOrders(), loadProducts(), loadCoupons()]);
}

async function loadProviders() {
  const box = $('signinProviders');
  box.innerHTML = '';
  let list = [];
  try {
    list = (await (await fetch('/api/auth/providers')).json()).providers || [];
  } catch { /* leave empty */ }

  if (!list.length) {
    // Shouldn't happen now the broker knows this site, but if it ever returns an
    // empty list the email-code route on the main page reaches the same
    // allowlist check. There is no /login page any more — sign-in is a modal
    // there, so just send them home.
    box.appendChild(el('p', 'admin-muted',
      'OAuth sign-in is unavailable. Sign in from the main page instead.'));
    const a = el('a', 'provider-btn', 'Go to the shop');
    a.href = '/';
    box.appendChild(a);
    return;
  }
  for (const prov of list) {
    const id = String(prov.id || '');
    if (!/^[a-z]+$/.test(id)) continue;   // the id goes into a URL path
    const a = el('a', 'provider-btn', 'Continue with ' + (prov.name || id));
    a.href = '/api/auth/login/' + id;
    box.appendChild(a);
  }
}

$('signOutBtn')?.addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  location.reload();
});

/* ── stats ─────────────────────────────────────────────────────── */
async function loadStats() {
  const row = $('statRow');
  try {
    const s = await api('/api/admin/stats');
    row.innerHTML = '';
    const card = (label, value, accent) => {
      const c = el('div', 'stat-card' + (accent ? ' accent' : ''));
      c.append(el('div', 'stat-label', label), el('div', 'stat-value', value));
      row.appendChild(c);
    };
    card('Revenue', rupees(s.revenue_paise), true);
    card('Paid orders', String(s.paid_orders));
    card('Pending', String(s.pending_orders));
    card('Listed', `${s.products_visible}/${s.products_total}`);
  } catch (e) {
    row.innerHTML = '';
    row.appendChild(el('p', 'admin-muted', e.message));
  }
}

/* ── orders ────────────────────────────────────────────────────── */
async function loadOrders() {
  const box = $('ordersList');
  const status = $('orderFilter').value;
  box.innerHTML = '';
  box.appendChild(el('p', 'admin-muted', 'Loading…'));

  let data;
  try {
    data = await api('/api/admin/orders' + (status ? `?status=${encodeURIComponent(status)}` : ''));
  } catch (e) {
    box.innerHTML = '';
    box.appendChild(el('p', 'admin-muted', e.message));
    return;
  }

  box.innerHTML = '';
  if (!data.orders.length) {
    box.appendChild(el('p', 'admin-muted', status ? `No ${status} orders.` : 'No orders yet.'));
    return;
  }
  for (const o of data.orders) box.appendChild(orderCard(o));
}

function orderCard(o) {
  const card = el('div', 'order-card');

  const top = el('div', 'order-top');
  const ref = el('div', 'order-ref');
  ref.append(document.createTextNode(o.receipt));
  const badge = el('span', 'badge badge-' + o.status, o.status);
  ref.appendChild(badge);
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
  // Wrap each pair so the grid keeps a label with its own value — see the
  // .order-pair note in admin.css.
  const pair = (label, value) => {
    if (!value) return;
    const cell = el('div', 'order-pair');
    cell.append(el('dt', null, label), el('dd', null, value));
    grid.appendChild(cell);
  };
  pair('Customer', o.cust_name);
  pair('Email', o.cust_email);
  pair('Phone', o.cust_phone);
  // Only shown for the legacy value: pickup is no longer offered, so on every new
  // order this row would just say "Ship" on every line. Still rendered when an old
  // row has it, rather than hiding information that is actually in the database.
  if (o.delivery === 'pickup') pair('Delivery', 'Local pickup (legacy)');
  if (o.delivery !== 'pickup') {
    pair('Address', [o.addr_line, o.addr_city, o.addr_state, o.addr_pin].filter(Boolean).join(', '));
  }
  pair('Shipping', rupees(o.shipping_paise));
  pair('Payment id', o.rzp_payment_id);
  pair('Paid at', o.paid_at ? when(o.paid_at) : null);
  pair('Shipped at', o.shipped_at ? when(o.shipped_at) : null);
  pair('Notes', o.notes);
  card.appendChild(grid);

  const actions = el('div', 'order-actions');

  if (o.status === 'paid') {
    actions.appendChild(actionBtn('Mark shipped', 'admin-btn', async () => {
      await api(`/api/admin/orders/${o.id}`, {
        method: 'PATCH', body: JSON.stringify({ status: 'shipped' }),
      });
      flash(`${o.receipt} marked shipped.`);
      await Promise.all([loadOrders(), loadStats()]);
    }));
  }

  if (['paid', 'shipped'].includes(o.status)) {
    actions.appendChild(actionBtn('Refund', 'admin-btn admin-btn-danger', async () => {
      // Real money leaves the account, so require a typed confirmation rather
      // than a single click.
      const typed = prompt(
        `Refund ${o.receipt}?\n\nLeave blank for the full ${rupees(o.total_paise)}, ` +
        `or enter a smaller rupee amount for a partial refund.\n\nType REFUND to confirm:`
      );
      if (typed === null) return;
      const parts = typed.trim().split(/\s+/);
      if (!parts.includes('REFUND')) { flash('Refund cancelled — confirmation not typed.', true); return; }
      const amount = parts.find((x) => /^[\d.]+$/.test(x));
      const body = amount ? { amount_paise: Math.round(Number(amount) * 100) } : {};
      const out = await api(`/api/admin/orders/${o.id}/refund`, {
        method: 'POST', body: JSON.stringify(body),
      });
      flash(`Refunded ${rupees(out.amount_paise)}${out.partial ? ' (partial)' : ''} — ${out.refund_id || 'no id'}.`);
      await Promise.all([loadOrders(), loadStats()]);
    }));
  }

  if (['pending', 'paid', 'failed'].includes(o.status)) {
    actions.appendChild(actionBtn('Cancel', 'admin-btn-ghost', async () => {
      if (!confirm(`Cancel ${o.receipt}? This does not refund any money.`)) return;
      await api(`/api/admin/orders/${o.id}`, {
        method: 'PATCH', body: JSON.stringify({ status: 'cancelled' }),
      });
      flash(`${o.receipt} cancelled.`);
      await Promise.all([loadOrders(), loadStats()]);
    }));
  }

  if (actions.children.length) card.appendChild(actions);
  return card;
}

// Disables the button while its request is in flight, so a double-click can't
// fire two refunds.
function actionBtn(label, cls, fn) {
  const b = el('button', cls, label);
  b.type = 'button';
  b.addEventListener('click', async () => {
    b.disabled = true;
    const original = b.textContent;
    b.textContent = 'Working…';
    try {
      await fn();
    } catch (e) {
      flash(e.message, true);
    } finally {
      b.disabled = false;
      b.textContent = original;
    }
  });
  return b;
}

$('orderFilter')?.addEventListener('change', loadOrders);

/* ── products ──────────────────────────────────────────────────── */
async function loadProducts() {
  const box = $('productsList');
  box.innerHTML = '';
  box.appendChild(el('p', 'admin-muted', 'Loading…'));

  let data;
  try {
    data = await api('/api/admin/products');
  } catch (e) {
    box.innerHTML = '';
    box.appendChild(el('p', 'admin-muted', e.message));
    return;
  }

  box.innerHTML = '';
  if (!data.products.length) {
    box.appendChild(el('p', 'admin-muted', 'No products.'));
    return;
  }
  for (const p of data.products) box.appendChild(productRow(p));

  // A re-render builds new row elements, so any still-pending edit loses its
  // marker while pendingEdits still holds it — the bar would then claim unsaved
  // changes with nothing highlighted. Re-apply, and drop entries whose product
  // has since disappeared.
  for (const id of [...pendingEdits.keys()]) {
    const row = [...box.querySelectorAll('.product-row')]
      .find((r) => r.dataset.productId === id);
    if (row) row.classList.add('dirty-row');
    else pendingEdits.delete(id);
  }
  refreshBulkBar();
}

/* Rows with unsaved edits. Keyed by product id so re-rendering the list can't
   duplicate an entry, and so the bulk save sends each product once. */
const pendingEdits = new Map();

function refreshBulkBar() {
  const bar = $('bulkBar');
  const count = $('bulkCount');
  if (!bar) return;
  const n = pendingEdits.size;
  bar.hidden = n === 0;
  if (count) {
    count.textContent = n === 1 ? '1 unsaved change' : `${n} unsaved changes`;
  }
}

function markDirty(id, patch, rowEl) {
  pendingEdits.set(id, { ...(pendingEdits.get(id) || {}), ...patch });
  rowEl?.classList.add('dirty-row');
  refreshBulkBar();
}

function clearDirty(id, rowEl) {
  pendingEdits.delete(id);
  rowEl?.classList.remove('dirty-row');
  refreshBulkBar();
}

function productRow(p) {
  const row = el('div', 'product-row' + (p.visible ? '' : ' is-hidden'));
  row.dataset.productId = p.id;

  const img = document.createElement('img');
  img.src = p.image;
  img.alt = '';
  img.loading = 'lazy';
  row.appendChild(img);

  const info = el('div', 'pr-info');
  info.append(el('div', 'pr-name', p.name), el('div', 'pr-slug', p.slug));
  row.appendChild(info);

  // Prices are edited in RUPEES for sanity, converted to paise on save. The
  // server rejects anything non-integer, so a stray "349.567" is caught there
  // too rather than only here.
  const wrap = el('div', 'price-input');
  wrap.appendChild(el('span', null, '₹'));
  const input = document.createElement('input');
  input.type = 'text';
  input.inputMode = 'decimal';
  input.value = String(p.price_paise / 100);
  input.setAttribute('aria-label', 'Price for ' + p.name);
  const initial = input.value;
  const onEdit = () => {
    const changed = input.value !== initial || vis.checked !== Boolean(p.visible);
    wrap.classList.toggle('dirty', input.value !== initial);
    if (changed) {
      // Send rupees -> paise here so the bar holds exactly what will be saved.
      const rupeeVal = Number(input.value.trim());
      markDirty(p.id, {
        id: p.id,
        price_paise: Number.isFinite(rupeeVal) && rupeeVal >= 0 ? Math.round(rupeeVal * 100) : NaN,
        visible: vis.checked,
      }, row);
    } else {
      clearDirty(p.id, row);
    }
  };
  input.addEventListener('input', onEdit);
  wrap.appendChild(input);
  row.appendChild(wrap);

  const visWrap = el('label', 'toggle pr-visible');
  const vis = document.createElement('input');
  vis.type = 'checkbox';
  vis.checked = Boolean(p.visible);
  vis.addEventListener('change', () => onEdit());
  visWrap.append(vis, el('span', null, 'Listed'));
  row.appendChild(visWrap);

  const actions = el('div', 'pr-actions');

  const save = actionBtn('Save', 'admin-btn', async () => {
    const rupeeVal = Number(input.value.trim());
    if (!Number.isFinite(rupeeVal) || rupeeVal < 0) throw new Error('Enter a valid price.');
    const paise = Math.round(rupeeVal * 100);
    const out = await api(`/api/admin/products/${p.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ price_paise: paise, visible: vis.checked }),
    });
    wrap.classList.remove('dirty');
    clearDirty(p.id, row);
    row.classList.toggle('is-hidden', !out.product.visible);
    flash(`${p.name} updated — ${rupees(out.product.price_paise)}${out.product.visible ? '' : ' (hidden)'}.`);
    loadStats();
  });
  actions.appendChild(save);

  actions.appendChild(actionBtn('Delete', 'admin-btn-ghost', async () => {
    if (!confirm(`Delete "${p.name}"?\n\nIf it appears in any order it will be hidden instead, so order history survives.`)) return;
    const out = await api(`/api/admin/products/${p.id}`, { method: 'DELETE' });
    flash(out.message || `"${p.name}" deleted.`);
    await Promise.all([loadProducts(), loadStats()]);
  }));

  row.appendChild(actions);
  return row;
}


/* ── bulk save ─────────────────────────────────────────────────── */
$('bulkSave')?.addEventListener('click', async () => {
  if (!pendingEdits.size) return;
  const btn = $('bulkSave');

  // Catch bad input here so one typo doesn't send 26 rows and get the whole
  // batch rejected server-side with a less specific message.
  const bad = [...pendingEdits.values()].filter((x) => !Number.isFinite(x.price_paise));
  if (bad.length) {
    flash(`${bad.length} price(s) aren't valid numbers. Fix them and try again.`, true);
    return;
  }

  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Saving…';
  try {
    const out = await api('/api/admin/products', {
      method: 'PATCH',
      body: JSON.stringify({ items: [...pendingEdits.values()] }),
    });
    pendingEdits.clear();
    refreshBulkBar();
    flash(`${out.updated} product${out.updated === 1 ? '' : 's'} updated.`);
    // Re-read rather than patching each row: the server is authoritative about
    // what actually landed, including any clamping.
    await Promise.all([loadProducts(), loadStats()]);
  } catch (e) {
    // The write is all-or-nothing, so nothing changed — say so, or someone will
    // wonder which half took.
    flash(e.message + ' No changes were saved.', true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

$('bulkDiscard')?.addEventListener('click', async () => {
  if (!pendingEdits.size) return;
  if (!confirm(`Discard ${pendingEdits.size} unsaved change(s)?`)) return;
  pendingEdits.clear();
  refreshBulkBar();
  await loadProducts();
});

/* Leaving with unsaved edits is almost always an accident. */
window.addEventListener('beforeunload', (e) => {
  if (!pendingEdits.size) return;
  e.preventDefault();
  e.returnValue = '';
});

/* ── coupons ───────────────────────────────────────────────────── */

const onlyDate = (ms) => new Date(Number(ms))
  .toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

// Rupees in the form, paise on the wire — the same convention as the product
// price editor, and the server rejects anything non-integer either way.
const toPaise = (v) => {
  const n = Number(String(v ?? '').trim());
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : null;
};

// What a coupon is worth, in words. The dashboard shows this rather than raw
// kind/value columns so a glance answers "what does this code do".
function couponSummary(c) {
  if (c.kind === 'shipping') return 'Free shipping';
  if (c.kind === 'percent') {
    const cap = c.max_discount_paise ? ` (max ${rupees(c.max_discount_paise)})` : '';
    return `${c.value}% off${cap}`;
  }
  return `${rupees(c.value)} off`;
}

// Why a coupon is not currently usable, or null if it is. Checked in the same
// order as applyCoupon on the server so the dashboard never claims a code works
// when checkout would reject it.
function couponBlockedReason(c) {
  if (!c.active) return 'inactive';
  if (c.expires_at && Date.now() > c.expires_at) return 'expired';
  if (c.max_uses !== null && c.uses >= c.max_uses) return 'fully claimed';
  return null;
}

async function loadCoupons() {
  const box = $('couponsList');
  if (!box) return;
  box.innerHTML = '';
  box.appendChild(el('p', 'admin-muted', 'Loading…'));
  let data;
  try {
    data = await api('/api/admin/coupons');
  } catch (e) {
    box.innerHTML = '';
    box.appendChild(el('p', 'admin-muted', e.message));
    return;
  }
  box.innerHTML = '';
  if (!data.coupons.length) {
    box.appendChild(el('p', 'admin-muted', 'No promo codes yet. Create one above.'));
    return;
  }
  for (const c of data.coupons) box.appendChild(couponRow(c));
}

function couponRow(c) {
  const blocked = couponBlockedReason(c);
  const row = el('div', 'coupon-row' + (blocked ? ' is-off' : ''));

  const left = el('div', 'cr-main');
  left.appendChild(el('div', 'cr-code', c.code));
  left.appendChild(el('div', 'cr-what', couponSummary(c)));

  // The conditions, only when set. Listing "no minimum / never expires /
  // unlimited" on every row would bury the ones that actually have limits.
  const bits = [];
  if (c.min_order_paise > 0) bits.push(`min ${rupees(c.min_order_paise)}`);
  // Date only. when() appends a time, which is right for an order but noise for
  // an expiry — and the stored value is 23:59:59 of the chosen day, so showing
  // "04:16 am" (the local rendering of that UTC instant) would be actively
  // misleading about when the code stops working.
  if (c.expires_at) bits.push(`until ${onlyDate(c.expires_at)}`);
  if (c.max_uses !== null) bits.push(`${c.uses}/${c.max_uses} used`);
  else if (c.uses > 0) bits.push(`${c.uses} used`);
  if (c.once_per_customer) bits.push('one per customer');
  if (bits.length) left.appendChild(el('div', 'cr-limits', bits.join(' · ')));

  const state = el('div', 'cr-state');
  state.appendChild(el('span', 'badge badge-' + (blocked ? 'cancelled' : 'paid'),
    blocked || 'active'));

  const actions = el('div', 'cr-actions');

  // Pause/resume rather than only delete: the common case is ending a promo, and
  // deleting would lose the redemption history that once-per-customer relies on.
  actions.appendChild(actionBtn(c.active ? 'Pause' : 'Resume', 'admin-btn-ghost', async () => {
    await api(`/api/admin/coupons/${c.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ active: !c.active }),
    });
    flash(`${c.code} ${c.active ? 'paused' : 'resumed'}.`);
    await loadCoupons();
  }));

  actions.appendChild(actionBtn('Delete', 'admin-btn-danger', async () => {
    if (!confirm(`Delete ${c.code}? A code that has been used is deactivated instead, so its history survives.`)) return;
    const out = await api(`/api/admin/coupons/${c.id}`, { method: 'DELETE' });
    flash(out.message || `${c.code} deleted.`);
    await loadCoupons();
  }));

  row.append(left, state, actions);
  return row;
}

// The value field means something different per kind, and "Max discount" only
// applies to a percentage. Relabelling beats a help text nobody reads.
function syncCouponForm() {
  const kind = $('cpKind')?.value;
  const label = $('cpValueLabel');
  const valueField = $('cpValueField');
  const capField = $('cpCapField');
  if (!kind) return;
  if (kind === 'shipping') {
    valueField.hidden = true;
    capField.hidden = true;
  } else if (kind === 'percent') {
    valueField.hidden = false;
    capField.hidden = false;
    label.textContent = 'Percent off';
    $('cpValue').placeholder = '10';
  } else {
    valueField.hidden = false;
    capField.hidden = true;
    label.textContent = 'Amount off (₹)';
    $('cpValue').placeholder = '100';
  }
}

$('cpKind')?.addEventListener('change', syncCouponForm);
syncCouponForm();

$('couponForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('cpCreate');
  const kind = $('cpKind').value;

  // Percent is sent as a whole number; the two money fields are rupees→paise.
  const rawValue = $('cpValue').value.trim();
  let value = 0;
  if (kind === 'percent') value = Number(rawValue);
  else if (kind === 'fixed') value = toPaise(rawValue);

  const body = {
    code: $('cpCode').value.trim(),
    kind,
    value,
    min_order_paise: toPaise($('cpMin').value.trim() || '0'),
    max_discount_paise: kind === 'percent' && $('cpCap').value.trim()
      ? toPaise($('cpCap').value.trim()) : null,
    expires_at: $('cpExpires').value || null,
    max_uses: $('cpMaxUses').value.trim() ? Number($('cpMaxUses').value.trim()) : null,
    once_per_customer: $('cpOnce').checked,
  };

  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Creating…';
  try {
    const out = await api('/api/admin/coupons', { method: 'POST', body: JSON.stringify(body) });
    flash(`${out.coupon.code} created — ${couponSummary(out.coupon)}.`);
    $('couponForm').reset();
    syncCouponForm();
    await loadCoupons();
  } catch (err) {
    flash(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
});

/* ── tabs ──────────────────────────────────────────────────────── */
// Driven by each tab's data-panel attribute rather than a boolean. The previous
// version was `const isOrders = …` with four negated toggles, which worked for
// exactly two tabs and needed rewriting to add a third — so it is written once
// here to iterate instead.
function selectTab(panelId) {
  for (const tab of document.querySelectorAll('.admin-tab')) {
    const target = tab.dataset.panel;
    const active = target === panelId;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    const panel = $(target);
    if (panel) panel.hidden = !active;
  }
}

for (const tab of document.querySelectorAll('.admin-tab')) {
  tab.addEventListener('click', () => selectTab(tab.dataset.panel));
}

boot();
