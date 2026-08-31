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
// Attached to the SHOP's product cards. It used to serve the portfolio section,
// which was removed because 51 of its 53 photos were the same prints already
// listed for sale — the same piece appeared twice, priced in one place and not
// the other. Click-to-enlarge and "request a quote for this" were worth keeping,
// so they moved onto the product cards rather than being deleted with the section.
const lightbox = document.getElementById('lightbox');
const lightboxImg = document.getElementById('lightboxImg');

// A LIVE query, not a snapshot. The old `[...querySelectorAll('.gallery-item')]`
// worked because the gallery was static markup present at parse time; product
// cards are rendered from /api/products after load, so a snapshot taken here
// would always be empty. Re-reading on each call also keeps prev/next correct
// when the search box or a category filter changes which cards are on screen.
const lbItems = () => [...document.querySelectorAll('.product-media')];
let current = 0;

// The lightbox is full-screen, so it must NOT reuse the card's src — that is now a
// 480px thumbnail, and blowing it up would look worse than before the resizing was
// added. data-full carries a large edge-resized URL, set where the card is built; the
// fallback keeps this working for any <img> without one (the server-rendered grid,
// before main.js replaces it).
const fullSrc = (img) => img.getAttribute('data-full') || img.src;

function openLightbox(index) {
  const items = lbItems();
  if (!items[index]) return;
  current = index;
  const img = items[index].querySelector('img');
  lightboxImg.src = fullSrc(img);
  lightboxImg.alt = img.alt;
  lightbox.classList.add('active');
  document.body.style.overflow = 'hidden';
  if (typeof updateLightboxCaption === 'function') updateLightboxCaption();
  if (typeof updateLightboxBuy === 'function') updateLightboxBuy();
}

function closeLightbox() {
  lightbox.classList.remove('active');
  document.body.style.overflow = '';
  // Never leave the buy-choice prompt open: reopening the lightbox on a different
  // product would show a question that was asked about the previous one.
  const choice = document.getElementById('lightboxBuyChoice');
  if (choice) choice.hidden = true;
}

function navigate(dir) {
  const items = lbItems();
  if (!items.length) return;
  // Same reason as in closeLightbox(): the prompt names a specific product and a
  // count, and arrowing away would leave it asking about the wrong one.
  const choice = document.getElementById('lightboxBuyChoice');
  if (choice) choice.hidden = true;
  current = (current + dir + items.length) % items.length;
  const img = items[current].querySelector('img');
  lightboxImg.style.opacity = '0';
  setTimeout(() => {
    lightboxImg.src = fullSrc(img);
    lightboxImg.alt = img.alt;
    lightboxImg.style.opacity = '1';
    if (typeof updateLightboxCaption === 'function') updateLightboxCaption();
    // Price and buy buttons must follow the arrows, or they would offer the
    // previous product's price for the one now on screen.
    if (typeof updateLightboxBuy === 'function') updateLightboxBuy();
  }, 150);
}

lightboxImg.style.transition = 'opacity 0.15s ease';

// Delegated from the grid, because the cards do not exist yet when this runs and
// are replaced wholesale on every search keystroke and filter change. Binding to
// each card at render time would mean re-binding on every one of those.
// Clicking a product photo goes to that product's page.
//
// It used to open the lightbox. That was right when /p/<slug> was just the
// homepage again — but now that real product pages exist, keeping the overlay
// meant 59 pages nobody could click through to, and Google seeing links to
// pages the site itself never linked.
//
// The lightbox is still there, and is still the right control on the product
// page where zooming into one photo is the point. It is just no longer what
// browsing the grid does.
//
// Buttons inside the card (Add to cart, Ask for a quote, Share) call
// stopPropagation or sit outside .product-media, so this does not hijack them.
document.getElementById('productGrid')?.addEventListener('click', (e) => {
  const media = e.target.closest('.product-media');
  if (!media) return;
  const card = media.closest('.product-card');
  const slug = card?.dataset.slug;
  // A synthesised quote-only card has no slug and therefore no page. Falling
  // back to the lightbox is better than a dead click.
  if (!slug) {
    const index = lbItems().indexOf(media);
    if (index >= 0) openLightbox(index);
    return;
  }
  location.href = '/p/' + slug;
});

// A div with role="button" does not fire click on Enter/Space the way a real
// button does, so the keyboard path is wired explicitly. Space is
// preventDefault-ed to stop it scrolling the page instead.
document.getElementById('productGrid')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const media = e.target.closest?.('.product-media');
  if (!media) return;
  e.preventDefault();
  const card = media.closest('.product-card');
  const slug = card?.dataset.slug;
  if (slug) { location.href = '/p/' + slug; return; }
  const index = lbItems().indexOf(media);
  if (index >= 0) openLightbox(index);
});

document.getElementById('lightboxClose')?.addEventListener('click', closeLightbox);
document.getElementById('lightboxPrev')?.addEventListener('click', () => navigate(-1));
document.getElementById('lightboxNext')?.addEventListener('click', () => navigate(1));

lightbox?.addEventListener('click', (e) => {
  if (e.target === lightbox) closeLightbox();
});

