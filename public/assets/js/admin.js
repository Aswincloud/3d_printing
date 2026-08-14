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
    // Never reuse a stored answer for a dashboard request. The server now sends
    // `private, no-store` on everything under /api/ except the public catalogue,
    // which stops these being cached in the first place — but that only governs
    // responses issued from now on.
    //
    // The reason this is here at all: /api/auth/me had already been cached at the
    // edge for 25 minutes with {"signedIn":false}. Deploying the header fixed new
    // responses and did nothing about the stored one, so sign-in stayed broken while
    // that entry lived. Asking for no-cache on the request side skips it immediately
    // rather than waiting for an eviction nobody controls, and it keeps a browser or
    // an intermediary from doing the same thing later.
    cache: 'no-store',
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
  // A discounted order otherwise showed only a smaller total with no explanation
  // of why — the coupon columns were being stored but never surfaced here.
  if (o.discount_paise > 0) pair('Promo', `${o.coupon_code || ''} −${rupees(o.discount_paise)}`);
  pair('Shipping', rupees(o.shipping_paise));
  pair('Payment id', o.rzp_payment_id);
  pair('Paid at', o.paid_at ? when(o.paid_at) : null);
  pair('Shipped at', o.shipped_at ? when(o.shipped_at) : null);
  // Shown here because this is where you look when a customer asks "where is my
  // parcel?" a week later — the email that carried it was sent once.
  pair('Courier', o.courier);
  pair('Tracking', o.tracking_id);
  pair('Notes', o.notes);
  card.appendChild(grid);

  const actions = el('div', 'order-actions');

  if (o.status === 'paid') {
    actions.appendChild(actionBtn('Mark shipped', 'admin-btn', async () => {
      // Both optional. A print handed to a local courier with no tracking number
      // is still shipped, so cancelling out of either prompt continues rather
      // than aborting — only Cancel on the FIRST prompt abandons the whole thing.
      const courier = prompt(
        `Mark ${o.receipt} shipped and email ${o.cust_email}.\n\n` +
        `Courier (optional — leave blank to skip):`
      );
      if (courier === null) return;   // cancelled the whole action

      const tracking = prompt('Tracking number (optional — leave blank to skip):');
      if (tracking === null) return;

      const out = await api(`/api/admin/orders/${o.id}`, {
        method: 'PATCH',
        body: JSON.stringify({
          status: 'shipped',
          courier: courier.trim(),
          tracking_id: tracking.trim(),
        }),
      });
      flash(`${o.receipt} marked shipped` +
        (out.emailed ? ` — ${o.cust_email} notified.` : '.'));
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
// ── listing a photo that has been pushed but not priced ───────────
//
// Photos live in the repo (public/assets/images/) and deploy with the site. The
// dashboard learns what exists from assets/images.json, generated by
// `npm run images` — a Worker cannot list a directory, so without that manifest
// there is no way to know a new photo arrived.
//
// This section turns "I pushed a photo" into "type a price, click List it".
const CATEGORIES = ['figurine', 'decor', 'functional', 'set'];

async function loadUnlisted() {
  const box = $('unlistedList');
  if (!box) return;
  box.innerHTML = '';

  // Fetched WITHOUT api(), which force-signs-out on a 401.
  //
  // This panel is a convenience, not the dashboard. Routing its failures through
  // api() means a hiccup on this one endpoint tears down the whole screen —
  // caught when two existing browser suites, which stub /api/admin/products but
  // not this route, went from passing to a blank page.
  //
  // The catalogue below is what matters; if this panel cannot load, it stays
  // hidden and everything else works.
  let data;
  try {
    const res = await fetch('/api/admin/products/unlisted', {
      headers: { 'Content-Type': 'application/json' },
    });
    if (!res.ok) {
      const wrap = $('unlistedPanel');
      if (wrap) wrap.hidden = true;
      return;
    }
    data = await res.json();
  } catch {
    const wrap = $('unlistedPanel');
    if (wrap) wrap.hidden = true;
    return;
  }

  const head = $('unlistedHead');
  const wrap = $('unlistedPanel');

  if (data.manifest_missing) {
    if (wrap) wrap.hidden = false;
    if (head) head.textContent = 'Photo list unavailable';
    box.appendChild(el('p', 'admin-muted', data.error));
    return;
  }

  const list = data.images || [];
  if (!list.length) {
    // Hidden rather than showing an empty box: the normal state is nothing to
    // list, and a permanent empty panel is noise.
    if (wrap) wrap.hidden = true;
    return;
  }

  if (wrap) wrap.hidden = false;
  if (head) head.textContent = `Not yet listed (${list.length})`;

  // Drop selections for photos that are no longer unlisted — otherwise listing
  // three and then hiding "the selection" would act on rows that are already
  // products.
  const present = new Set(list.map((i) => i.file));
  for (const f of [...ulSelected]) if (!present.has(f)) ulSelected.delete(f);

  // Rebuilt from scratch on every render, so a stale entry can never point at a
  // detached input — which would submit a price the admin can no longer see.
  ulRows.length = 0;
  for (const img of list) box.appendChild(unlistedRow(img));
  refreshUlBar();
}

// ── batch selection ───────────────────────────────────────────────
//
// Every rendered row registers a reader here so one handler can collect the whole
// panel without querying the DOM for inputs it did not create.
const ulRows = [];

// Rows with a usable price, in render order. This is the set "List priced photos"
// acts on: a blank price is how the admin says "not this one", so it is a skip
// rather than an error.
function ulPricedRows() {
  return ulRows.filter((r) => {
    const paise = toPaise(r.priceValue());
    return paise !== null && paise >= 100;
  });
}

function refreshUlBar() {
  const bar = $('ulBulkBar');
  const count = $('ulBulkCount');
  const all = $('ulSelectAll');
  if (!bar) return;

  const n = ulSelected.size;
  const priced = ulPricedRows().length;

  // Visible when there is anything to do. The two actions are independent now:
  // listing is driven by which rows have prices, hiding by what is ticked, so a bar
  // shown only on selection would hide the List button exactly when it is usable.
  bar.hidden = n === 0 && priced === 0;

  if (count) {
    const parts = [];
    if (priced) parts.push(`${priced} priced`);
    if (n) parts.push(`${n} selected`);
    count.textContent = parts.join(' · ');
  }

  const listBtn = $('ulListPriced');
  if (listBtn) {
    listBtn.disabled = priced === 0;
    listBtn.textContent = priced === 0
      ? 'List priced photos'
      : `List ${priced} priced photo${priced === 1 ? '' : 's'}`;
  }

  const hide = $('ulBulkHide');
  if (hide) {
    hide.disabled = n === 0;
    hide.textContent = n > 1 ? `Hide ${n}` : 'Hide selected';
  }

  // Reflect partial selection, so the header checkbox is never a lie.
  if (all) {
    const total = document.querySelectorAll('.unlisted-row').length;
    all.checked = total > 0 && n === total;
    all.indeterminate = n > 0 && n < total;
  }
}

function clearUlSelection() {
  ulSelected.clear();
  for (const cb of document.querySelectorAll('.ul-pick')) cb.checked = false;
  for (const r of document.querySelectorAll('.unlisted-row')) r.classList.remove('is-picked');
  const err = $('ulBulkError');
  if (err) err.hidden = true;
  refreshUlBar();
}

$('ulSelectAll')?.addEventListener('change', (e) => {
  const rows = [...document.querySelectorAll('.unlisted-row')];

  // From a PARTIAL selection, this must select everything.
  //
  // A checkbox showing indeterminate is visually neither on nor off, and
  // browsers resolve a click on it to checked = false — so reading e.target
  // .checked would make "Select all" behave as "select none" whenever some rows
  // were already ticked. Decide from the selection instead: anything less than
  // all means select all.
  const on = ulSelected.size < rows.length;
  e.target.checked = on;
  e.target.indeterminate = false;

  ulSelected.clear();
  for (const row of rows) {
    const cb = row.querySelector('.ul-pick');
    if (cb) cb.checked = on;
    row.classList.toggle('is-picked', on);
    if (on && row.dataset.file) ulSelected.add(row.dataset.file);
  }
  refreshUlBar();
});

$('ulBulkClear')?.addEventListener('click', clearUlSelection);

async function runUlBatch(path, payload, btn, describe) {
  const err = $('ulBulkError');
  if (err) err.hidden = true;
  const label = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Working…';
  try {
    const out = await api(path, { method: 'POST', body: JSON.stringify(payload) });
    clearUlSelection();
    flash(describe(out));
    // loadProducts() refreshes the unlisted panel itself, so awaiting BOTH ran
    // loadUnlisted() twice concurrently: each cleared the list, then each
    // appended to it, leaving every row rendered twice. Found by a test counting
    // 8 checkboxes for 4 photos — which then made "select all" look broken.
    await loadProducts();
  } catch (e) {
    // Server errors from the batch path name the offending FILE — "Enter a price in
    // rupees for x.jpg", "x.jpg is already a product". Put the message on that row
    // when it can be matched, because in a panel of twenty a message at the bottom
    // of the bar means scrolling and guessing.
    const hit = ulRows.find((r) => e.message && e.message.includes(r.file));
    if (hit) hit.showError(e.message);
    if (err) { err.textContent = e.message; err.hidden = false; }
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

// One click, every row that has a price, each at its own.
$('ulListPriced')?.addEventListener('click', (e) => {
  const err = $('ulBulkError');
  const rows = ulPricedRows();
  if (!rows.length) {
    // The button is disabled in this state, so this is only reachable by a stray
    // programmatic click — but silently posting an empty batch would be worse.
    if (err) { err.textContent = 'Enter a price on at least one photo first.'; err.hidden = false; }
    return;
  }

  const items = rows.map((r) => r.read());
  runUlBatch('/api/admin/products/batch', { items }, e.target, (out) => {
    const total = items.reduce((sum, it) => sum + it.price_paise, 0);
    return `${out.created} photo${out.created === 1 ? '' : 's'} listed — ${rupees(total)} of stock.`;
  });
});

$('ulBulkHide')?.addEventListener('click', (e) => {
  const n = ulSelected.size;
  // Confirmed because it writes rows, and undoing a 15-photo mistake means
  // finding and un-hiding each one in the products list below.
  if (!confirm(`Hide ${n} photo${n === 1 ? '' : 's'} from the shop?\n\nThe files stay in the repo — you can show them again from the products list.`)) return;
  runUlBatch('/api/admin/products/hide', { images: [...ulSelected] }, e.target,
    (out) => `${out.hidden} photo${out.hidden === 1 ? '' : 's'} hidden from the shop.`);
});

// Which unlisted photos are ticked. Keyed on filename, which is what both batch
// endpoints take — so nothing has to be translated at submit time.
const ulSelected = new Set();

function unlistedRow(img) {
  const row = el('div', 'unlisted-row');
  row.dataset.file = img.file;

  const pick = document.createElement('input');
  pick.type = 'checkbox';
  pick.className = 'ul-pick';
  pick.checked = ulSelected.has(img.file);
  pick.setAttribute('aria-label', 'Select ' + img.file);
  pick.addEventListener('change', () => {
    if (pick.checked) ulSelected.add(img.file);
    else ulSelected.delete(img.file);
    row.classList.toggle('is-picked', pick.checked);
    refreshUlBar();
  });
  row.classList.toggle('is-picked', pick.checked);
  row.appendChild(pick);

  const thumb = document.createElement('img');
  thumb.className = 'pr-thumb';
  thumb.src = '/' + img.path;
  thumb.alt = '';
  thumb.loading = 'lazy';
  row.appendChild(thumb);

  const form = el('div', 'ul-form');

  const field = (label, node) => {
    const w = el('label', 'ul-field');
    w.appendChild(el('span', 'ul-label', label));
    w.appendChild(node);
    return w;
  };

  const name = document.createElement('input');
  name.type = 'text';
  name.className = 'ul-input';
  // Guessed from the filename. A camera-default name yields nothing, and an
  // empty box is more honest than a made-up word.
  name.value = img.suggested_name || '';
  name.placeholder = 'Product name';
  name.setAttribute('aria-label', 'Name for ' + img.file);

  const priceWrap = el('div', 'price-input');
  priceWrap.appendChild(el('span', null, '₹'));
  const price = document.createElement('input');
  price.type = 'text';
  price.inputMode = 'decimal';
  // "skip", not "349". A numeric placeholder is fine when a price is mandatory, but
  // blank now MEANS "do not list this one" — and a greyed 349 in every empty box
  // reads as four priced rows above a button offering to list three. The placeholder
  // states the behaviour instead of demonstrating the format.
  price.placeholder = 'skip';
  price.setAttribute('aria-label', 'Price for ' + img.file);
  // Typing a price is what puts a row into the batch, so the button's count has to
  // follow the keystrokes. Without this the label would only be right after a
  // re-render, and "List 2" over three filled rows is the kind of wrong that gets
  // trusted.
  const markPriced = () => {
    const paise = toPaise(price.value);
    row.classList.toggle('is-priced', paise !== null && paise >= 100);
  };
  price.addEventListener('input', () => { markPriced(); refreshUlBar(); });
  priceWrap.appendChild(price);

  const cat = document.createElement('select');
  cat.className = 'ul-input';
  cat.setAttribute('aria-label', 'Category for ' + img.file);
  for (const c of CATEGORIES) {
    const o = document.createElement('option');
    o.value = c;
    o.textContent = c;
    cat.appendChild(o);
  }

  const desc = document.createElement('input');
  desc.type = 'text';
  desc.className = 'ul-input';
  desc.placeholder = 'Short description (optional)';
  desc.setAttribute('aria-label', 'Description for ' + img.file);

  form.append(
    field('Name', name),
    field('Price', priceWrap),
    field('Category', cat),
    field('Description', desc),
  );

  const err = el('p', 'ul-error');

  // Register this row so "List priced photos" can read it. Closures over the actual
  // inputs, not a DOM query — the values submitted are then necessarily the ones on
  // screen in this row, and there is no selector to drift out of sync with the markup.
  ulRows.push({
    file: img.file,
    priceValue: () => price.value,
    showError: (msg) => { err.textContent = msg; err.hidden = false; },
    read: () => ({
      file: img.file,
      name: name.value.trim(),
      price_paise: toPaise(price.value),
      category: cat.value,
      description: desc.value.trim(),
    }),
  });
  err.hidden = true;

  const listBtn = actionBtn('List it', 'admin-btn', async () => {
    err.hidden = true;
    const paise = toPaise(price.value);
    // Price is the one field with no safe default — it is what a customer pays.
    if (!name.value.trim() || name.value.trim().length < 2) {
      err.textContent = 'Give it a name first.';
      err.hidden = false;
      name.focus();
      return;
    }
    if (paise === null || paise < 100) {
      err.textContent = 'Enter a price in rupees, e.g. 349.';
      err.hidden = false;
      price.focus();
      return;
    }

    try {
      await api('/api/admin/products', {
        method: 'POST',
        body: JSON.stringify({
          name: name.value.trim(),
          price_paise: paise,
          image: img.path,
          category: cat.value,
          description: desc.value.trim(),
          visible: true,
        }),
      });
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      return;
    }

    flash(`"${name.value.trim()}" is live in the shop.`);
    // loadProducts() refreshes the unlisted panel too — see the note in
    // runUlBatch(). Calling both duplicates every row.
    await loadProducts();
  });

  const meta = el('div', 'ul-meta');
  meta.appendChild(el('code', 'ul-file', img.file));
  meta.appendChild(el('span', 'admin-muted', ` · ${Math.round(img.bytes / 1024)} KB`));

  const right = el('div', 'ul-actions');
  right.append(listBtn);

  row.append(form, right);
  row.appendChild(meta);
  row.appendChild(err);
  return row;
}

async function loadProducts() {
  loadUnlisted();   // independent of the catalogue list; no need to await

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

// '—' rather than "1 Jan 1970" for a missing or zero timestamp. Every real row
// has created_at NOT NULL, but rendering an epoch date is the kind of thing that
// gets read as a data-corruption bug when it is only a missing field.
const onlyDate = (ms) => (Number(ms) > 0
  ? new Date(Number(ms)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
  : '—');

// An expiry, at whatever precision actually distinguishes it.
//
// onlyDate() alone was fine while every coupon was hand-made and expired on a
// date. Chat-issued codes live 30 MINUTES, so a date-only rendering shows
// "6 Aug 2026" for one that died an hour ago and one with 20 minutes left — the
// two states that matter most are indistinguishable.
//
// Anything expiring within a day gets a time and a countdown; everything else
// keeps the old format, since "expires 14 Sep 2026" is the right answer for a
// festival code and a clock on it would be noise.
function expiryLabel(ms) {
  const t = Number(ms);
  if (!(t > 0)) return 'never';
  const left = t - Date.now();
  const day = 24 * 60 * 60 * 1000;

  if (left <= 0) {
    const agoMin = Math.round(-left / 60000);
    if (agoMin < 60) return `expired ${agoMin} min ago`;
    if (-left < day) return `expired ${Math.round(-left / 3600000)}h ago`;
    return `expired ${onlyDate(t)}`;
  }
  if (left < day) {
    const time = new Date(t).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });
    const mins = Math.round(left / 60000);
    return mins < 60 ? `${time} (${mins} min left)` : `${time} (${Math.round(left / 3600000)}h left)`;
  }
  return onlyDate(t);
}

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

  // Chat-issued codes are separated from the ones Aswin made.
  //
  // They are minted one per visitor who asks and expire in 30 minutes, so on a
  // busy day there could be dozens — all dead, all noise, and all sitting above
  // the handful of real promos in a list sorted by creation date. Mixing them
  // would make this screen useless for the thing it is actually for.
  const mine = data.coupons.filter((c) => c.issued_by !== 'chat');
  const fromChat = data.coupons.filter((c) => c.issued_by === 'chat');

  // Expired codes are dead weight. Chat-issued ones expire every 30 minutes, so
  // without a filter this list grows by a row per visitor who asks for a
  // discount and never shrinks.
  //
  // Filtering only on EXPIRED, not on couponBlockedReason(): a paused code is
  // one you deliberately switched off and will probably switch back on, and a
  // fully-claimed one is a promo that worked. Hiding either would be hiding
  // something you still act on.
  const isExpired = (c) => c.expires_at && Date.now() > c.expires_at;
  const hide = hideExpired();

  const visibleMine = hide ? mine.filter((c) => !isExpired(c)) : mine;
  const visibleChat = hide ? fromChat.filter((c) => !isExpired(c)) : fromChat;
  const hiddenCount = (mine.length - visibleMine.length) + (fromChat.length - visibleChat.length);

  for (const c of visibleMine) box.appendChild(couponRow(c));
  if (!visibleMine.length && mine.length) {
    box.appendChild(el('p', 'admin-muted', 'All your promo codes have expired.'));
  }

  if (fromChat.length) {
    const live = fromChat.filter((c) => !couponBlockedReason(c)).length;
    const used = fromChat.filter((c) => c.uses > 0).length;

    const head = el('div', 'coupon-group-head');
    head.appendChild(el('h4', null, 'Issued by live chat'));
    // The number worth knowing is how many were REDEEMED — that is whether the
    // promo is working. The rest expired unused and cost nothing.
    //
    // Counted over ALL chat codes, not just the visible ones: the summary is
    // about the promo, and hiding expired rows must not make it look like fewer
    // codes went out.
    head.appendChild(el('p', 'admin-muted',
      `${fromChat.length} issued · ${used} redeemed · ${live} still live`));
    box.appendChild(head);

    // Newest first, and only the recent ones by default: an unbounded list of
    // expired codes is not something anyone scrolls.
    const recent = visibleChat.slice(0, 25);
    for (const c of recent) box.appendChild(couponRow(c));
    if (!recent.length) {
      box.appendChild(el('p', 'admin-muted', 'No live chat codes right now.'));
    } else if (visibleChat.length > recent.length) {
      box.appendChild(el('p', 'admin-muted',
        `+ ${visibleChat.length - recent.length} more not shown.`));
    }
  }

  // Say what was hidden. A filter that silently removes rows is how you end up
  // wondering why a code you know exists is not in the list.
  const note = $('couponHiddenNote');
  if (note) {
    note.textContent = hiddenCount
      ? `${hiddenCount} expired code${hiddenCount === 1 ? '' : 's'} hidden.`
      : '';
  }
}

const hideExpired = () => {
  const box = $('hideExpired');
  return box ? box.checked : true;   // default ON
};

// Inline editor for an existing coupon.
//
// The CODE is deliberately not editable. Renaming it after customers have it
// invalidates every copy already shared — on Instagram, in a chat window, in
// someone's notes — and the redemption history is keyed to it. The server would
// allow the rename; the UI does not offer it.
//
// Sends only what CHANGED. updateCoupon() is PATCH semantics, and validates
// against the merged row (src/coupons.js), so a percentage over 100 is caught
// server-side even though the field is a plain number input here.
function openCouponEditor(c, row) {
  if (row.querySelector('.cr-editor')) return;   // already open

  const box = el('div', 'cr-editor');
  const grid = el('div', 'cr-edit-grid');

  const field = (label, node, hint) => {
    const w = el('label', 'ul-field');
    w.appendChild(el('span', 'ul-label', label));
    w.appendChild(node);
    if (hint) w.appendChild(el('span', 'cr-hint', hint));
    return w;
  };
  const input = (value, opts = {}) => {
    const i = document.createElement('input');
    i.type = opts.type || 'text';
    i.className = 'ul-input';
    if (opts.placeholder) i.placeholder = opts.placeholder;
    i.value = value ?? '';
    return i;
  };

  // Percent codes carry a percentage; fixed codes carry rupees. Labelling both
  // "Value" would invite entering 10 on a fixed code and giving ₹0.10 off.
  const isPercent = c.kind === 'percent';
  const isShipping = c.kind === 'shipping';
  const value = input(isPercent ? c.value : rupeesPlain(c.value));
  const cap = input(c.max_discount_paise ? rupeesPlain(c.max_discount_paise) : '', { placeholder: 'no cap' });
  const min = input(c.min_order_paise ? rupeesPlain(c.min_order_paise) : '', { placeholder: '0' });
  const maxUses = input(c.max_uses ?? '', { placeholder: 'unlimited' });
  const expires = input(c.expires_at ? new Date(c.expires_at).toISOString().slice(0, 10) : '', { type: 'date' });

  const once = document.createElement('input');
  once.type = 'checkbox';
  once.checked = Boolean(c.once_per_customer);
  const onceWrap = el('label', 'cr-check');
  onceWrap.append(once, el('span', null, 'One use per customer'));

  if (!isShipping) {
    grid.appendChild(field(isPercent ? 'Percent off' : 'Amount off (₹)', value));
  }
  if (isPercent) grid.appendChild(field('Max discount (₹)', cap, 'blank = uncapped'));
  grid.appendChild(field('Minimum order (₹)', min));
  grid.appendChild(field('Total uses', maxUses, 'blank = unlimited'));
  grid.appendChild(field('Expires', expires, 'blank = never'));

  // The checkbox was built above and read on save, but was never put on the page —
  // so "Per customer" appeared in a coupon's facts as something you could set, and
  // the editor had no control for it. It could only be chosen at creation.
  //
  // Its own row rather than a grid cell: the grid is auto-fit 140px columns sized
  // for labelled inputs, and a bare checkbox dropped into one sits oddly against
  // them. Appended to the box below, next to `grid`.
  const onceRow = el('div', 'cr-edit-once');
  onceRow.appendChild(onceWrap);

  const err = el('p', 'ul-error');
  err.hidden = true;

  const bar = el('div', 'cr-edit-actions');
  const save = actionBtn('Save changes', 'admin-btn', async () => {
    err.hidden = true;
    const patch = {};

    if (!isShipping) {
      const v = isPercent ? Number(value.value.trim()) : toPaise(value.value);
      if (v === null || !Number.isFinite(v)) {
        err.textContent = isPercent ? 'Percent must be a number.' : 'Amount must be a number.';
        err.hidden = false; return;
      }
      if (v !== c.value) patch.value = v;
    }
    if (isPercent) {
      const capPaise = cap.value.trim() === '' ? null : toPaise(cap.value);
      if (cap.value.trim() !== '' && capPaise === null) {
        err.textContent = 'Max discount must be a number of rupees.'; err.hidden = false; return;
      }
      if (capPaise !== c.max_discount_paise) patch.max_discount_paise = capPaise;
    }

    const minPaise = min.value.trim() === '' ? 0 : toPaise(min.value);
    if (min.value.trim() !== '' && minPaise === null) {
      err.textContent = 'Minimum must be a number of rupees.'; err.hidden = false; return;
    }
    if (minPaise !== c.min_order_paise) patch.min_order_paise = minPaise;

    const mu = maxUses.value.trim() === '' ? null : Number(maxUses.value.trim());
    if (mu !== null && (!Number.isInteger(mu) || mu < 1)) {
      err.textContent = 'Total uses must be a whole number, or blank.'; err.hidden = false; return;
    }
    if (mu !== c.max_uses) patch.max_uses = mu;

    // A blank date clears the expiry. The server accepts yyyy-mm-dd and reads it
    // as end-of-day, which is why "valid until the 15th" works ON the 15th.
    //
    // Compared at DAY resolution, not by timestamp. A date input can only hold a
    // day, so a coupon expiring at 13:07 shows as "2026-09-05" and re-parses to
    // 23:59 — a 652-minute difference that made every save look like an expiry
    // change and silently moved the coupon's end time. Compare what the field can
    // actually express.
    const exp = expires.value.trim();
    const currentDay = c.expires_at ? new Date(c.expires_at).toISOString().slice(0, 10) : '';
    if (exp !== currentDay) patch.expires_at = exp || null;

    if (once.checked !== Boolean(c.once_per_customer)) patch.once_per_customer = once.checked;

    if (!Object.keys(patch).length) {
      box.remove();
      return;
    }

    try {
      await api(`/api/admin/coupons/${c.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
      return;
    }
    flash(`${c.code} updated.`);
    await loadCoupons();
  });

  bar.append(save, actionBtn('Cancel', 'admin-btn-ghost', () => box.remove()));

  box.append(
    el('p', 'cr-edit-note', `Editing ${c.code}. The code itself can't be changed — anyone already holding it would find it invalid.`),
    grid, onceRow, err, bar,
  );
  row.appendChild(box);
  (isShipping ? min : value).focus();
}

// Paise → a plain rupee number for an input field (no ₹, no grouping — those
// would come back as text the server rejects).
const rupeesPlain = (paise) => String(Math.round(Number(paise || 0)) / 100);

function couponRow(c) {
  const blocked = couponBlockedReason(c);
  const row = el('div', 'coupon-row' + (blocked ? ' is-off' : ''));

  const left = el('div', 'cr-main');
  left.appendChild(el('div', 'cr-code', c.code));
  left.appendChild(el('div', 'cr-what', couponSummary(c)));

  // Every condition, stated either way. The first version listed only the limits
  // that were SET, which reads well but means a blank space is ambiguous — you
  // cannot tell "no expiry" from "I forgot to look". Aswin asked for full
  // details, so absence is now spelled out.
  const facts = [
    ['Minimum', c.min_order_paise > 0 ? rupees(c.min_order_paise) : 'none'],
    ['Expires', expiryLabel(c.expires_at)],
    ['Uses', c.max_uses !== null ? `${c.uses} of ${c.max_uses}` : `${c.uses} (unlimited)`],
    ['Per customer', c.once_per_customer ? 'once only' : 'unlimited'],
  ];
  if (c.kind === 'percent') {
    facts.splice(1, 0, ['Max discount', c.max_discount_paise ? rupees(c.max_discount_paise) : 'uncapped']);
  }
  facts.push(['Created', onlyDate(c.created_at)]);

  // Everything else the API returns. Previously only created_at was shown, so
  // "when did I last change this?" and "when was it last redeemed?" — the two
  // questions you actually ask about a running promo — had no answer here.
  if (c.updated_at && c.updated_at !== c.created_at) {
    facts.push(['Edited', onlyDate(c.updated_at)]);
  }
  facts.push(['Last used', c.last_used_at ? expiryLabel(c.last_used_at).replace(/^expired /, '') : 'never']);
  if (c.issued_by) {
    facts.push(['Source', c.issued_by === 'chat' ? 'live chat' : c.issued_by]);
  }
  if (c.issued_to) {
    // The Chatwoot contact the code was minted for — the only way to tell which
    // visitor a chat code belongs to.
    facts.push(['Issued to', String(c.issued_to)]);
  }

  const grid = el('div', 'cr-facts');
  for (const [k, v] of facts) {
    const pair = el('div', 'cr-fact');
    pair.appendChild(el('span', 'cr-fact-k', k));
    pair.appendChild(el('span', 'cr-fact-v', v));
    grid.appendChild(pair);
  }
  left.appendChild(grid);

  // What it has actually cost. `uses` says a code was redeemed; this says what
  // that was worth — the number that decides whether to run the promo again.
  if (c.paid_orders > 0) {
    const money = el('div', 'cr-money');
    money.appendChild(el('span', 'cr-money-item',
      `${c.paid_orders} paid order${c.paid_orders === 1 ? '' : 's'}`));
    money.appendChild(el('span', 'cr-money-item cr-given', `−${rupees(c.given_away_paise)} given`));
    money.appendChild(el('span', 'cr-money-item cr-earned', `${rupees(c.revenue_paise)} revenue`));
    if (c.last_used_at) money.appendChild(el('span', 'cr-money-item', `last ${onlyDate(c.last_used_at)}`));
    left.appendChild(money);
  }

  const state = el('div', 'cr-state');
  state.appendChild(el('span', 'badge badge-' + (blocked ? 'cancelled' : 'paid'),
    blocked || 'active'));

  const actions = el('div', 'cr-actions');

  // Who redeemed it. Loaded on demand rather than with the list: it returns
  // customer emails, and fetching those for every row on every dashboard load
  // would be more exposure than the feature needs.
  if (c.paid_orders > 0 || c.uses > 0) {
    actions.appendChild(actionBtn('Who used it', 'admin-btn-ghost', async () => {
      const existing = row.querySelector('.cr-redemptions');
      if (existing) { existing.remove(); return; }
      const data = await api(`/api/admin/coupons/${c.id}/redemptions`);
      const box = el('div', 'cr-redemptions');
      if (!data.redemptions.length) {
        box.appendChild(el('p', 'admin-muted', 'No redemptions recorded yet.'));
      } else {
        for (const r of data.redemptions) {
          const line = el('div', 'cr-redemption');
          line.appendChild(el('span', 'cr-r-email', r.email));
          line.appendChild(el('span', 'cr-r-meta',
            `${r.receipt || '—'} · ${r.status || '—'} · −${rupees(r.discount_paise || 0)} · ${when(r.created_at)}`));
          box.appendChild(line);
        }
      }
      row.appendChild(box);
    }));
  }

  // Edit. updateCoupon() has supported a full PATCH since coupons shipped; there
  // was simply no way to reach it, so changing a percentage meant deleting the
  // code and making a new one — which invalidates it for anyone already holding it.
  actions.appendChild(actionBtn('Edit', 'admin-btn-ghost', () => openCouponEditor(c, row)));

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

// Re-render from the data already loaded rather than refetching — the filter is
// a view concern, and a network round trip to hide rows would feel slow.
$('hideExpired')?.addEventListener('change', () => loadCoupons());

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
