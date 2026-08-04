/* ===== NAV ===== */
const hamburger = document.querySelector('.nav-hamburger');
hamburger?.addEventListener('click', () => {
  document.body.classList.toggle('nav-menu-open');
});

document.querySelectorAll('.nav-links a').forEach(link => {
  link.addEventListener('click', () => document.body.classList.remove('nav-menu-open'));
});

/* ===== SCROLL ANIMATIONS ===== */
const fadeEls = document.querySelectorAll('.fade-up');
const observer = new IntersectionObserver((entries) => {
  entries.forEach((e, i) => {
    if (e.isIntersecting) {
      setTimeout(() => e.target.classList.add('visible'), e.target.dataset.delay || 0);
      observer.unobserve(e.target);
    }
  });
}, { threshold: 0.12 });
fadeEls.forEach(el => observer.observe(el));

/* ===== LIGHTBOX ===== */
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightboxImg');
const items = [...document.querySelectorAll('.gallery-item')];
let current = 0;

function openLightbox(index) {
  current = index;
  const img = items[index].querySelector('img');
  lightboxImg.src = img.src;
  lightboxImg.alt = img.alt;
  lightbox.classList.add('active');
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  lightbox.classList.remove('active');
  document.body.style.overflow = '';
}

function navigate(dir) {
  current = (current + dir + items.length) % items.length;
  const img = items[current].querySelector('img');
  lightboxImg.style.opacity = '0';
  setTimeout(() => {
    lightboxImg.src = img.src;
    lightboxImg.alt = img.alt;
    lightboxImg.style.opacity = '1';
  }, 150);
}

lightboxImg.style.transition = 'opacity 0.15s ease';

items.forEach((item, i) => {
  item.addEventListener('click', () => openLightbox(i));
});

document.getElementById('lightboxClose')?.addEventListener('click', closeLightbox);
document.getElementById('lightboxPrev')?.addEventListener('click', () => navigate(-1));
document.getElementById('lightboxNext')?.addEventListener('click', () => navigate(1));

lightbox?.addEventListener('click', (e) => {
  if (e.target === lightbox) closeLightbox();
});

document.addEventListener('keydown', (e) => {
  if (!lightbox.classList.contains('active')) return;
  if (e.key === 'Escape') closeLightbox();
  if (e.key === 'ArrowLeft') navigate(-1);
  if (e.key === 'ArrowRight') navigate(1);
});

/* ===== FILE UPLOAD ===== */
const fileInput = document.getElementById('file');
const fileDrop = document.getElementById('fileDrop');
const fileInfo = document.getElementById('fileInfo');
const fileName = document.getElementById('fileName');
const fileSize = document.getElementById('fileSize');

function formatBytes(b) {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / (1024 * 1024)).toFixed(1) + ' MB';
}

function showFile(file) {
  fileName.textContent = file.name;
  fileSize.textContent = formatBytes(file.size);
  fileInfo.style.display = 'flex';
  document.getElementById('fileDropInner').style.display = 'none';
}

function clearFile() {
  fileInput.value = '';
  fileInfo.style.display = 'none';
  document.getElementById('fileDropInner').style.display = 'block';
  fileDrop?.classList.remove('invalid');
  document.getElementById('fileError')?.classList.remove('show');
}

fileInput?.addEventListener('change', () => {
  if (fileInput.files[0]) {
    showFile(fileInput.files[0]);
    fileDrop?.classList.remove('invalid');
    document.getElementById('fileError')?.classList.remove('show');
  }
});

fileDrop?.addEventListener('click', () => fileInput.click());

fileDrop?.addEventListener('dragover', (e) => { e.preventDefault(); fileDrop.classList.add('drag-over'); });
fileDrop?.addEventListener('dragleave', () => fileDrop.classList.remove('drag-over'));
fileDrop?.addEventListener('drop', (e) => {
  e.preventDefault();
  fileDrop.classList.remove('drag-over');
  const file = e.dataTransfer.files[0];
  if (file) { fileInput.files = e.dataTransfer.files; showFile(file); }
});

async function uploadFile(file) {
  const fd = new FormData();
  fd.append('reqtype', 'fileupload');
  fd.append('time', '72h');
  fd.append('fileToUpload', file);
  const res = await fetch('https://litterbox.catbox.moe/resources/internals/api.php', {
    method: 'POST', body: fd,
  });
  const url = await res.text();
  if (!url.startsWith('https://')) throw new Error('Upload failed');
  return url.trim();
}

/* ===== QUOTE FORM ===== */
// Posts to our own Worker, which sends the mail server-side. No credential
// ships to the browser (this used to hold a GitHub PAT injected at deploy time).
const form = document.getElementById('quoteForm');
const formContent = document.getElementById('formContent');
const formSuccess = document.getElementById('formSuccess');
const formError = document.getElementById('formError');
const formErrorText = document.getElementById('formErrorText');

// Captured before any spinner overwrites it, so failures can restore the label.
const SUBMIT_LABEL = form?.querySelector('.form-submit')?.innerHTML || 'Send Quote Request';

/* ===== VALIDATION ===== */
const MAX_FILE_BYTES = 100 * 1024 * 1024; // 100MB — matches the note in the drop zone
const ALLOWED_EXTS = ['stl', 'obj', '3mf', 'step', 'stp', 'jpg', 'jpeg', 'png', 'pdf'];

// Deliberately simple: one @, a dot in the domain, no whitespace. Anything
// stricter rejects valid addresses; the real check is whether they reply.
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

function fieldError(name) {
  return document.getElementById(name + 'Error');
}

function setError(name, message) {
  const field = form.querySelector('[name=' + name + ']');
  const slot = fieldError(name);
  if (field) {
    field.classList.add('invalid');
    field.setAttribute('aria-invalid', 'true');
  }
  if (slot) {
    slot.textContent = message;
    slot.classList.add('show');
  }
}

function clearError(name) {
  const field = form.querySelector('[name=' + name + ']');
  const slot = fieldError(name);
  if (field) {
    field.classList.remove('invalid');
    field.removeAttribute('aria-invalid');
  }
  if (slot) slot.classList.remove('show');
}

function clearAllErrors() {
  ['name', 'email', 'phone', 'qty', 'type', 'desc', 'file'].forEach(clearError);
  fileDrop?.classList.remove('invalid');
  formError?.classList.remove('show');
}

function showFormError(message) {
  if (!formError) return;
  formErrorText.textContent = message;
  formError.classList.add('show');
}