document.addEventListener('keydown', (e) => {
  if (!lightbox.classList.contains('active')) return;
  if (e.key === 'Escape') {
    // Escape closes the innermost thing first. When the buy-now prompt is open it
    // takes the key and the lightbox stays put, so one Escape does not throw away
    // both the question and the photo behind it.
    //
    // Handled here rather than in a second listener: two keydown listeners on
    // `document` are siblings, so stopPropagation() in one cannot prevent the
    // other from running — the first attempt closed the prompt AND the lightbox.
    const choice = document.getElementById('lightboxBuyChoice');
    if (choice && !choice.hidden) { choice.hidden = true; return; }
    closeLightbox();
  }
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
    // Set when they arrived here from a gallery image or a product card. Empty
    // for an ordinary quote request, so that path is unchanged.
    ref_item: document.getElementById('refItem')?.value || '',
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
/* The cart stores ONLY { id, qty, pz } in localStorage. No prices, no names.
   `pz` is what to print on a personalised item — the customer's own words, and
   intent in exactly the way the quantity is. Whether a product asks for one at
   all, and whether it is required, is decided server-side against the product
   row; this only carries it.
   Everything shown is re-derived from /api/products on load, and the amount
   actually charged is computed server-side at checkout — so a hand-edited
   localStorage entry can change what you see, never what you pay. */

const CART_KEY = 'ap_cart';
const MAX_QTY = 100; // mirrors MAX_QTY in src/shop.js
const MAX_PZ = 120;  // mirrors MAX_PERSONALISATION in src/shop.js

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
// DISPLAY ONLY, and set from /api/me. It decides whether the pin toggle is drawn,
// nothing more: /api/admin/* re-checks the allowlist server-side, so faking this
// in devtools buys a button that earns a 401. Same caveat as the Dashboard link.
let isAdmin = false;

/* ── money ─────────────────────────────────────────────────────── */
// Mirrors rupees() in src/lib.js so the drawer and the emails agree.
function rupees(paise) {
  return '₹' + (Math.round(Number(paise) || 0) / 100)
    .toLocaleString('en-IN', { maximumFractionDigits: 2 });
}

/* The struck-through "MRP" beside the selling price. Mirrors compareAtPaise() in
   src/lib.js — same +15%, so the grid and the product page never disagree.

   DISPLAY ONLY. It is deliberately absent from readCart/renderCart/checkout below:
   those show what is actually charged, and a fabricated "you saved ₹X" against a
   real total is a different claim entirely from a struck price on a card. If a
   saving ever needs to appear in the drawer, it should come from a real coupon,
   which already has its own line. */
const COMPARE_AT_MULTIPLIER = 1.15;
function compareAtPaise(paise) {
  const p = Math.round(Number(paise) || 0);
  if (!(p > 0)) return 0;                    // quote-only: no struck price
  // Whole rupees, not whole paise — see the note in src/lib.js. ₹399 must show as
  // ₹459, never ₹458.85.
  return Math.round((p * COMPARE_AT_MULTIPLIER) / 100) * 100;
}
function comparePercentOff(paise) {
  const was = compareAtPaise(paise), now = Math.round(Number(paise) || 0);
  if (!(was > now) || !(now > 0)) return 0;
  return Math.round(((was - now) / was) * 100);
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
      const prev = seen.get(id);
      // Absent `pz` reads as '', so a cart written before this existed still
      // loads rather than being dropped as malformed.
      const pz = typeof it?.pz === 'string' ? it.pz.slice(0, MAX_PZ) : '';
      seen.set(id, {
        qty: Math.min(MAX_QTY, (prev?.qty || 0) + qty),
        pz: prev?.pz || pz,
      });
    }
    return [...seen].map(([id, line]) => ({ id, qty: line.qty, pz: line.pz }));
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
  // Nothing unpriced reaches the cart.
  //
  // Belt and braces with priceCart(), which refuses it server-side — that is the
  // control. This one matters for a stale tab: a catalogue loaded before a
  // product was unpriced would still render an Add to cart button, and without
  // this the item would sit in the cart until checkout refused the whole basket.
  //
  // A null id (a synthesised card) has no row at all, so it can never be priced.
  if (!id) return false;
  const known = catalogue.find((p) => p.id === id);
  if (known && known.quote_only) return false;

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

/* ── personalisation ───────────────────────────────────────────── */
/* What to print on a made-to-order item: a name on a keychain, the details on a
   business card, a colour on a stand. Products carry `personalise_label` (empty
   means the product does not ask) and `personalise_required`.

   ONE RENDERER, TWO HOSTS. It appears in the cart drawer AND in the checkout
   summary, because two buy paths skip the cart entirely — Buy-now on a product
   page (product.js hands off through sessionStorage) and Buy-now in the
   lightbox. A field that lived only in the drawer would be skippable by the two
   fastest routes to paying, which is exactly the hole this closes.

   The button being disabled is a courtesy. priceCart() refuses the order
   regardless, because the API takes a cart from anywhere. */

function pzMissing(items) {
  return items
    .map((it) => ({ it, p: catalogue.find((c) => c.id === it.id) }))
    .filter(({ it, p }) => p && p.personalise_label && p.personalise_required
                             && !String(it.pz || '').trim())
    .map(({ p }) => p.name);
}

// Writes straight to the cart. buyNowItems is a separate in-memory list, so a
// Buy-now line is updated in place instead — it is not in the cart and must not
// be added to it.
function setPz(id, value) {
  const v = String(value || '').slice(0, MAX_PZ);
  if (buyNowItems) {
    const line = buyNowItems.find((it) => it.id === id);
    if (line) line.pz = v;
    return;
  }
  const cart = readCart();
  const line = cart.find((it) => it.id === id);
  if (!line) return;
  line.pz = v;
  writeCart(cart);
}

/* Returns null when the product does not ask. `onDone` re-renders whatever is
   hosting it, so the checkout button's enabled state tracks the field. Bound on
   'input' for the state and 'change' for the write, so the cart is not rewritten
   — and syncCartUp not fired — on every keystroke. */
function pzField(product, value, onDone) {
  if (!product.personalise_label) return null;

  const wrap = document.createElement('label');
  wrap.className = 'pz-field';

  const cap = document.createElement('span');
  cap.className = 'pz-label';
  cap.textContent = product.personalise_label
    + (product.personalise_required ? '' : ' (optional)');

  const input = document.createElement('input');
  input.type = 'text';
  input.value = value || '';
  input.maxLength = MAX_PZ;
  input.placeholder = product.personalise_required ? 'Required' : 'Leave blank for the default';
  input.setAttribute('aria-label', product.personalise_label + ' for ' + product.name);
  if (product.personalise_required && !String(value || '').trim()) {
    wrap.classList.add('pz-needed');
    input.setAttribute('aria-invalid', 'true');
  }

  input.addEventListener('input', () => {
    const filled = Boolean(input.value.trim());
    wrap.classList.toggle('pz-needed', product.personalise_required && !filled);
    if (filled || !product.personalise_required) input.removeAttribute('aria-invalid');
    // Live, so the Checkout button un-disables as they type rather than only
    // once they click away.
    setPz(product.id, input.value);
    if (typeof onDone === 'function') onDone();
  });

  wrap.append(cap, input);
  return wrap;
}

/* Disables the two buttons that lead to payment while a required value is
   blank, and says which item is missing rather than leaving a dead button with
   no explanation. Advisory only — priceCart() is what actually refuses. */
function syncCheckoutGate() {
  const setState = (btn, noteId, items) => {
    if (!btn) return;
    const missing = pzMissing(items);
    btn.disabled = missing.length > 0;
    btn.classList.toggle('is-blocked', missing.length > 0);
    const note = document.getElementById(noteId);
    if (!note) return;
    note.hidden = missing.length === 0;
    note.textContent = missing.length === 1
      ? `Tell me what to print on the ${missing[0]} first.`
      : `Fill in the details for: ${missing.join(', ')}.`;
  };
  setState(document.getElementById('cartCheckout'), 'cartPzNote', readCart());
  setState(document.getElementById('coSubmit'), 'coPzNote', checkoutItems());
}

/* ── promo banner ───────────────────────────────────────────────────
   Every word comes from /api/products, which sends a promo only while the coupon
   is genuinely usable — active, unexpired, uses left. Nothing about the offer is
   written in the markup, so pausing WELCOME10 in the dashboard takes the banner
   down on the next load with nothing else to remember.

   The terms are rendered from the same fields priceCart() applies, so the banner
   cannot promise a discount checkout will not give. */

const PROMO_DISMISS_KEY = 'ap_promo_hidden';

function renderPromo(promo) {
  const bar = document.getElementById('promoBanner');
  if (!bar) return;
  if (!promo || !promo.code) { bar.hidden = true; return; }

  // Dismissed for THIS code. Keyed on the code so a new offer shows again to
  // someone who closed the last one — a dismissal means "not that one", not
  // "never show me anything".
  try {
    if (localStorage.getItem(PROMO_DISMISS_KEY) === promo.code) { bar.hidden = true; return; }
  } catch { /* private mode — show it */ }

  const off = promo.kind === 'percent' ? promo.value + '% off' : rupees(promo.value) + ' off';
  const caps = [];
  // Stated up front rather than discovered at checkout. A capped percentage that
  // only reveals itself on the total is the kind of surprise that costs a sale.
  if (promo.kind === 'percent' && promo.max_discount_paise) {
    caps.push('up to ' + rupees(promo.max_discount_paise));
  }
  if (promo.min_order_paise) caps.push('on orders over ' + rupees(promo.min_order_paise));
  if (promo.once_per_customer) caps.push('one use per customer');

  const text = document.getElementById('promoText');
  if (text) {
    text.textContent = off + (caps.length ? ' — ' + caps.join(', ') : '') + ' with code ' + promo.code;
  }

  const copy = document.getElementById('promoCopy');
  if (copy) {
    copy.onclick = async () => {
      try {
        await navigator.clipboard.writeText(promo.code);
        copy.textContent = 'Copied';
      } catch {
        // Clipboard needs permission and a secure context; neither is guaranteed.
        // The code is already on screen, so show it rather than failing silently.
        copy.textContent = promo.code;
      }
      setTimeout(() => { copy.textContent = 'Copy code'; }, 2000);
    };
  }

  const close = document.getElementById('promoClose');
  if (close) {
    close.onclick = () => {
      bar.hidden = true;
      document.documentElement.style.setProperty('--promo-h', '0px');
      try { localStorage.setItem(PROMO_DISMISS_KEY, promo.code); } catch { /* fine */ }
    };
  }

  bar.hidden = false;

  // How much of the banner is still on screen. The nav's `top` reads this, so it
  // rides up as the banner scrolls away and pins at 0 once it is gone.
  //
  // Without it the nav stayed 85px down forever: the banner scrolled off and left
  // a transparent gap at the top of the viewport with the page showing through,
  // and the header sitting below it looking detached.
  //
  // Measured rather than assumed — the banner wraps to two lines on a phone, 85px
  // there against 43px on a desktop.
  let barH = bar.offsetHeight;
  let queued = false;
  const syncPromoOffset = () => {
    queued = false;
    const left = Math.max(0, barH - (window.scrollY || 0));
    document.documentElement.style.setProperty('--promo-h', left + 'px');
  };
  // Coalesced to one write per frame: this runs on every scroll event, and
  // setting a custom property that the fixed nav depends on is a layout write.
  const onScroll = () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(syncPromoOffset);
  };
  window.addEventListener('scroll', onScroll, { passive: true });
  window.addEventListener('resize', () => { barH = bar.offsetHeight; syncPromoOffset(); });
  syncPromoOffset();
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
    renderPromo(data.promo);
    // Chips before the grid: renderFilters reveals the controls, and doing it
    // first means they never flash in above an empty grid.
    renderFilters();
    renderProducts();
    renderShipNote();
    renderCart();
    // Must run after renderProducts(): a shared /p/<slug> link needs the cards to
    // exist before it can scroll to one and open its lightbox.
    openSharedProduct();

    // "Buy now" on a product page adds to the cart and sends the visitor here
    // with #checkout, because checkout and the whole Razorpay flow live in this
    // file — duplicating them on the product page would mean two implementations
    // of the payment path.
    //
    // After renderProducts() for the same reason as above: openCheckout() prices
    // the cart against the loaded catalogue and does nothing if it is empty.
    if (location.hash === '#checkout') {
      // Drop the hash first, so a refresh does not reopen checkout on a cart the
      // visitor may since have emptied.
      history.replaceState({}, '', location.pathname + location.search);
      openCheckout(takeBuyNowHandoff());
    }
  } catch (err) {
    productGrid.innerHTML =
      '<p class="shop-error">Couldn\'t load the shop right now. ' +
      'Please refresh, or <a href="#quote">send a quote request</a> instead.</p>';
  }
}

