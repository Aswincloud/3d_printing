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

  await Promise.all([loadStats(), loadOrders(), loadProducts()]);
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
  pair('Delivery', o.delivery === 'pickup' ? 'Local pickup' : 'Ship');
  if (o.delivery === 'ship') {
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

/* ── tabs ──────────────────────────────────────────────────────── */
function selectTab(which) {
  const isOrders = which === 'orders';
  $('tabOrders').classList.toggle('active', isOrders);
  $('tabProducts').classList.toggle('active', !isOrders);
  $('tabOrders').setAttribute('aria-selected', String(isOrders));
  $('tabProducts').setAttribute('aria-selected', String(!isOrders));
  $('ordersPanel').hidden = !isOrders;
  $('productsPanel').hidden = isOrders;
}

$('tabOrders')?.addEventListener('click', () => selectTab('orders'));
$('tabProducts')?.addEventListener('click', () => selectTab('products'));

boot();