// Returns an array of {field, message}. Empty means valid.
function validateForm() {
  const errors = [];
  const val = (n) => (form.querySelector('[name=' + n + ']')?.value || '').trim();

  const name = val('name');
  if (!name) errors.push({ field: 'name', message: 'Please enter your name.' });
  else if (name.length < 2) errors.push({ field: 'name', message: 'That name looks too short.' });

  const email = val('email');
  if (!email) errors.push({ field: 'email', message: 'Please enter your email address.' });
  else if (!EMAIL_RE.test(email)) errors.push({ field: 'email', message: "That doesn't look like a valid email address." });

  // Optional, but if given it should be dialable.
  const phone = val('phone');
  if (phone) {
    const digits = phone.replace(/\D/g, '');
    if (digits.length < 7 || digits.length > 15) {
      errors.push({ field: 'phone', message: 'Please enter a valid phone number, or leave it blank.' });
    }
  }

  if (!val('type')) errors.push({ field: 'type', message: 'Please choose a print type.' });

  const desc = val('desc');
  if (!desc) errors.push({ field: 'desc', message: 'Please describe what you would like printed.' });
  else if (desc.length < 10) errors.push({ field: 'desc', message: 'Please add a little more detail (at least 10 characters).' });

  // qty has value="1" and min="1", but novalidate means the browser won't
  // enforce either — a user can clear it or type 0.
  const qtyRaw = val('qty');
  const qty = Number(qtyRaw);
  if (!qtyRaw || !Number.isInteger(qty) || qty < 1) {
    errors.push({ field: 'qty', message: 'Quantity must be a whole number of 1 or more.' });
  } else if (qty > 1000) {
    errors.push({ field: 'qty', message: 'For runs over 1000, please email me directly.' });
  }

  const file = fileInput?.files?.[0];
  if (file) {
    const ext = file.name.split('.').pop().toLowerCase();
    if (!ALLOWED_EXTS.includes(ext)) {
      errors.push({ field: 'file', message: 'Unsupported file type. Use STL, OBJ, 3MF, STEP, JPG, PNG or PDF.' });
    } else if (file.size > MAX_FILE_BYTES) {
      errors.push({ field: 'file', message: 'File is ' + formatBytes(file.size) + ' — the limit is 100MB.' });
    } else if (file.size === 0) {
      errors.push({ field: 'file', message: 'That file appears to be empty.' });
    }
  }

  return errors;
}

// Clear a field's error as soon as the user starts fixing it.
['name', 'email', 'phone', 'qty', 'type', 'desc'].forEach(n => {
  const field = form?.querySelector('[name=' + n + ']');
  if (!field) return;
  const evt = field.tagName === 'SELECT' ? 'change' : 'input';
  field.addEventListener(evt, () => clearError(n));
});