// textContent/setAttribute throughout rather than innerHTML with interpolation:
// product names and descriptions are admin-editable, so they're untrusted here.
/* ── search + category filters ─────────────────────────────────── */
/* Entirely client-side. /api/products returns the whole catalogue in one
   request, so there's no reason to round-trip for a filter. */

let shopQuery = '';
let shopCategory = 'all';
let shopPriceBand = 'all';

// Price bands for the sidebar filter.
//
// Chosen from the actual catalogue rather than round numbers: prices run ₹99 to
// ₹12,000 with most between ₹299 and ₹899, so bands of ₹0–500 / ₹500–1000 /
// ₹1000+ split it usefully. Even thirds by count would be more balanced but
// would move as prices change, and a filter whose meaning shifts is worse than
// one that is slightly uneven.
const PRICE_BANDS = [
  { id: 'under500', label: 'Under ₹500', min: 1, max: 49999 },
  { id: '500to1000', label: '₹500 – ₹1,000', min: 50000, max: 100000 },
  { id: 'over1000', label: 'Over ₹1,000', min: 100001, max: Infinity },
];

// Quote-only items (price 0) match no band. They are not free, they are
// unpriced, so putting them in "Under ₹500" would be a lie — and someone
// filtering by price is looking for something they can buy.
function inPriceBand(product, bandId) {
  if (bandId === 'all') return true;
  const band = PRICE_BANDS.find((b) => b.id === bandId);
  if (!band) return true;
  const paise = product.price_paise;
  return paise > 0 && paise >= band.min && paise <= band.max;
}

// Display labels for the internal category slugs. Wording matches the Services
// section above, so the page reads as one thing. An unmapped slug falls back to
// itself capitalised, so a new category still shows something sensible.
const CATEGORY_LABELS = {
  figurine: 'Figurines',
  decor: 'Home Décor',
  functional: 'Functional',
  set: 'Sets',
};

// Cloudflare image resizing. Turns "assets/images/x.jpg" into a URL that is resized
// and re-encoded at the edge.
//
// onerror=redirect is not optional: without it a path Cloudflare cannot resize
// returns 404 and the card shows a broken image. With it, the request 307s to the
// original — so the worst case is the old behaviour, a big file, rather than no
// picture at all. Verified against a deliberately missing file: 404 without, 307 with.
//
// Skipped anywhere that is not the live site. /cdn-cgi/ is an edge feature and does
// not exist under `wrangler dev`, so without this every image 404s locally and the
// whole grid looks broken while developing.
function cdnImage(path, width) {
  const p = String(path || '').replace(/^\/+/, '');
  const local = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if (local || !p || /^https?:/i.test(p)) return '/' + p;
  return `/cdn-cgi/image/width=${width},format=auto,onerror=redirect/${p}`;
}

const categoryLabel = (slug) =>
  CATEGORY_LABELS[slug] || (slug ? slug[0].toUpperCase() + slug.slice(1) : 'Other');

