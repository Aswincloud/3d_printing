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