form?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = form.querySelector('.form-submit');

  clearAllErrors();
  const errors = validateForm();
  if (errors.length) {
    errors.forEach(err => {
      if (err.field === 'file') {
        fileDrop?.classList.add('invalid');
        const slot = fieldError('file');
        if (slot) { slot.textContent = err.message; slot.classList.add('show'); }
      } else {
        setError(err.field, err.message);
      }
    });
    showFormError(
      errors.length === 1
        ? 'Please fix the highlighted field before sending.'
        : 'Please fix the ' + errors.length + ' highlighted fields before sending.'
    );
    // Focus the first offender so keyboard users land on it.
    const first = errors[0].field === 'file' ? fileInput : form.querySelector('[name=' + errors[0].field + ']');
    (errors[0].field === 'file' ? fileDrop : first)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (errors[0].field !== 'file') first?.focus({ preventScroll: true });
    return;
  }

  btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Sending…';
  btn.disabled = true;

  const payload = {
    name:  form.querySelector('[name=name]').value.trim(),
    email: form.querySelector('[name=email]').value.trim(),
    phone: form.querySelector('[name=phone]').value.trim() || 'Not provided',
    type:  form.querySelector('[name=type]').value,
    qty:   form.querySelector('[name=qty]').value,
    desc:  form.querySelector('[name=desc]').value.trim(),
    file_url: '',
    file_name: '',
  };

  // Upload file if provided
  const file = fileInput?.files?.[0];
  if (file) {
    btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Uploading file…';
    try {
      payload.file_url = await uploadFile(file);
      payload.file_name = file.name;
    } catch {
      showFormError('The file upload failed. Please check your connection and try again.');
      btn.innerHTML = SUBMIT_LABEL;
      btn.disabled = false;
      return;
    }
  }

  btn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="animation:spin 1s linear infinite"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Sending…';

  try {
    const res = await fetch('/api/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      formContent.style.display = 'none';
      formSuccess.classList.add('show');
    } else {
      // The Worker returns { error } with a message meant for the customer.
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Status ${res.status}`);
    }
  } catch (err) {
    showFormError(err?.message || 'Something went wrong sending your request. Please try again, or email aswin@aswincloud.com.');
    btn.innerHTML = SUBMIT_LABEL;
    btn.disabled = false;
    console.error('Quote submit error:', err);
  }
});

/* ===== COUNTER ANIMATION ===== */
function animateCounter(el, end, suffix = '') {
  let start = 0;
  const duration = 1800;
  const step = (timestamp) => {
    if (!start) start = timestamp;
    const progress = Math.min((timestamp - start) / duration, 1);
    const value = Math.floor(progress * end);
    el.textContent = value + suffix;
    if (progress < 1) requestAnimationFrame(step);
    else el.textContent = end + suffix;
  };
  requestAnimationFrame(step);
}

const statsObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      document.querySelectorAll('[data-count]').forEach(el => {
        animateCounter(el, parseInt(el.dataset.count), el.dataset.suffix || '');
      });
      statsObserver.disconnect();
    }
  });
}, { threshold: 0.5 });

const statsEl = document.querySelector('.hero-stats');
if (statsEl) statsObserver.observe(statsEl);

/* ===== SMOOTH SCROLL FOR ANCHOR LINKS ===== */
document.querySelectorAll('a[href^="#"]').forEach(a => {
  a.addEventListener('click', e => {
    e.preventDefault();
    const target = document.querySelector(a.getAttribute('href'));
    if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

/* ===== SHOP & CART ===== */
/* The cart stores ONLY { id, qty } in localStorage. No prices, no names.
   Everything shown is re-derived from /api/products on load, and the amount
   actually charged is computed server-side at checkout — so a hand-edited
   localStorage entry can change what you see, never what you pay. */

const CART_KEY = 'ap_cart';
const MAX_QTY = 100; // mirrors MAX_QTY in src/shop.js

const productGrid = document.getElementById('productGrid');
const cartBtn = document.getElementById('cartBtn');
const cartBadge = document.getElementById('cartBadge');
const cartDrawer = document.getElementById('cartDrawer');
const cartOverlay = document.getElementById('cartOverlay');
const cartBody = document.getElementById('cartBody');
const cartFoot = document.getElementById('cartFoot');
const shopShipNote = document.getElementById('shopShipNote');

let catalogue = [];              // products from the API
let shipCfg = { flat_paise: 0, free_threshold_paise: 0 };

/* ── money ─────────────────────────────────────────────────────── */
// Mirrors rupees() in src/lib.js so the drawer and the emails agree.
function rupees(paise) {
  return '₹' + (Math.round(Number(paise) || 0) / 100)
    .toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/* ── cart storage ──────────────────────────────────────────────── */
// Anything unparseable is treated as an empty cart rather than thrown — a
// corrupt localStorage value must not break the whole page.
function readCart() {
  try {
    const raw = JSON.parse(localStorage.getItem(CART_KEY) || '[]');
    if (!Array.isArray(raw)) return [];
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
  } catch {
    // Private mode / quota. The in-memory cart still works for this session.
  }
  renderCart();
  // Mirror to the account for a signed-in customer. Defined further down; the
  // guard inside makes this a no-op for guests.
  if (typeof syncCartUp === 'function') syncCartUp();
}

function cartCount(cart = readCart()) {
  return cart.reduce((n, it) => n + it.qty, 0);
}

function addToCart(id) {
  const cart = readCart();
  const line = cart.find((it) => it.id === id);
  if (line) {
    if (line.qty >= MAX_QTY) return false;
    line.qty += 1;
  } else {
    cart.push({ id, qty: 1 });
  }
  writeCart(cart);
  return true;
}

function setQty(id, qty) {
  let cart = readCart();
  if (qty < 1) cart = cart.filter((it) => it.id !== id);
  else {
    const line = cart.find((it) => it.id === id);
    if (line) line.qty = Math.min(MAX_QTY, qty);
  }
  writeCart(cart);
}

/* ── shipping (display only) ───────────────────────────────────── */
// Same rule as shippingFor() in src/shop.js, duplicated here purely so the
// drawer can show a total before the server is asked. The server's figure is
// authoritative; this one is never sent anywhere.
function shippingForDisplay(subtotal) {
  if (subtotal <= 0) return 0;
  return subtotal >= shipCfg.free_threshold_paise ? 0 : shipCfg.flat_paise;
}

/* ── catalogue ─────────────────────────────────────────────────── */
async function loadProducts() {
  if (!productGrid) return;
  try {
    const res = await fetch('/api/products');
    if (!res.ok) throw new Error('Status ' + res.status);
    const data = await res.json();
    catalogue = Array.isArray(data.products) ? data.products : [];
    if (data.shipping) shipCfg = data.shipping;
    renderProducts();
    renderShipNote();
    renderCart();
  } catch (err) {
    productGrid.innerHTML =
      '<p class="shop-error">Couldn\'t load the shop right now. ' +
      'Please refresh, or <a href="#quote">send a quote request</a> instead.</p>';
  }
}

// textContent/setAttribute throughout rather than innerHTML with interpolation:
// product names and descriptions are admin-editable, so they're untrusted here.
function renderProducts() {
  productGrid.innerHTML = '';
  if (!catalogue.length) {
    productGrid.innerHTML = '<p class="shop-empty">Nothing listed just yet — check back soon.</p>';
    return;
  }

  for (const p of catalogue) {
    const card = document.createElement('div');
    card.className = 'product-card';

    const media = document.createElement('div');
    media.className = 'product-media';
    const img = document.createElement('img');
    img.src = p.image;
    img.alt = p.name;
    img.loading = 'lazy';
    media.appendChild(img);

    const body = document.createElement('div');
    body.className = 'product-body';

    const name = document.createElement('div');
    name.className = 'product-name';
    name.textContent = p.name;

    const desc = document.createElement('p');
    desc.className = 'product-desc';
    desc.textContent = p.description || '';

    const foot = document.createElement('div');
    foot.className = 'product-foot';

    const price = document.createElement('div');
    price.className = 'product-price';
    price.textContent = rupees(p.price_paise);

    const add = document.createElement('button');
    add.className = 'product-add';
    add.type = 'button';
    add.textContent = 'Add to cart';
    add.setAttribute('aria-label', 'Add ' + p.name + ' to cart');
    add.addEventListener('click', () => {
      if (!addToCart(p.id)) {
        add.textContent = 'Max ' + MAX_QTY;
      } else {
        add.textContent = 'Added ✓';
        add.classList.add('added');
      }
      setTimeout(() => {
        add.textContent = 'Add to cart';
        add.classList.remove('added');
      }, 1200);
    });

    foot.append(price, add);
    body.append(name, desc, foot);
    card.append(media, body);
    productGrid.appendChild(card);
  }
}

function renderShipNote() {
  if (!shopShipNote || !shipCfg.free_threshold_paise) return;
  shopShipNote.textContent =
    '🚚 Flat ' + rupees(shipCfg.flat_paise) + ' shipping across India — free over ' +
    rupees(shipCfg.free_threshold_paise) + '. Local pickup in Pondicherry is always free.';
  shopShipNote.classList.add('show');
}

/* ── cart rendering ────────────────────────────────────────────── */
function renderCart() {
  const cart = readCart();
  const count = cartCount(cart);

  if (cartBadge) {
    cartBadge.textContent = String(count);
    cartBadge.hidden = count === 0;
  }

  if (!cartBody) return;
  cartBody.innerHTML = '';

  // Lines whose product has vanished from the catalogue are dropped here
  // rather than shown at a guessed price.
  const lines = cart
    .map((it) => ({ it, p: catalogue.find((c) => c.id === it.id) }))
    .filter((row) => row.p);

  if (!lines.length) {
    cartBody.innerHTML = '<p class="cart-empty">Your cart is empty.<br>Browse the shop to add something.</p>';
    if (cartFoot) cartFoot.hidden = true;
    return;
  }

  let subtotal = 0;
  for (const { it, p } of lines) {
    subtotal += p.price_paise * it.qty;

    const row = document.createElement('div');
    row.className = 'cart-item';

    const img = document.createElement('img');
    img.src = p.image;
    img.alt = '';
    img.loading = 'lazy';

    const info = document.createElement('div');
    info.className = 'cart-item-info';

    const name = document.createElement('div');
    name.className = 'cart-item-name';
    name.textContent = p.name;

    const price = document.createElement('div');
    price.className = 'cart-item-price';
    price.textContent = rupees(p.price_paise) + ' × ' + it.qty + ' = ' + rupees(p.price_paise * it.qty);

    const qty = document.createElement('div');
    qty.className = 'cart-qty';
    const minus = document.createElement('button');
    minus.type = 'button';
    minus.textContent = '−';
    minus.setAttribute('aria-label', 'Decrease quantity of ' + p.name);
    minus.addEventListener('click', () => setQty(it.id, it.qty - 1));
    const n = document.createElement('span');
    n.textContent = String(it.qty);
    const plus = document.createElement('button');
    plus.type = 'button';
    plus.textContent = '+';
    plus.setAttribute('aria-label', 'Increase quantity of ' + p.name);
    plus.disabled = it.qty >= MAX_QTY;
    plus.addEventListener('click', () => setQty(it.id, it.qty + 1));
    qty.append(minus, n, plus);

    const remove = document.createElement('button');
    remove.className = 'cart-item-remove';
    remove.type = 'button';
    remove.textContent = '✕';
    remove.setAttribute('aria-label', 'Remove ' + p.name + ' from cart');
    remove.addEventListener('click', () => setQty(it.id, 0));

    info.append(name, price, qty);
    row.append(img, info, remove);
    cartBody.appendChild(row);
  }

  const shipping = shippingForDisplay(subtotal);
  const setText = (id, text) => {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
  };
  setText('cartSubtotal', rupees(subtotal));
  setText('cartShipping', rupees(shipping));
  setText('cartShipLabel', shipping === 0 ? 'Shipping (free)' : 'Shipping');
  setText('cartTotal', rupees(subtotal + shipping));

  const hint = document.getElementById('cartShipHint');
  if (hint) {
    const short = shipCfg.free_threshold_paise - subtotal;
    hint.textContent = shipping > 0 && short > 0
      ? 'Add ' + rupees(short) + ' more for free shipping'
      : '';
  }

  if (cartFoot) cartFoot.hidden = false;
}

/* ── drawer open/close ─────────────────────────────────────────── */
function openCart() {
  cartDrawer?.classList.add('open');
  cartDrawer?.setAttribute('aria-hidden', 'false');
  if (cartOverlay) cartOverlay.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeCart() {
  cartDrawer?.classList.remove('open');
  cartDrawer?.setAttribute('aria-hidden', 'true');
  if (cartOverlay) cartOverlay.hidden = true;
  document.body.style.overflow = '';
}

cartBtn?.addEventListener('click', openCart);
document.getElementById('cartClose')?.addEventListener('click', closeCart);
cartOverlay?.addEventListener('click', closeCart);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && cartDrawer?.classList.contains('open')) closeCart();
});

// Keep two open tabs in step.
window.addEventListener('storage', (e) => {
  if (e.key === CART_KEY) renderCart();
});

renderCart();      // paint the badge from localStorage before the fetch lands
loadProducts();

/* ===== CHECKOUT ===== */
/* Flow:
     1. POST /api/orders with {items:[{product_id,qty}], customer, delivery}
        — no amount. The server prices the cart from D1.
     2. Open Razorpay Checkout with the order id and key id it returns.
     3. On success, POST the three razorpay_* fields to /api/orders/verify.
        That only proves the callback is genuine so we can show a receipt —
        the order is marked paid by the webhook, which is Razorpay's word and
        arrives even if this tab is closed. */

const checkoutModal = document.getElementById('checkoutModal');
const checkoutOverlay = document.getElementById('checkoutOverlay');
const checkoutForm = document.getElementById('checkoutForm');
const coError = document.getElementById('coError');
const coSubmit = document.getElementById('coSubmit');
const coSubmitLabel = document.getElementById('coSubmitLabel');
const coAddress = document.getElementById('coAddress');

const SHIP_FIELDS = ['co_line', 'co_city', 'co_state', 'co_pin'];

function deliveryMode() {
  const el = checkoutForm?.querySelector('input[name="delivery"]:checked');
  return el?.value === 'pickup' ? 'pickup' : 'ship';
}

/* ── field validation ──────────────────────────────────────────── */
/* Same shape as the quote form's helpers. These are UX only — the Worker
   re-validates everything in validateCustomer(). */
function coSetError(name, message) {
  const field = checkoutForm.querySelector('[name="' + name + '"]');
  const slot = document.getElementById(name + 'Error');
  if (field) { field.classList.add('invalid'); field.setAttribute('aria-invalid', 'true'); }
  if (slot) { slot.textContent = message; slot.classList.add('show'); }
}

function coClearError(name) {
  const field = checkoutForm.querySelector('[name="' + name + '"]');
  const slot = document.getElementById(name + 'Error');
  if (field) { field.classList.remove('invalid'); field.removeAttribute('aria-invalid'); }
  if (slot) { slot.textContent = ''; slot.classList.remove('show'); }
}

function coClearAll() {
  ['co_name', 'co_email', 'co_phone', ...SHIP_FIELDS].forEach(coClearError);
  if (coError) { coError.hidden = true; coError.textContent = ''; }
}

function showCoError(message) {
  if (!coError) return;
  coError.textContent = message;
  coError.hidden = false;
  coError.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function validateCheckout() {
  coClearAll();
  const v = (n) => (checkoutForm.querySelector('[name="' + n + '"]')?.value || '').trim();
  let firstBad = null;
  const bad = (n, msg) => { coSetError(n, msg); if (!firstBad) firstBad = n; };

  if (v('co_name').length < 2) bad('co_name', 'Please enter your name.');
  if (!EMAIL_RE.test(v('co_email'))) bad('co_email', 'Please enter a valid email address.');
  if (v('co_phone').replace(/\D/g, '').length < 10) bad('co_phone', 'Please enter a valid phone number.');

  if (deliveryMode() === 'ship') {
    if (v('co_line').length < 5) bad('co_line', 'Please enter your street address.');
    if (!v('co_city')) bad('co_city', 'Please enter your city.');
    if (!v('co_state')) bad('co_state', 'Please enter your state.');
    if (!/^\d{6}$/.test(v('co_pin'))) bad('co_pin', 'Please enter a valid 6-digit PIN code.');
  }

  if (firstBad) checkoutForm.querySelector('[name="' + firstBad + '"]')?.focus();
  return !firstBad;
}

/* ── summary ───────────────────────────────────────────────────── */
function renderCoSummary() {
  const el = document.getElementById('coSummary');
  if (!el) return;
  const lines = readCart()
    .map((it) => ({ it, p: catalogue.find((c) => c.id === it.id) }))
    .filter((r) => r.p);

  let subtotal = 0;
  el.innerHTML = '';
  for (const { it, p } of lines) {
    subtotal += p.price_paise * it.qty;
    const row = document.createElement('div');
    row.className = 'co-line';
    const l = document.createElement('span');
    l.textContent = p.name + ' × ' + it.qty;
    const r = document.createElement('strong');
    r.textContent = rupees(p.price_paise * it.qty);
    row.append(l, r);
    el.appendChild(row);
  }

  const shipping = deliveryMode() === 'pickup' ? 0 : shippingForDisplay(subtotal);
  const addRow = (label, value, cls) => {
    const row = document.createElement('div');
    row.className = 'co-line' + (cls ? ' ' + cls : '');
    const l = document.createElement('span');
    l.textContent = label;
    const r = document.createElement('strong');
    r.textContent = value;
    row.append(l, r);
    el.appendChild(row);
  };
  addRow('Subtotal', rupees(subtotal));
  addRow(shipping === 0 ? 'Shipping (free)' : 'Shipping', rupees(shipping));
  addRow('Total', rupees(subtotal + shipping), 'co-line-total');
}

/* ── open / close ──────────────────────────────────────────────── */
function openCheckout() {
  if (!checkoutModal) return;
  if (!readCart().length) return;
  coClearAll();
  renderCoSummary();
  syncAddressVisibility();
  if (typeof prefillCheckout === 'function') prefillCheckout();
  checkoutModal.hidden = false;
  checkoutOverlay.hidden = false;
  checkoutModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  document.getElementById('coName')?.focus();
}

function closeCheckout() {
  if (!checkoutModal) return;
  checkoutModal.hidden = true;
  checkoutOverlay.hidden = true;
  checkoutModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

function syncAddressVisibility() {
  const ship = deliveryMode() === 'ship';
  if (coAddress) coAddress.hidden = !ship;
  // A hidden field must not keep a stale error that blocks submit.
  if (!ship) SHIP_FIELDS.forEach(coClearError);
  renderCoSummary();
}

document.getElementById('cartCheckout')?.addEventListener('click', () => {
  closeCart();
  openCheckout();
});
document.getElementById('checkoutClose')?.addEventListener('click', closeCheckout);
checkoutOverlay?.addEventListener('click', closeCheckout);
checkoutForm?.querySelectorAll('input[name="delivery"]').forEach((r) =>
  r.addEventListener('change', syncAddressVisibility));

// Clear a field's error as soon as it's corrected.
checkoutForm?.querySelectorAll('input, textarea').forEach((el) => {
  el.addEventListener('input', () => { if (el.name) coClearError(el.name); });
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && checkoutModal && !checkoutModal.hidden) closeCheckout();
});

/* ── submit → Razorpay ─────────────────────────────────────────── */
let checkoutBusy = false;

checkoutForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (checkoutBusy) return;
  if (!validateCheckout()) return;

  if (typeof window.Razorpay !== 'function') {
    showCoError("Payment couldn't load. Check your connection and try again, or use the quote form.");
    return;
  }

  const v = (n) => (checkoutForm.querySelector('[name="' + n + '"]')?.value || '').trim();
  const delivery = deliveryMode();

  setCheckoutBusy(true, 'Starting payment…');

  let data;
  try {
    // Only ids and quantities. The server prices it.
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: readCart().map((it) => ({ product_id: it.id, qty: it.qty })),
        delivery,
        customer: {
          name: v('co_name'),
          email: v('co_email'),
          phone: v('co_phone'),
          addr_line: v('co_line'),
          addr_city: v('co_city'),
          addr_state: v('co_state'),
          addr_pin: v('co_pin'),
          notes: v('co_notes'),
        },
      }),
    });
    data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Status ' + res.status);
  } catch (err) {
    setCheckoutBusy(false);
    showCoError(err.message || "We couldn't start the payment. Please try again.");
    return;
  }

  setCheckoutBusy(true, 'Opening payment…');
  openRazorpay(data, v('co_name'), v('co_email'), v('co_phone'));
});

function setCheckoutBusy(busy, label) {
  checkoutBusy = busy;
  if (coSubmit) coSubmit.disabled = busy;
  if (coSubmitLabel) coSubmitLabel.textContent = busy ? (label || 'Working…') : 'Pay securely';
}

function openRazorpay(data, name, email, phone) {
  const rzp = new window.Razorpay({
    key: data.key_id,           // public key id only — the secret never leaves the Worker
    order_id: data.rzp_order_id,
    amount: data.amount,        // server-computed; shown by the modal
    currency: data.currency || 'INR',
    name: 'AswinPrints',
    description: 'Order ' + data.receipt,
    prefill: { name, email, contact: phone },
    notes: { receipt: data.receipt },
    theme: { color: '#ff6b00' },
    modal: {
      // User closed the modal without paying. The order stays 'pending' —
      // they can retry, and nothing was charged.
      ondismiss() {
        setCheckoutBusy(false);
        showCoError('Payment cancelled. Your cart is still here whenever you\'re ready.');
      },
    },
    handler(response) { verifyPayment(response, data); },
  });

  rzp.on('payment.failed', (resp) => {
    setCheckoutBusy(false);
    const d = resp?.error?.description || 'The payment did not go through.';
    showCoError(d + ' You can try again — nothing has been charged.');
  });

  rzp.open();
}

async function verifyPayment(response, orderData) {
  setCheckoutBusy(true, 'Confirming…');
  try {
    const res = await fetch('/api/orders/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        razorpay_payment_id: response.razorpay_payment_id,
        razorpay_order_id: response.razorpay_order_id,
        razorpay_signature: response.razorpay_signature,
      }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || !out.ok) throw new Error(out.error || 'Verification failed');

    // Paid — the cart has served its purpose.
    writeCart([]);
    setCheckoutBusy(false);
    closeCheckout();
    showReceipt(out.receipt, orderData);
  } catch (err) {
    setCheckoutBusy(false);
    // The money may well have left their account, so never imply it didn't.
    showCoError(
      'Your payment went through but we couldn\'t confirm it here. ' +
      'Payment reference ' + (response.razorpay_payment_id || '—') +
      '. Please email aswin@aswincloud.com with that reference and I\'ll sort it out.'
    );
  }
}

/* ── receipt ───────────────────────────────────────────────────── */
function showReceipt(receipt, orderData) {
  const modal = document.getElementById('receiptModal');
  const overlay = document.getElementById('receiptOverlay');
  if (!modal) return;

  const ref = document.getElementById('receiptRef');
  if (ref) ref.textContent = receipt || '—';

  const sub = document.getElementById('receiptSub');
  if (sub && orderData) sub.textContent = 'Thank you — ' + rupees(orderData.total_paise) + ' paid.';

  const sum = document.getElementById('receiptSummary');
  if (sum && orderData) {
    sum.innerHTML = '';
    const addRow = (label, value, cls) => {
      const row = document.createElement('div');
      row.className = 'co-line' + (cls ? ' ' + cls : '');
      const l = document.createElement('span');
      l.textContent = label;
      const r = document.createElement('strong');
      r.textContent = value;
      row.append(l, r);
      sum.appendChild(row);
    };
    addRow('Subtotal', rupees(orderData.subtotal_paise));
    addRow(orderData.shipping_paise === 0 ? 'Shipping (free)' : 'Shipping', rupees(orderData.shipping_paise));
    addRow('Total paid', rupees(orderData.total_paise), 'co-line-total');
  }

  modal.hidden = false;
  overlay.hidden = false;
  modal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  document.getElementById('receiptClose')?.focus();
}

function closeReceipt() {
  const modal = document.getElementById('receiptModal');
  const overlay = document.getElementById('receiptOverlay');
  if (!modal) return;
  modal.hidden = true;
  overlay.hidden = true;
  modal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

document.getElementById('receiptClose')?.addEventListener('click', closeReceipt);
document.getElementById('receiptOverlay')?.addEventListener('click', closeReceipt);


/* ===== ACCOUNT: SIGN IN, MENU, ORDERS ===== */
/* All inline on this page — there is no /login or /account route. The dashboard
   at /shop is the one remaining separate page, and the ONLY way to reach it is
   the menu entry added below when /api/me reports is_admin. */

let currentUser = null;

const accountBtn = document.getElementById('accountBtn');
const accountMenu = document.getElementById('accountMenu');
const signinModal = document.getElementById('signinModal');
const signinOverlay = document.getElementById('signinOverlay');
const siError = document.getElementById('siError');

/* ── session ────────────────────────────────────────────────────── */
async function loadSession() {
  try {
    const me = await (await fetch('/api/me')).json();
    if (!me.signedIn) return applyGuestState();
    currentUser = me;
    applySignedInState(me);
    await adoptServerCart();
  } catch {
    applyGuestState();       // offline or 401 — the shop works either way
  }
}

function applyGuestState() {
  currentUser = null;
  accountBtn?.setAttribute('aria-label', 'Sign in');
  accountBtn?.setAttribute('title', 'Sign in');
  const dot = document.getElementById('accountDot');
  if (dot) dot.hidden = true;
  if (accountMenu) accountMenu.hidden = true;
  const tabs = document.getElementById('drawerTabs');
  if (tabs) tabs.hidden = true;
}

function applySignedInState(me) {
  accountBtn?.setAttribute('aria-label', 'Account menu (' + me.email + ')');
  accountBtn?.setAttribute('title', me.name || me.email);
  const dot = document.getElementById('accountDot');
  if (dot) dot.hidden = false;

  const who = document.getElementById('accountMenuWho');
  if (who) who.textContent = me.name ? `${me.name} · ${me.email}` : me.email;

  // Dashboard entry, admins only. This is a DISPLAY decision — /api/admin/*
  // re-checks the allowlist server-side, so a faked is_admin shows a link that
  // leads to a 401.
  if (me.is_admin && !document.getElementById('menuDashboard')) {
    const item = document.createElement('button');
    item.type = 'button';
    item.id = 'menuDashboard';
    item.className = 'account-menu-item is-admin';
    item.setAttribute('role', 'menuitem');
    item.textContent = 'Dashboard';
    item.addEventListener('click', () => { location.href = '/shop'; });
    accountMenu.insertBefore(item, document.getElementById('menuOrders'));
  }

  // Orders tab in the drawer becomes available.
  const tabs = document.getElementById('drawerTabs');
  if (tabs) tabs.hidden = false;
}

/* ── account button: sign in, or open the menu ─────────────────── */
accountBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  if (!currentUser) return openSignin();
  const open = !accountMenu.hidden;
  accountMenu.hidden = open;
  accountBtn.setAttribute('aria-expanded', String(!open));
});

document.addEventListener('click', (e) => {
  if (accountMenu && !accountMenu.hidden && !e.target.closest('.nav-account')) {
    accountMenu.hidden = true;
    accountBtn?.setAttribute('aria-expanded', 'false');
  }
});

document.getElementById('menuSignOut')?.addEventListener('click', async () => {
  try { await fetch('/api/me/logout', { method: 'POST' }); } catch { /* ignore */ }
  // Clear the mirrored cart so the next visitor on this browser starts clean.
  try { localStorage.removeItem(CART_KEY); } catch { /* ignore */ }
  location.reload();
});

document.getElementById('menuOrders')?.addEventListener('click', () => {
  accountMenu.hidden = true;
  openCart();
  selectDrawerTab('orders');
});

/* ── sign-in modal ─────────────────────────────────────────────── */
function openSignin() {
  if (!signinModal) return;
  siBanner('');
  siClear('si_email'); siClear('si_code');
  document.getElementById('siCodeForm').hidden = true;
  document.getElementById('siEmailForm').hidden = false;
  signinModal.hidden = false;
  signinOverlay.hidden = false;
  signinModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  document.getElementById('siEmail')?.focus();
}

function closeSignin() {
  if (!signinModal) return;
  clearInterval(siCooldownTimer);
  signinModal.hidden = true;
  signinOverlay.hidden = true;
  signinModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

document.getElementById('signinClose')?.addEventListener('click', closeSignin);
signinOverlay?.addEventListener('click', closeSignin);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && signinModal && !signinModal.hidden) closeSignin();
});

function siBanner(message) {
  if (!siError) return;
  siError.textContent = message || '';
  siError.hidden = !message;
}

function siSetErr(name, message) {
  const f = document.querySelector('[name="' + name + '"]');
  const slot = document.getElementById(name + 'Error');
  if (f) { f.classList.add('invalid'); f.setAttribute('aria-invalid', 'true'); }
  if (slot) { slot.textContent = message; slot.classList.add('show'); }
}

function siClear(name) {
  const f = document.querySelector('[name="' + name + '"]');
  const slot = document.getElementById(name + 'Error');
  if (f) { f.classList.remove('invalid'); f.removeAttribute('aria-invalid'); }
  if (slot) slot.classList.remove('show');
}

['siEmail', 'siCode'].forEach((id) => {
  document.getElementById(id)?.addEventListener('input', (e) => {
    siClear(e.target.name);
    siBanner('');
  });
});

let siPendingEmail = '';
let siCooldownTimer = null;

document.getElementById('siEmailForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  siClear('si_email'); siBanner('');
  const email = document.getElementById('siEmail').value.trim();
  if (!EMAIL_RE.test(email)) return siSetErr('si_email', 'Please enter a valid email address.');

  const btn = document.getElementById('siSendBtn');
  const label = document.getElementById('siSendLabel');
  btn.disabled = true; label.textContent = 'Sending…';
  try {
    const res = await fetch('/api/auth/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not send the code.');

    siPendingEmail = email;
    document.getElementById('siSentTo').textContent = email;
    if (data.ttl_minutes) document.getElementById('siTtl').textContent = String(data.ttl_minutes);
    document.getElementById('siEmailForm').hidden = true;
    document.getElementById('siCodeForm').hidden = false;
    document.getElementById('siCode').focus();
    siStartCooldown(60);
  } catch (err) {
    siBanner(err.message);
  } finally {
    btn.disabled = false; label.textContent = 'Email me a code';
  }
});

document.getElementById('siCodeForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  siClear('si_code'); siBanner('');
  const code = document.getElementById('siCode').value.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) return siSetErr('si_code', 'Enter the 6-digit code from the email.');

  const btn = document.getElementById('siVerifyBtn');
  const label = document.getElementById('siVerifyLabel');
  btn.disabled = true; label.textContent = 'Signing in…';
  try {
    const res = await fetch('/api/auth/code/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: siPendingEmail, code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'That code did not work.');

    closeSignin();
    // Reload rather than patching state in place: the cart, the badge, the menu
    // and the checkout prefill all depend on the session, and a reload gets
    // every one of them right without a second code path.
    location.reload();
  } catch (err) {
    siBanner(err.message);
    btn.disabled = false; label.textContent = 'Sign in';
  }
});

function siStartCooldown(seconds) {
  clearInterval(siCooldownTimer);
  const btn = document.getElementById('siResendBtn');
  if (!btn) return;
  let left = seconds;
  const tick = () => {
    if (left <= 0) {
      clearInterval(siCooldownTimer);
      btn.disabled = false;
      btn.textContent = 'Resend code';
      return;
    }
    btn.disabled = true;
    btn.textContent = `Resend in ${left}s`;
    left -= 1;
  };
  tick();
  siCooldownTimer = setInterval(tick, 1000);
}

document.getElementById('siResendBtn')?.addEventListener('click', async () => {
  siBanner('');
  try {
    const res = await fetch('/api/auth/code/resend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: siPendingEmail }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not resend.');
    siStartCooldown(data.cooldown_seconds || 60);
    if (data.cooldown_seconds) siBanner(`Please wait ${data.cooldown_seconds}s for another code.`);
  } catch (err) {
    siBanner(err.message);
  }
});

document.getElementById('siBackBtn')?.addEventListener('click', () => {
  clearInterval(siCooldownTimer);
  siBanner(''); siClear('si_code');
  document.getElementById('siCode').value = '';
  document.getElementById('siCodeForm').hidden = true;
  document.getElementById('siEmailForm').hidden = false;
  document.getElementById('siEmail').focus();
});

/* ── drawer tabs: cart / orders ────────────────────────────────── */
function selectDrawerTab(which) {
  const isCart = which === 'cart';
  document.getElementById('tabCart')?.classList.toggle('active', isCart);
  document.getElementById('tabOrders')?.classList.toggle('active', !isCart);
  document.getElementById('tabCart')?.setAttribute('aria-selected', String(isCart));
  document.getElementById('tabOrders')?.setAttribute('aria-selected', String(!isCart));
  document.getElementById('cartBody').hidden = !isCart;
  document.getElementById('ordersBody').hidden = isCart;
  const foot = document.getElementById('cartFoot');
  // The checkout footer belongs to the cart, not to the order list.
  if (foot) foot.style.display = isCart ? '' : 'none';
  const title = document.getElementById('drawerTitle');
  if (title) title.textContent = isCart ? 'Your Cart' : 'My Orders';
  if (!isCart) loadMyOrders();
}

document.getElementById('tabCart')?.addEventListener('click', () => selectDrawerTab('cart'));
document.getElementById('tabOrders')?.addEventListener('click', () => selectDrawerTab('orders'));

async function loadMyOrders() {
  const box = document.getElementById('ordersBody');
  if (!box) return;
  box.innerHTML = '';
  const p = document.createElement('p');
  p.className = 'cart-empty';
  p.textContent = 'Loading…';
  box.appendChild(p);

  try {
    const res = await fetch('/api/me/orders');
    if (!res.ok) throw new Error('Please sign in again.');
    const { orders } = await res.json();
    box.innerHTML = '';
    if (!orders.length) {
      const empty = document.createElement('p');
      empty.className = 'cart-empty';
      empty.textContent = "You haven't placed any orders yet.";
      box.appendChild(empty);
      return;
    }
    for (const o of orders) box.appendChild(myOrderRow(o));
  } catch (err) {
    box.innerHTML = '';
    const e = document.createElement('p');
    e.className = 'cart-empty';
    e.textContent = err.message;
    box.appendChild(e);
  }
}

// textContent throughout: order notes are admin-editable, so interpolating them
// into innerHTML would be a stored-XSS path.
function myOrderRow(o) {
  const wrap = document.createElement('div');
  wrap.className = 'my-order';

  const top = document.createElement('div');
  top.className = 'my-order-top';

  const left = document.createElement('div');
  const ref = document.createElement('div');
  ref.className = 'my-order-ref';
  ref.textContent = o.receipt;
  const badge = document.createElement('span');
  badge.className = 'my-order-status st-' + o.status;
  badge.textContent = o.status;
  ref.appendChild(badge);
  const date = document.createElement('div');
  date.className = 'my-order-date';
  date.textContent = new Date(Number(o.created_at)).toLocaleDateString('en-IN',
    { day: 'numeric', month: 'short', year: 'numeric' });
  left.append(ref, date);

  const total = document.createElement('div');
  total.className = 'my-order-total';
  total.textContent = rupees(o.total_paise);

  top.append(left, total);
  wrap.appendChild(top);

  const ul = document.createElement('ul');
  ul.className = 'my-order-items';
  for (const it of o.items || []) {
    const li = document.createElement('li');
    const n = document.createElement('span');
    n.textContent = `${it.name} × ${it.qty}`;
    const v = document.createElement('span');
    v.textContent = rupees(it.price_paise * it.qty);
    li.append(n, v);
    ul.appendChild(li);
  }
  wrap.appendChild(ul);

  if (o.delivery === 'pickup' || o.shipped_at || o.notes) {
    const meta = document.createElement('div');
    meta.className = 'my-order-date';
    const bits = [];
    if (o.delivery === 'pickup') bits.push('Local pickup');
    if (o.shipped_at) bits.push('Shipped');
    if (o.notes) bits.push(o.notes);
    meta.textContent = bits.join(' · ');
    wrap.appendChild(meta);
  }

  return wrap;
}

/* ── server cart for a signed-in customer ──────────────────────── */
async function adoptServerCart() {
  try {
    const local = readCart();
    if (local.length) {
      await fetch('/api/me/cart/merge', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: local.map((it) => ({ product_id: it.id, qty: it.qty })) }),
      });
    }
    const res = await fetch('/api/me/cart');
    if (!res.ok) return;
    const { items } = await res.json();
    // setItem directly, NOT writeCart — writeCart triggers syncCartUp, which
    // would push straight back to the server in a loop.
    localStorage.setItem(CART_KEY, JSON.stringify(items.map((it) => ({ id: it.product_id, qty: it.qty }))));
    renderCart();
  } catch { /* keep the local cart */ }
}

// Called from writeCart on every cart mutation. Fire-and-forget: a failed sync
// must never block adding to a cart.
function syncCartUp() {
  if (!currentUser) return;
  fetch('/api/me/cart', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ items: readCart().map((it) => ({ product_id: it.id, qty: it.qty })) }),
  }).catch(() => {});
}

// Prefill checkout for a signed-in customer. The server still validates
// everything, and still reads user_id from the cookie rather than these fields.
function prefillCheckout() {
  if (!currentUser) return;
  const email = document.getElementById('coEmail');
  const name = document.getElementById('coName');
  if (email && !email.value) email.value = currentUser.email || '';
  if (name && !name.value) name.value = currentUser.name || '';
}

/* ── provider buttons ──────────────────────────────────────────── */
/* Rendered from /api/auth/providers, so a provider appearing or disappearing on
   the broker needs no change here. Hidden entirely when the list is empty —
   better no buttons than dead ones. */

// Brand marks, inline so there's no extra request and nothing to 404.
const PROVIDER_ICONS = {
  google: '<svg width="17" height="17" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.27-4.74 3.27-8.1z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.65l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.84 14.11a6.6 6.6 0 0 1 0-4.22V7.05H2.18a11 11 0 0 0 0 9.9l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1a11 11 0 0 0-9.82 6.05l3.66 2.84C6.71 7.31 9.14 5.38 12 5.38z"/></svg>',
  github: '<svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .3a12 12 0 0 0-3.8 23.4c.6.1.8-.3.8-.6v-2.2c-3.3.7-4-1.6-4-1.6-.6-1.4-1.4-1.8-1.4-1.8-1-.7.1-.7.1-.7 1.2.1 1.8 1.2 1.8 1.2 1 1.8 2.8 1.3 3.5 1 .1-.8.4-1.3.8-1.6-2.7-.3-5.5-1.3-5.5-6 0-1.2.5-2.3 1.3-3.1-.2-.4-.6-1.6.1-3.2 0 0 1-.3 3.3 1.2a11.5 11.5 0 0 1 6 0C17.3 5 18.3 5.3 18.3 5.3c.7 1.6.3 2.8.1 3.2.8.8 1.3 1.9 1.3 3.1 0 4.7-2.8 5.7-5.5 6 .4.4.8 1.1.8 2.2v3.3c0 .3.2.7.8.6A12 12 0 0 0 12 .3z"/></svg>',
  microsoft: '<svg width="17" height="17" viewBox="0 0 23 23"><path fill="#f35325" d="M1 1h10v10H1z"/><path fill="#81bc06" d="M12 1h10v10H12z"/><path fill="#05a6f0" d="M1 12h10v10H1z"/><path fill="#ffba08" d="M12 12h10v10H12z"/></svg>',
};

async function loadProviders() {
  const wrap = document.getElementById('siProviders');
  const list = document.getElementById('siProviderList');
  if (!wrap || !list) return;

  let providers = [];
  try {
    providers = (await (await fetch('/api/auth/providers')).json()).providers || [];
  } catch {
    return;                       // leave the section hidden
  }
  if (!providers.length) return;

  list.innerHTML = '';
  for (const prov of providers) {
    const id = String(prov.id || '');
    // The id goes straight into a URL path, so only accept a plain word.
    if (!/^[a-z]+$/.test(id)) continue;

    const a = document.createElement('a');
    a.className = 'si-provider';
    a.href = '/api/auth/login/' + id;
    // The icon is a trusted constant; the NAME comes from the broker, so it is
    // set as text rather than interpolated into markup.
    if (PROVIDER_ICONS[id]) {
      const span = document.createElement('span');
      span.innerHTML = PROVIDER_ICONS[id];
      a.appendChild(span);
    }
    a.appendChild(document.createTextNode('Continue with ' + (prov.name || id)));
    list.appendChild(a);
  }

  if (list.children.length) {
    wrap.hidden = false;
    // The providers block carries the explanatory line now, so the email form's
    // copy shrinks to avoid saying the same thing twice.
    const lead = document.getElementById('siEmailLead');
    if (lead) lead.textContent = "We'll email you a 6-digit code — no password needed.";
  }
}

/* An OAuth sign-in leaves the page, so no JS of ours runs during the round
   trip and the guest cart can't be handed over mid-flight. The broker sends
   them back with ?auth=ok, which loadSession picks up — adoptServerCart then
   merges whatever is still in localStorage. Nothing extra needed here beyond
   stripping the query so a refresh doesn't re-trigger anything. */
(function stripAuthFlag() {
  const params = new URLSearchParams(location.search);
  if (params.get('auth')) {
    params.delete('auth');
    const qs = params.toString();
    history.replaceState({}, '', location.pathname + (qs ? '?' + qs : '') + location.hash);
  }
})();

loadProviders();

loadSession();