// Match on name and description. Multi-word queries must match ALL terms, in any
// order — "blue horse" should find the filigree horse even though the words
// aren't adjacent.
function matchesQuery(p, q) {
  if (!q) return true;
  const haystack = `${p.name} ${p.description || ''} ${categoryLabel(p.category)}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).filter(Boolean).every((t) => haystack.includes(t));
}

function visibleProducts() {
  return catalogue.filter((p) =>
    (shopCategory === 'all' || p.category === shopCategory)
    && inPriceBand(p, shopPriceBand)
    && matchesQuery(p, shopQuery));
}

function updateResultCount(n) {
  const el = document.getElementById('shopResultCount');
  if (!el) return;
  const filtered = shopQuery.trim() || shopCategory !== 'all';
  if (!filtered) { el.textContent = ''; return; }
  el.textContent = n === 1 ? '1 piece' : `${n} pieces`;
}

// Built from the categories actually present, so adding one to the database
// needs no change here.
function renderFilters() {
  const box = document.getElementById('shopFilters');
  const controls = document.getElementById('shopControls');
  if (!box || !catalogue.length) return;

  const counts = new Map();
  for (const p of catalogue) {
    const c = p.category || 'other';
    counts.set(c, (counts.get(c) || 0) + 1);
  }

  box.innerHTML = '';
  const chip = (slug, label, n) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'filter-btn' + (shopCategory === slug ? ' active' : '');
    b.dataset.category = slug;
    b.setAttribute('aria-pressed', String(shopCategory === slug));
    b.appendChild(document.createTextNode(label));
    const c = document.createElement('span');
    c.className = 'filter-count';
    c.textContent = String(n);
    b.appendChild(c);
    b.addEventListener('click', () => {
      // Clicking the active chip clears it, which is what people expect from a
      // toggle and saves reaching for "All".
      shopCategory = (shopCategory === slug) ? 'all' : slug;
      renderFilters();
      renderProducts();
    });
    box.appendChild(b);
  };

  chip('all', 'All', catalogue.length);
  // Biggest categories first; ties alphabetical so the order is stable between
  // loads rather than depending on insertion order.
  const ordered = [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  ordered.forEach(([slug, n]) => chip(slug, categoryLabel(slug), n));

  if (controls) controls.hidden = false;

  renderSidebar(ordered, counts);
}

// ── the desktop sidebar ───────────────────────────────────────────
//
// Same filters, laid out as a marketplace sidebar rather than a pill row. At 59
// products the pills wrap to three lines and push the catalogue below the fold.
//
// Deliberately built from the SAME state (shopCategory, shopPriceBand) and
// calling the SAME render, so the two controls cannot disagree about what is
// filtered — CSS decides which one is visible, not JavaScript.
function renderSidebar(ordered) {
  const cats = document.getElementById('shopSideCats');
  const prices = document.getElementById('shopSidePrice');
  const sidebar = document.getElementById('shopSidebar');
  if (!cats || !prices || !sidebar) return;

  const row = (label, count, isActive, onClick) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'shop-side-row' + (isActive ? ' is-active' : '');
    b.setAttribute('aria-pressed', String(isActive));
    b.appendChild(document.createTextNode(label));
    if (count !== null) {
      const c = document.createElement('span');
      c.className = 'shop-side-count';
      c.textContent = String(count);
      b.appendChild(c);
    }
    b.addEventListener('click', onClick);
    return b;
  };

  cats.innerHTML = '';
  cats.appendChild(row('All', catalogue.length, shopCategory === 'all', () => {
    shopCategory = 'all';
    renderFilters();
    renderProducts();
  }));
  for (const [slug, n] of ordered) {
    cats.appendChild(row(categoryLabel(slug), n, shopCategory === slug, () => {
      shopCategory = (shopCategory === slug) ? 'all' : slug;
      renderFilters();
      renderProducts();
    }));
  }

  // Price bands, with live counts so a band that would return nothing is
  // visibly empty rather than a dead click.
  prices.innerHTML = '';
  for (const band of PRICE_BANDS) {
    const n = catalogue.filter((p) => inPriceBand(p, band.id)).length;
    prices.appendChild(row(band.label, n, shopPriceBand === band.id, () => {
      shopPriceBand = (shopPriceBand === band.id) ? 'all' : band.id;
      renderFilters();
      renderProducts();
    }));
  }

  sidebar.hidden = false;
}

const searchInput = document.getElementById('shopSearch');
const searchClear = document.getElementById('shopSearchClear');

searchInput?.addEventListener('input', () => {
  shopQuery = searchInput.value;
  if (searchClear) searchClear.hidden = !shopQuery;
  renderProducts();
});

// Escape clears the box — standard for a search field, and quicker than
// selecting the text.
searchInput?.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && searchInput.value) {
    e.stopPropagation();
    clearShopSearch();
  }
});

searchClear?.addEventListener('click', clearShopSearch);

function clearShopSearch() {
  if (!searchInput) return;
  searchInput.value = '';
  shopQuery = '';
  if (searchClear) searchClear.hidden = true;
  renderProducts();
  searchInput.focus();
}

function renderProducts() {
  // Same guard loadProducts() carries. It now matters more: the session path
  // calls this too, and a page that loads main.js without a grid would break
  // sign-in rather than just skipping the catalogue.
  if (!productGrid) return;
  productGrid.innerHTML = '';
  if (!catalogue.length) {
    productGrid.innerHTML = '<p class="shop-empty">Nothing listed just yet — check back soon.</p>';
    return;
  }

  // Pinned first, derived FROM THE SERVER ORDER every time rather than by
  // re-ordering `catalogue` in place.
  //
  // sort() is stable, so this needs no tie-break: everything keeps the order the
  // server sent, which already encodes pinned > curated sort > name. It is also
  // idempotent, so the first render — where the server has already grouped the
  // pinned rows — is a no-op.
  //
  // Sorting the array in place instead looked equivalent and was not: unpinning
  // left the card stranded near the top, because a cumulative sort has no memory
  // of where the row belonged. Reload fixed it, which is exactly the kind of bug
  // that reads as "the unpin didn't work".
  const shown = visibleProducts()
    .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
  updateResultCount(shown.length);

  // A search that matches nothing is a dead end unless we offer a way out.
  if (!shown.length) {
    const box = document.createElement('div');
    box.className = 'shop-no-match';
    const head = document.createElement('strong');
    head.textContent = 'Nothing matches that.';
    const body = document.createElement('span');
    body.textContent = "Try a different word or clear the filters — or ";
    const link = document.createElement('a');
    link.href = '#quote';
    link.textContent = 'ask me to print it for you';
    link.addEventListener('click', () => {
      // Carry the search term into the quote form: it's the best hint we have
      // about what they wanted.
      const q = shopQuery.trim();
      if (q) {
        const desc = document.getElementById('desc');
        if (desc && !desc.value.trim()) desc.value = `I'm looking for: ${q}`;
      }
    });
    body.appendChild(link);
    box.append(head, body, document.createTextNode('.'));
    productGrid.appendChild(box);
    return;
  }

  for (const p of shown) {
    const card = document.createElement('div');
    card.className = 'product-card';

    const media = document.createElement('div');
    media.className = 'product-media';
    // Opens the lightbox (delegated from #productGrid). Given a role and made
    // focusable so it is reachable by keyboard and announced as an action — the
    // portfolio's gallery items were plain divs and were NOT keyboard-accessible,
    // so this is a fix carried along with the move rather than a like-for-like
    // port. Enter/Space are handled below because a div does not fire click on
    // key press the way a real button does.
    media.setAttribute('role', 'button');
    media.setAttribute('tabindex', '0');
    // Announces where the click goes. It said "View larger photo" while the
    // click opened a lightbox; now it navigates, so the label has to say so or
    // a screen-reader user is told the wrong thing.
    media.setAttribute('aria-label', p.slug ? 'View ' + p.name : 'View larger photo of ' + p.name);
    const img = document.createElement('img');
    // ORDER MATTERS. loading must be set BEFORE src.
    //
    // Assigning src starts the fetch immediately, against whatever `loading` is at
    // that instant — and the default is eager. Setting loading='lazy' on the next
    // line changes the attribute but not the request already in flight, so every
    // image in the grid downloaded at once and the attribute looked correct in
    // devtools while doing nothing at all.
    //
    // Measured on the live site before this: 66 images and 9.8 MB pulled on a phone
    // WITHOUT scrolling, on a page where four cards are visible.
    img.loading = 'lazy';
    img.decoding = 'async';
    // Resized at the edge instead of shipping the original. A card is 171px wide on a
    // phone and 204px on desktop; the files behind them are 900-1200px, so the browser
    // was downloading roughly fifty times the pixels it draws. Cloudflare also
    // negotiates AVIF/WebP from the Accept header, which is most of the saving:
    // banana_bowl.jpg is 86 KB as sent today and 17 KB at width=400 as AVIF.
    img.sizes = '(max-width: 480px) 50vw, 210px';
    img.srcset = [320, 480, 640].map((w) => `${cdnImage(p.image, w)} ${w}w`).join(', ');
    img.src = cdnImage(p.image, 480);
    // What the lightbox opens. 1400px rather than the original: it still fills any
    // phone or laptop screen and saves most of the weight of a camera-sized file.
    img.setAttribute('data-full', cdnImage(p.image, 1400));
    img.alt = p.name;
    media.appendChild(img);

    const body = document.createElement('div');
    body.className = 'product-body';

    // A real link to the product page.
    //
    // The name was a plain <div>, which meant the only way to reach /p/<slug>
    // was to already know the URL: the photo opened the lightbox and nothing on
    // the card navigated. 59 product pages existed that a visitor could not
    // click through to.
    //
    // An <a> rather than a click handler, so it right-clicks, middle-clicks,
    // opens in a new tab, and is followed by crawlers — none of which a JS
    // navigation gives you.
    const name = p.slug ? document.createElement('a') : document.createElement('div');
    name.className = 'product-name';
    if (p.slug) name.href = '/p/' + p.slug;
    name.textContent = p.name;

    // No description on the card. It lives on /p/<slug>, which the photo and the
    // name both link to.
    //
    // It was rendered here in full, with no clamp, so the card was as tall as
    // whatever had been written: the description block measured a median of 208px
    // against a 553px card on mobile — 38% of every card — and ranged from 0 to
    // 500px. That spread is what made the grid ragged, because four products have no
    // description at all and one has 432 characters, so neighbouring cards differed
    // by 374px and no two rows of prices lined up.
    //
    // A grid is for choosing WHICH thing to look at; the photo, the name and the
    // price are what that choice is made on. The prose is for after the choice, and
    // it is still indexed for search below — searchMatches() reads p.description off
    // the API object, not out of the DOM, so filtering is unaffected.

    const foot = document.createElement('div');
    foot.className = 'product-foot';

    const price = document.createElement('div');
    price.className = 'product-price';

    // A photo that has been pushed but not priced. Every image in the repo is
    // listed automatically, so most of these are pieces Aswin has printed and
    // not yet decided a price for — the customer can still ask.
    //
    // The server refuses to price one of these into a cart (priceCart), so this
    // branch is presentation; it is not what makes it unbuyable.
    if (p.quote_only) {
      price.textContent = 'Price on request';
      price.classList.add('is-quote');

      const askNow = document.createElement('button');
      askNow.className = 'product-add is-quote';
      askNow.type = 'button';
      askNow.textContent = 'Request a quote';
      askNow.setAttribute('aria-label', 'Request a quote for ' + p.name);
      askNow.addEventListener('click', () => {
        startQuoteFor({ name: p.name, image: p.image });
      });

      foot.append(price, askNow);
    } else {
      // Struck "was" price, then the real one. Built as elements rather than
      // innerHTML because product names and prices come from the database and this
      // file treats them as untrusted everywhere else.
      const was = compareAtPaise(p.price_paise);
      if (was > p.price_paise) {
        const del = document.createElement('del');
        del.className = 'product-was';
        del.textContent = rupees(was);
        price.appendChild(del);
      }
      const now = document.createElement('span');
      now.className = 'product-now';
      now.textContent = rupees(p.price_paise);
      price.appendChild(now);

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
    }

    // For a variation on something we do sell — another colour, another size.
    //
    // Omitted entirely on a quote-only card: its main button is already "Request
    // a quote", so this would be a second button doing the same thing, under a
    // heading that implies the piece has a standard version to vary from.
    const ask = document.createElement('button');
    ask.type = 'button';
    ask.className = 'product-ask';
    ask.textContent = 'Different colour or size? Ask for a quote';
    ask.addEventListener('click', () => {
      startQuoteFor({ name: p.name, image: p.image, kind: 'product' });
    });

    // Share this one product. The link is /p/<slug>, which the Worker serves with
    // per-product Open Graph tags so a WhatsApp paste previews this photo and
    // price. `card.dataset.slug` is what openSharedProduct() looks up.
    card.dataset.slug = p.slug || '';
    // A synthesised card has no row and therefore no slug, so /p/<slug> would
    // 404 and the share button would copy a dead link. Shown only when there is
    // something to share.
    if (p.slug) {
      const share = document.createElement('button');
      share.type = 'button';
      share.className = 'product-share';
      share.title = 'Copy link to this product';
      share.setAttribute('aria-label', 'Share ' + p.name);
      share.textContent = 'Share';
      share.addEventListener('click', (e) => {
        e.stopPropagation();
        shareProduct(p, share);
      });
      media.appendChild(share);
    }

    // Top-left is the only free corner of the photo: .product-share holds
    // top-right and the ::after "View" hint holds bottom-right.
    //
    // For a customer this is a static badge. For an admin the badge IS the
    // toggle — same place, same look, so what he clicks is what buyers see.
    // A synthesised card has no row (id: null) and so cannot be pinned, exactly
    // as it has no slug and so cannot be shared.
    if (isAdmin && p.id) {
      const pin = document.createElement('button');
      pin.type = 'button';
      pin.className = 'product-featured' + (p.pinned ? '' : ' ghost');
      pin.textContent = p.pinned ? 'Featured' : 'Pin';
      pin.title = p.pinned ? 'Remove from the top of the shop' : 'Pin to the top of the shop';
      pin.setAttribute('aria-pressed', p.pinned ? 'true' : 'false');
      pin.setAttribute('aria-label', (p.pinned ? 'Unpin ' : 'Pin ') + p.name);
      // media is itself a click target (role="button", opens the lightbox), so
      // this has to stop here or pinning would also open the photo.
      pin.addEventListener('click', (e) => {
        e.stopPropagation();
        togglePin(p, pin);
      });
      media.appendChild(pin);
    } else if (p.pinned) {
      const badge = document.createElement('span');
      badge.className = 'product-featured';
      badge.textContent = 'Featured';
      media.appendChild(badge);
    }

    body.append(name, foot);
    if (!p.quote_only) body.appendChild(ask);
    card.append(media, body);
    productGrid.appendChild(card);
  }
}

