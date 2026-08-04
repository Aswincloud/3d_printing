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
// Fine-grained PAT: Actions write only on this repo (see README for setup)
const DISPATCH_TOKEN = 'REPLACE_WITH_DISPATCH_TOKEN';

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
    const res = await fetch('https://api.github.com/repos/Aswincloud/3d_printing/dispatches', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${DISPATCH_TOKEN}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ event_type: 'quote_request', client_payload: payload }),
    });

    if (res.status === 204) {
      formContent.style.display = 'none';
      formSuccess.classList.add('show');
    } else {
      throw new Error(`Status ${res.status}`);
    }
  } catch (err) {
    showFormError('Something went wrong sending your request. Please try again, or email aswin@aswincloud.com.');
    btn.innerHTML = SUBMIT_LABEL;
    btn.disabled = false;
    console.error('Dispatch error:', err);
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