function renderShipNote() {
  if (!shopShipNote || !shipCfg.free_threshold_paise) return;
  shopShipNote.textContent =
    '🚚 Shipping India-wide — flat ' + rupees(shipCfg.flat_paise) + ', free over ' +
    rupees(shipCfg.free_threshold_paise) + '.';
  shopShipNote.classList.add('show');
}

// Pin or unpin from the catalogue itself, so promoting a piece does not mean a
// trip to the dashboard. Reuses the owner-gated PATCH the dashboard already uses;
// there is no new endpoint and no new capability behind this button.
async function togglePin(p, btn) {
  if (!p.id || btn.disabled) return;
  const want = !p.pinned;
  const original = btn.textContent;
  btn.disabled = true;

  try {
    const res = await fetch('/api/admin/products/' + encodeURIComponent(p.id), {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pinned: want }),
    });
    if (!res.ok) throw new Error('Status ' + res.status);

    p.pinned = want;
    // Only the flag changes. `catalogue` stays in the order the server sent it,
    // and renderProducts() derives the pinned-first view from that — see the note
    // there for why re-ordering the array itself was wrong.
    renderProducts();
  } catch (err) {
    // Nothing moves on failure — the button says why and returns to itself. A
    // 401 here means the session lapsed, which a reload fixes.
    btn.disabled = false;
    btn.textContent = 'Failed';
    setTimeout(() => { btn.textContent = original; }, 1600);
    console.warn('pin failed', err);
  }
}

/* ── sharing one product ───────────────────────────────────────── */

const productUrl = (slug) => location.origin + '/p/' + encodeURIComponent(slug);

// navigator.share where it exists (phones — gives the native sheet with WhatsApp,
// Instagram etc.), clipboard otherwise (desktop). Both are behind a user gesture,
// which both APIs require.
async function shareProduct(p, btn) {
  if (!p.slug) return;
  const url = productUrl(p.slug);
  const flash = (msg) => {
    const original = btn.textContent;
    btn.textContent = msg;
    btn.classList.add('shared');
    setTimeout(() => { btn.textContent = original; btn.classList.remove('shared'); }, 1600);
  };

  if (navigator.share) {
    try {
      await navigator.share({ title: p.name, text: p.name + ' — ' + rupees(p.price_paise), url });
      return;
    } catch (err) {
      // AbortError means the user dismissed the sheet — not a failure, and falling
      // through to copy would be surprising. Any other error does fall through.
      if (err && err.name === 'AbortError') return;
    }
  }

  try {
    await navigator.clipboard.writeText(url);
    flash('Copied ✓');
  } catch (err) {
    // Clipboard is blocked on http:// origins and in some embedded browsers.
    // Select the URL in a prompt-free way rather than silently doing nothing.
    flash('Copy failed');
    console.warn('clipboard unavailable', err);
  }
}

// A visitor arriving from a shared /p/<slug> link. The slug comes from the
// <meta name="ap:product"> tag that src/productpage.js injected, not from parsing
// location.pathname — the server already decided which slug is valid and visible,
// and reading its answer avoids two places disagreeing about that.
function openSharedProduct() {
  const meta = document.querySelector('meta[name="ap:product"]');
  const slug = meta && meta.getAttribute('content');
  if (!slug) return;

  const card = productGrid?.querySelector(`.product-card[data-slug="${CSS.escape(slug)}"]`);
  if (!card) return;

  card.scrollIntoView({ behavior: 'smooth', block: 'center' });
  card.classList.add('product-linked');

  // Open the lightbox on this product's photo. Delayed so the smooth scroll is
  // visible first — opening instantly makes it look like the page never moved,
  // and the visitor loses the context of where in the shop they landed.
  setTimeout(() => {
    const media = card.querySelector('.product-media');
    const index = typeof lbItems === 'function' ? lbItems().indexOf(media) : -1;
    if (index >= 0) openLightbox(index);
  }, 700);

  // Run once. Without this the highlight would reappear on any later re-render
  // (a search keystroke, a category chip) long after the visitor moved on.
  meta.remove();
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
    // Same ordering rule as the product grid: loading before src, or the fetch has
    // already started eagerly by the time lazy is set.
    img.loading = 'lazy';
    img.decoding = 'async';
    img.src = cdnImage(p.image, 160);      // cart thumbnail, ~64px on screen
    img.alt = '';

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
    const pz = pzField(p, it.pz, renderCart);
    if (pz) info.appendChild(pz);
    row.append(img, info, remove);
    cartBody.appendChild(row);
  }

  syncCheckoutGate();

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

const SHIP_FIELDS = ['co_line', 'co_city', 'co_state', 'co_pin'];

// Every order ships, so there is no delivery mode to read and the address is
// always required. The server hardcodes it too; this file is display only.

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
  ['co_name', 'co_email', 'co_phone', 'co_promo', ...SHIP_FIELDS].forEach(coClearError);
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

  // Always required now — every order ships.
  if (v('co_line').length < 5) bad('co_line', 'Please enter your street address.');
  if (!v('co_city')) bad('co_city', 'Please enter your city.');
  if (!v('co_state')) bad('co_state', 'Please enter your state.');
  if (!/^\d{6}$/.test(v('co_pin'))) bad('co_pin', 'Please enter a valid 6-digit PIN code.');

  if (firstBad) checkoutForm.querySelector('[name="' + firstBad + '"]')?.focus();
  return !firstBad;
}

/* ── summary ───────────────────────────────────────────────────── */
function renderCoSummary() {
  const el = document.getElementById('coSummary');
  if (!el) return;
  // checkoutItems(), not readCart(): a "buy now — just this" checkout must show
  // only that item, and must show the same set the payload will send.
  const lines = checkoutItems()
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

    const pz = pzField(p, it.pz, () => { renderCoSummary(); syncCheckoutGate(); });
    if (pz) {
      const holder = document.createElement('div');
      holder.className = 'co-line co-pz';
      holder.appendChild(pz);
      el.appendChild(holder);
    }
  }

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

  // When a coupon is applied, show the SERVER's numbers rather than recomputing
  // the discount here. The browser has no idea whether SAVE10 is 10% capped at
  // ₹200 or has a minimum — only /api/coupon/check does, and it already told us.
  if (appliedCoupon) {
    addRow('Promo ' + appliedCoupon.code, '−' + rupees(appliedCoupon.discount_paise), 'co-line-discount');
    const ship = appliedCoupon.shipping_paise;
    addRow(ship === 0 ? 'Shipping (free)' : 'Shipping', rupees(ship));
    addRow('Total', rupees(appliedCoupon.total_paise), 'co-line-total');
    return;
  }

  const shipping = shippingForDisplay(subtotal);
  addRow(shipping === 0 ? 'Shipping (free)' : 'Shipping', rupees(shipping));
  addRow('Total', rupees(subtotal + shipping), 'co-line-total');

  syncCheckoutGate();
}

/* ── promo code ────────────────────────────────────────────────── */

// The server's answer for the currently applied code, or null. Holds the priced
// result rather than the coupon's rules, because the browser must never do the
// discount arithmetic itself — that would be the same mistake as pricing items
// client-side.
let appliedCoupon = null;

function clearCoupon() {
  appliedCoupon = null;
  const ok = document.getElementById('coPromoOk');
  if (ok) { ok.hidden = true; ok.textContent = ''; }
  coClearError('co_promo');
}

async function applyPromo() {
  const input = checkoutForm?.querySelector('[name="co_promo"]');
  const okSlot = document.getElementById('coPromoOk');
  const btn = document.getElementById('coPromoApply');
  if (!input) return;

  const code = input.value.trim();
  if (!code) { clearCoupon(); renderCoSummary(); return; }

  btn.disabled = true;
  const label = btn.textContent;
  btn.textContent = 'Checking…';
  try {
    const res = await fetch('/api/coupon/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Only ids, qty and the code. No amounts — the server prices it, exactly
        // as it does for the order itself.
        items: checkoutItems().map((it) => ({ product_id: it.id, qty: it.qty, personalisation: it.pz || '' })),
        code,
        // For a once-per-customer code. The server re-checks against the
        // validated address at order time, so this is a preview convenience.
        email: (checkoutForm.querySelector('[name="co_email"]')?.value || '').trim(),
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'That code could not be applied.');

    appliedCoupon = data;
    coClearError('co_promo');
    if (okSlot) {
      const saved = data.discount_paise > 0
        ? rupees(data.discount_paise) + ' off'
        : 'free shipping';
      okSlot.textContent = `${data.code} applied — ${saved}.`;
      okSlot.hidden = false;
    }
  } catch (err) {
    clearCoupon();
    coSetError('co_promo', err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
    renderCoSummary();
  }
}

document.getElementById('coPromoApply')?.addEventListener('click', applyPromo);

// Enter inside the promo field applies the code rather than submitting the whole
// form — submitting would start a payment for a total the customer has not seen.
checkoutForm?.querySelector('[name="co_promo"]')?.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  applyPromo();
});

// Editing the code after applying it drops the applied discount, so the summary
// can never show a discount for a code that is no longer in the box.
checkoutForm?.querySelector('[name="co_promo"]')?.addEventListener('input', () => {
  if (appliedCoupon) { clearCoupon(); renderCoSummary(); }
});

/* ── open / close ──────────────────────────────────────────────── */

// "Buy now — just this item" checks out ONE product without disturbing the cart,
// so for the duration of that checkout the three places that read the cart
// (summary, open guard, order payload) must read this instead. A single override
// read through one accessor, rather than passing an items array through all three,
// because the two must never disagree about what is being charged for — and the
// server prices whatever ids the payload carries.
//
// null = normal checkout, charge the cart.
let buyNowItems = null;
const checkoutItems = () => buyNowItems || readCart();

// ── the buy-now handoff from a product page ───────────────────────
//
// A product page's "Buy now → just this item" cannot open this modal itself, so
// it writes its intent to sessionStorage and navigates here with #checkout.
// Symmetric with the lightbox's buyChoiceJustThis, which passes the same shape
// to openCheckout() directly because it is already on this page.
//
// Read ONCE and removed immediately: leaving it behind would mean a later normal
// checkout in the same tab silently charging for that one item instead of the
// cart — the exact bug the lightbox clears buyNowItems on close to avoid.
const BUY_NOW_KEY = 'ap_buynow';

function takeBuyNowHandoff() {
  let raw = null;
  try {
    raw = sessionStorage.getItem(BUY_NOW_KEY);
    sessionStorage.removeItem(BUY_NOW_KEY);
  } catch { return null; }
  if (!raw) return null;

  // Validated the same way readCart() validates localStorage, and for the same
  // reason: this is client-side storage, so treat it as input rather than as
  // something this code wrote. It reaches the order payload, and while the server
  // prices every id itself — an unknown or unpriced id is refused by priceCart,
  // and no price is ever sent from here — a malformed entry would otherwise
  // produce a confusing failure at checkout instead of being ignored now.
  //
  // The ids are also checked against the loaded catalogue, which is why this is
  // called after renderProducts(): a stale id from a deleted product would open
  // checkout on a summary that renders as empty while the payload still carried
  // it. Better to fall back to the cart.
  try {
    const items = JSON.parse(raw);
    if (!Array.isArray(items) || !items.length) return null;
    const clean = [];
    for (const it of items) {
      const id = typeof it?.id === 'string' ? it.id : '';
      const qty = parseInt(it?.qty, 10);
      if (!id || !Number.isFinite(qty) || qty < 1) continue;
      const p = catalogue.find((c) => c.id === id);
      // price_paise > 0 mirrors addToCart and priceCart: an unpriced product
      // cannot be bought by any route, and this is a route.
      if (!p || !(p.price_paise > 0)) continue;
      clean.push({ id, qty: Math.min(MAX_QTY, qty) });
    }
    return clean.length ? clean : null;
  } catch {
    return null;
  }
}

function openCheckout(items = null) {
  if (!checkoutModal) return;
  buyNowItems = items;
  if (!checkoutItems().length) { buyNowItems = null; return; }
  coClearAll();
  // A coupon applied to a PREVIOUS cart must not carry over: the discount was
  // priced against those items, and "buy now — just this" opens checkout with a
  // completely different basket. Clear the field too, so the box and the summary
  // never disagree about whether a code is active.
  clearCoupon();
  const promo = checkoutForm?.querySelector('[name="co_promo"]');
  if (promo) promo.value = '';
  renderCoSummary();
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
  // Clear the override, or the NEXT checkout would silently charge for the
  // single item this one was for. Cleared on close rather than on success
  // because a cancelled or failed payment leaves the modal by this path too.
  buyNowItems = null;
}

document.getElementById('cartCheckout')?.addEventListener('click', () => {
  closeCart();
  openCheckout();
});
document.getElementById('checkoutClose')?.addEventListener('click', closeCheckout);
checkoutOverlay?.addEventListener('click', closeCheckout);

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

  setCheckoutBusy(true, 'Starting payment…');

  let data;
  try {
    // Only ids and quantities. The server prices it.
    const res = await fetch('/api/orders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        items: checkoutItems().map((it) => ({ product_id: it.id, qty: it.qty, personalisation: it.pz || '' })),
        // No `delivery` field: the server sets it, and does not trust a value
        // sent from here — it decides the shipping charge.
        //
        // The coupon is sent as a CODE only, never as an amount. The server
        // re-validates and re-prices it; if it has expired or been used up since
        // Apply was clicked, the order is refused rather than silently charged at
        // full price.
        coupon_code: appliedCoupon?.code || null,
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

    // Paid. Clear the cart only if the cart is what was paid for: a "buy now —
    // just this item" checkout deliberately leaves the cart alone, and wiping it
    // here would delete items the customer was never charged for and did not
    // choose to remove.
    if (!buyNowItems) writeCart([]);
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
    // The server's snapshot, not the applied-coupon state: by the time the
    // receipt shows, what matters is what was actually charged.
    if (orderData.discount_paise > 0) {
      addRow('Promo ' + (orderData.coupon_code || ''), '−' + rupees(orderData.discount_paise), 'co-line-discount');
    }
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


/* ===== QUOTE FOR A SPECIFIC ITEM ===== */
/* Two entry points, one destination: the existing quote form.
     - a gallery photo (18 of the 53 are unnamed pieces with no price, and this
       is the only way to ask about those)
     - a product card, for a variation on something already listed
   Both scroll to the form and attach a visible reference so Aswin knows what
   the request is about without the customer having to describe the photo. */

// `kind` used to distinguish a listed product from a gallery-only photo. With the
// portfolio section removed, every reference is a listed product — both callers
// pass 'product' — so the gallery branches are gone rather than left as
// unreachable conditionals. The parameter is kept because it still reads at the
// call site and would be needed again if a non-product image surface came back.
// Opens the shared dialog from assets/js/quote-modal.js rather than scrolling to
// the page-bottom form. Asking about a product used to mean being sent to the
// other end of the page, which took away the photo, the price and the size you
// were looking at — the context the question was about.
//
// The page-bottom form is still there and still the target of #quote links; this
// is the item-specific path. The reference string handed over is byte-identical
// to the one this function used to write into #refItem, so the owner's email is
// unchanged whichever route a request arrives by.
function startQuoteFor({ name, image, kind = 'product' }) {
  closeLightbox?.();

  if (typeof window.openQuoteModal === 'function') {
    window.openQuoteModal({ name, image });
    return;
  }

  // quote-modal.js failed to load. Falling back to the old behaviour beats a
  // button that does nothing: the form below can carry the same request.
  const box = document.getElementById('quoteRef');
  const hidden = document.getElementById('refItem');
  if (!box || !hidden) return;

  const label = name || 'this piece';
  document.getElementById('quoteRefImg').src = image || '';
  document.getElementById('quoteRefImg').alt = label;
  document.getElementById('quoteRefName').textContent = label;
  document.getElementById('quoteRefNote').textContent = 'A variation of this listed item';
  hidden.value = 'Product: ' + label + (image ? ' (' + image + ')' : '');
  box.hidden = false;

  const desc = document.getElementById('desc');
  if (desc && !desc.value.trim()) {
    desc.placeholder = 'What would you like changed? Colour, size, material, quantity…';
  }

  document.getElementById('quote')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => document.getElementById('name')?.focus(), 600);
}

document.getElementById('quoteRefClear')?.addEventListener('click', () => {
  document.getElementById('quoteRef').hidden = true;
  document.getElementById('refItem').value = '';
});

// The lightbox already tracks which image is open via `current`.
document.getElementById('lightboxQuote')?.addEventListener('click', () => {
  const img = lbItems()[current]?.querySelector('img');
  if (!img) return;
  const alt = img.getAttribute('alt') || '';
  // Every product has a real name now that the source is D1 rather than the
  // gallery's alt text, so the generic fallback should never fire — kept because
  // an admin can still save a product with an empty name through the API.
  const generic = /^3D print sample$/i.test(alt.trim());
  startQuoteFor({
    name: generic ? 'This piece' : alt,
    image: img.getAttribute('src') || '',
    kind: 'product',
  });
});

/* ── buying from the lightbox ──────────────────────────────────── */

// Which product is open. Resolved from the card's data-slug rather than by
// matching the image src or the caption text: the slug is the product's identity,
// while a name can be edited to collide and two products could share a photo.
function lightboxProduct() {
  const card = lbItems()[current]?.closest('.product-card');
  const slug = card?.dataset.slug;
  return slug ? catalogue.find((p) => p.slug === slug) || null : null;
}

// Enable and label the buy controls for whatever is open. Called on every open and
// on every prev/next, so navigating with the arrows keeps the price honest.
function updateLightboxBuy() {
  const p = lightboxProduct();
  const priceEl = document.getElementById('lightboxPrice');
  const addBtn = document.getElementById('lightboxAdd');
  const buyBtn = document.getElementById('lightboxBuy');
  if (!priceEl || !addBtn || !buyBtn) return;

  if (!p) {
    // Defensive: every photo in the lightbox is a listed product today, but if a
    // non-product image surface is ever added, hide the buy controls rather than
    // showing buttons that would fail.
    priceEl.textContent = '';
    addBtn.hidden = buyBtn.hidden = true;
    return;
  }

  // The case that branch anticipated has arrived: photos that are in the shop
  // but not priced. Buy controls off, and say why — an empty price next to a
  // hidden button reads as a broken card rather than an invitation to ask.
  if (p.quote_only) {
    priceEl.textContent = 'Price on request';
    addBtn.hidden = buyBtn.hidden = true;
    return;
  }

  addBtn.hidden = buyBtn.hidden = false;
  priceEl.textContent = rupees(p.price_paise);
  addBtn.textContent = 'Add to cart';
  addBtn.disabled = false;
}

document.getElementById('lightboxAdd')?.addEventListener('click', () => {
  const p = lightboxProduct();
  const btn = document.getElementById('lightboxAdd');
  if (!p || !btn) return;
  if (!addToCart(p.id)) {
    btn.textContent = 'Max ' + MAX_QTY + ' reached';
  } else {
    btn.textContent = 'Added ✓';
  }
  // Deliberately does NOT close the lightbox: someone adding from here is likely
  // browsing with the arrow keys, and closing would drop them back to the grid
  // after every add.
  setTimeout(() => { btn.textContent = 'Add to cart'; }, 1400);
});

// Buy now. With an empty cart this is unambiguous — add and check out. With items
// already in it, "buy now" could mean this one thing or the whole basket, and
// guessing wrong either overcharges or loses the order, so the customer is asked.
document.getElementById('lightboxBuy')?.addEventListener('click', () => {
  const p = lightboxProduct();
  if (!p) return;

  const cart = readCart();
  const others = cart.filter((it) => it.id !== p.id);

  if (!others.length) {
    // Nothing else to confuse it with. Make sure the item is in the cart (it may
    // not be), then check the cart out — one code path, same as the cart button.
    if (!cart.some((it) => it.id === p.id)) addToCart(p.id);
    closeLightbox();
    openCheckout();
    return;
  }

  const box = document.getElementById('lightboxBuyChoice');
  const text = document.getElementById('lightboxBuyChoiceText');
  const total = cartCount(cart) + (cart.some((it) => it.id === p.id) ? 0 : 1);
  if (text) {
    text.textContent = `Your cart already has ${cartCount(others)} other item` +
      (cartCount(others) === 1 ? '' : 's') + '. Check out just this one, or all ' +
      total + '?';
  }
  if (box) box.hidden = false;
});

document.getElementById('buyChoiceJustThis')?.addEventListener('click', () => {
  const p = lightboxProduct();
  document.getElementById('lightboxBuyChoice').hidden = true;
  if (!p) return;
  // The cart is left exactly as it was — see the buyNowItems note by openCheckout.
  closeLightbox();
  openCheckout([{ id: p.id, qty: 1 }]);
});

document.getElementById('buyChoiceEverything')?.addEventListener('click', () => {
  const p = lightboxProduct();
  document.getElementById('lightboxBuyChoice').hidden = true;
  if (!p) return;
  if (!readCart().some((it) => it.id === p.id)) addToCart(p.id);
  closeLightbox();
  openCheckout();
});

// Escape-dismissal of the prompt lives in the lightbox keydown handler above, not
// in a second listener here: sibling listeners on `document` cannot suppress each
// other, so a separate one closed the prompt and the lightbox with one keypress.

// Caption in the lightbox, so a named piece is identifiable before asking.
function updateLightboxCaption() {
  const cap = document.getElementById('lightboxCaption');
  if (!cap) return;
  // The img alt is the product name (set in the card renderer), so the caption
  // now names the piece rather than describing a photo.
  const alt = (lbItems()[current]?.querySelector('img')?.getAttribute('alt') || '').trim();
  cap.textContent = /^3D print sample$/i.test(alt) ? '' : alt;
}

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
  // Must be re-hidden on sign-out, not just left unset: signing out without a
  // reload would otherwise leave the Dashboard button in the header for whoever
  // uses the browser next.
  const navDash = document.getElementById('navDashboard');
  if (navDash) navDash.hidden = true;
  const tabs = document.getElementById('drawerTabs');
  if (tabs) tabs.hidden = true;
  // Strip the pin toggles on sign-out without a reload, for the same reason
  // navDashboard is re-hidden above.
  if (isAdmin) { isAdmin = false; renderProducts(); }
}

function applySignedInState(me) {
  accountBtn?.setAttribute('aria-label', 'Account menu (' + me.email + ')');
  accountBtn?.setAttribute('title', me.name || me.email);
  const dot = document.getElementById('accountDot');
  if (dot) dot.hidden = false;

  const who = document.getElementById('accountMenuWho');
  if (who) who.textContent = me.name ? `${me.name} · ${me.email}` : me.email;

  // Dashboard in the header itself, so reaching it is one click rather than
  // opening the account menu first. Same DISPLAY-only caveat as the menu entry
  // below: /api/admin/* re-checks the allowlist server-side, so a faked is_admin
  // reveals a link that leads to a 401 and nothing more.
  const navDash = document.getElementById('navDashboard');
  if (navDash) navDash.hidden = !me.is_admin;

  // loadProducts() and loadSession() race at boot, and /api/products is edge-cached
  // while /api/me is not — so the grid has almost always drawn before we learn who
  // this is. Re-render to bring the pin toggles in, but only on a CHANGE, so the
  // common signed-in-customer case does not redraw the whole grid for nothing.
  if (isAdmin !== Boolean(me.is_admin)) {
    isAdmin = Boolean(me.is_admin);
    renderProducts();
  }

  // NOT duplicated into the menu. Dashboard has its own header button, and the
  // same destination in two places made the menu read as though it held two
  // different things. Removed defensively rather than just not-added: a page
  // cached from before this change may already carry the injected entry.
  document.getElementById('menuDashboard')?.remove();

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

/* ── account settings ──────────────────────────────────────────── */
/* The saved delivery details. Checkout still asks for everything — this only
   prefills it, and the ORDER keeps its own snapshot, so changing an address here
   never rewrites where a past parcel was sent. */

const settingsModal = document.getElementById('settingsModal');
const settingsOverlay = document.getElementById('settingsOverlay');
const settingsForm = document.getElementById('settingsForm');

const SETTINGS_FIELDS = [
  ['set_name', 'name'],
  ['set_phone', 'phone'],
  ['set_line', 'addr_line'],
  ['set_city', 'addr_city'],
  ['set_state', 'addr_state'],
  ['set_pin', 'addr_pin'],
];

function setClearErrors() {
  for (const [field] of SETTINGS_FIELDS) {
    const el = settingsForm?.querySelector(`[name="${field}"]`);
    const slot = document.getElementById(field + 'Error');
    if (el) { el.classList.remove('invalid'); el.removeAttribute('aria-invalid'); }
    if (slot) { slot.textContent = ''; slot.classList.remove('show'); }
  }
  const err = document.getElementById('settingsError');
  if (err) { err.hidden = true; err.textContent = ''; }
  const ok = document.getElementById('settingsOk');
  if (ok) { ok.hidden = true; ok.textContent = ''; }
}

function openSettings() {
  if (!settingsModal || !currentUser) return;
  setClearErrors();

  const who = document.getElementById('settingsWho');
  if (who) who.textContent = `Signed in as ${currentUser.email}`;

  // Populated from the session we already have — no extra round trip, and the
  // values are whatever the server last confirmed rather than a local guess.
  for (const [field, key] of SETTINGS_FIELDS) {
    const el = settingsForm?.querySelector(`[name="${field}"]`);
    if (el) el.value = currentUser[key] || '';
  }

  settingsModal.hidden = false;
  settingsOverlay.hidden = false;
  settingsModal.setAttribute('aria-hidden', 'false');
  document.body.style.overflow = 'hidden';
  document.getElementById('setName')?.focus();
}

function closeSettings() {
  if (!settingsModal) return;
  settingsModal.hidden = true;
  settingsOverlay.hidden = true;
  settingsModal.setAttribute('aria-hidden', 'true');
  document.body.style.overflow = '';
}

document.getElementById('menuSettings')?.addEventListener('click', () => {
  accountMenu.hidden = true;
  openSettings();
});
document.getElementById('settingsClose')?.addEventListener('click', closeSettings);
settingsOverlay?.addEventListener('click', closeSettings);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && settingsModal && !settingsModal.hidden) closeSettings();
});

settingsForm?.addEventListener('submit', async (e) => {
  e.preventDefault();
  setClearErrors();

  const v = (n) => (settingsForm.querySelector(`[name="${n}"]`)?.value || '').trim();
  const body = {};
  for (const [field, key] of SETTINGS_FIELDS) body[key] = v(field);

  const btn = document.getElementById('settingsSave');
  const label = document.getElementById('settingsSaveLabel');
  btn.disabled = true;
  const original = label.textContent;
  label.textContent = 'Saving…';
  try {
    const res = await fetch('/api/me', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not save your details.');

    // Keep the in-memory session in step, or reopening the modal would show the
    // old values until a reload.
    Object.assign(currentUser, data);

    const ok = document.getElementById('settingsOk');
    if (ok) { ok.textContent = 'Saved — checkout will fill these in for you.'; ok.hidden = false; }
    setTimeout(closeSettings, 1200);
  } catch (err) {
    const box = document.getElementById('settingsError');
    if (box) { box.textContent = err.message; box.hidden = false; }
  } finally {
    btn.disabled = false;
    label.textContent = original;
  }
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

// The six-stage progress bar in My Orders.
//
// Renders ONLY. Which stages exist, which are done and which one is current all
// come from stageTimeline() in src/lib.js — including the rule that a stage
// counts as reached when a LATER one has a timestamp, which is what makes an
// order that skipped paid -> shipped, and the orders that predate these columns,
// draw without holes in the middle.
//
// A stage that was reached without a recorded time shows no time rather than a
// guessed one.
function orderTracker(stages) {
  const box = document.createElement('div');
  box.className = 'order-track';
  // One label for the whole control; the steps themselves are decorative to a
  // screen reader, which gets the sentence below instead.
  box.setAttribute('role', 'group');

  const done = stages.filter((s) => s.done).length;
  const current = stages.find((s) => s.current);
  box.setAttribute('aria-label',
    `Order progress: ${current ? current.label : stages[done - 1]?.label || 'Placed'}` +
    `, step ${Math.max(1, done)} of ${stages.length}.`);

  const row = document.createElement('ol');
  row.className = 'order-track-row';
  row.setAttribute('aria-hidden', 'true');

  for (const s of stages) {
    const li = document.createElement('li');
    li.className = 'order-track-step'
      + (s.done ? ' is-done' : '')
      + (s.current ? ' is-current' : '');

    const dot = document.createElement('span');
    dot.className = 'order-track-dot';

    const lab = document.createElement('span');
    lab.className = 'order-track-label';
    lab.textContent = s.label;

    li.append(dot, lab);

    if (s.at) {
      const t = document.createElement('span');
      t.className = 'order-track-at';
      t.textContent = new Date(Number(s.at)).toLocaleDateString('en-IN',
        { day: 'numeric', month: 'short' });
      li.appendChild(t);
    }
    row.appendChild(li);
  }

  box.appendChild(row);
  return box;
}

  const top = document.createElement('div');
  top.className = 'my-order-top';

  const left = document.createElement('div');
  const ref = document.createElement('div');
  ref.className = 'my-order-ref';
  ref.textContent = o.receipt;
  // The badge used to render the RAW database value — a customer read the word
  // "shipped", and would have read "in_production" once stages existed. Both the
  // label and the stage list are computed server-side (stageTimeline in lib.js)
  // so this file decides nothing about the pipeline.
  const badge = document.createElement('span');
  badge.className = 'my-order-status st-' + o.status;
  badge.textContent = o.status_label || o.status;
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

  // `stages` is null for a cancelled, refunded or failed order: those end the
  // pipeline rather than advancing along it, and a progress bar with a dead end
  // in the middle tells a customer less than the plain badge above already does.
  if (Array.isArray(o.stages) && o.stages.length) {
    wrap.appendChild(orderTracker(o.stages));
  }

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
    // Legacy rows only; new orders are always 'ship'.
    if (o.delivery === 'pickup') bits.push('Collected');
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
        body: JSON.stringify({ items: local.map((it) => ({ product_id: it.id, qty: it.qty, personalisation: it.pz || '' })) }),
      });
    }
    const res = await fetch('/api/me/cart');
    if (!res.ok) return;
    const { items } = await res.json();
    // setItem directly, NOT writeCart — writeCart triggers syncCartUp, which
    // would push straight back to the server in a loop.
    localStorage.setItem(CART_KEY, JSON.stringify(items.map((it) => ({
      id: it.product_id, qty: it.qty, pz: it.personalisation || '',
    }))));
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
    body: JSON.stringify({ items: readCart().map((it) => ({ product_id: it.id, qty: it.qty, personalisation: it.pz || '' })) }),
  }).catch(() => {});
}

// Prefill checkout for a signed-in customer. The server still validates
// everything, and still reads user_id from the cookie rather than these fields.
// Fills checkout from the saved account details. The whole point of Account
// settings: a returning customer should not retype an address they have already
// given, which is the most common reason a repeat order is abandoned on a phone.
//
// Only ever fills an EMPTY field, so anything typed this session wins — someone
// sending a gift to a different address must not have it overwritten by their own.
function prefillCheckout() {
  if (!currentUser) return;
  const fill = (id, value) => {
    const el = document.getElementById(id);
    if (el && !el.value && value) el.value = value;
  };
  fill('coEmail', currentUser.email);
  fill('coName', currentUser.name);
  fill('coPhone', currentUser.phone);
  fill('coLine', currentUser.addr_line);
  fill('coCity', currentUser.addr_city);
  fill('coState', currentUser.addr_state);
  fill('coPin', currentUser.addr_pin);
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
