/* Sign-in: email → 6-digit code → session.
 *
 * The server is deliberately vague on purpose — it returns {ok:true} for an
 * unknown address, a throttled address and a failed send alike, so this page
 * can't be used to discover which emails have accounts. That means the UI must
 * not promise "we found your account"; it says "we sent a code" and lets the
 * inbox be the source of truth. */

const $ = (id) => document.getElementById(id);
const EMAIL_RE = /^[^\s@]+@[^\s@.]+(\.[^\s@.]+)+$/;

let pendingEmail = '';
let cooldownTimer = null;

function setFieldError(name, message) {
  const field = document.querySelector('[name="' + name + '"]');
  const slot = $(name + 'Error');
  if (field) { field.classList.add('invalid'); field.setAttribute('aria-invalid', 'true'); }
  if (slot) { slot.textContent = message; slot.classList.add('show'); }
}

function clearFieldError(name) {
  const field = document.querySelector('[name="' + name + '"]');
  const slot = $(name + 'Error');
  if (field) { field.classList.remove('invalid'); field.removeAttribute('aria-invalid'); }
  if (slot) slot.classList.remove('show');
}

function banner(message, isError) {
  const err = $('loginError');
  const good = $('loginOk');
  err.hidden = true; good.hidden = true;
  if (!message) return;
  const box = isError ? err : good;
  box.textContent = message;
  box.hidden = false;
}

function busy(btn, label, on, workingText) {
  btn.disabled = on;
  label.textContent = on ? workingText : label.dataset.idle;
}

/* ── step 1: request a code ─────────────────────────────────────── */
const sendBtn = $('sendBtn');
const sendLabel = $('sendLabel');
sendLabel.dataset.idle = sendLabel.textContent;

$('emailForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearFieldError('login_email');
  banner('');

  const email = $('loginEmail').value.trim();
  if (!EMAIL_RE.test(email)) {
    setFieldError('login_email', 'Please enter a valid email address.');
    return;
  }

  busy(sendBtn, sendLabel, true, 'Sending…');
  try {
    const res = await fetch('/api/auth/code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not send the code.');

    pendingEmail = email;
    $('sentTo').textContent = email;
    if (data.ttl_minutes) $('ttlMins').textContent = String(data.ttl_minutes);
    $('stepEmail').hidden = true;
    $('stepCode').hidden = false;
    $('loginCode').focus();
    startCooldown(60);
  } catch (err) {
    banner(err.message, true);
  } finally {
    busy(sendBtn, sendLabel, false);
  }
});

/* ── step 2: verify ─────────────────────────────────────────────── */
const verifyBtn = $('verifyBtn');
const verifyLabel = $('verifyLabel');
verifyLabel.dataset.idle = verifyLabel.textContent;

$('codeForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  clearFieldError('login_code');
  banner('');

  const code = $('loginCode').value.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(code)) {
    setFieldError('login_code', 'Enter the 6-digit code from the email.');
    return;
  }

  busy(verifyBtn, verifyLabel, true, 'Signing in…');
  try {
    const res = await fetch('/api/auth/code/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: pendingEmail, code }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'That code did not work.');

    // Hand the guest cart over before leaving the page. localStorage is the
    // guest source of truth; once merged, the server is, so clear it.
    await mergeGuestCart();

    const next = new URLSearchParams(location.search).get('next');
    // Only same-origin relative paths — an absolute URL here would be an open
    // redirect straight off the sign-in page.
    const dest = next && /^\/[^/\\]/.test(next) ? next : '/account';
    location.href = dest;
  } catch (err) {
    banner(err.message, true);
    busy(verifyBtn, verifyLabel, false);
  }
});

async function mergeGuestCart() {
  let items = [];
  try {
    const raw = JSON.parse(localStorage.getItem('ap_cart') || '[]');
    if (Array.isArray(raw)) {
      items = raw
        .filter((x) => x && typeof x.id === 'string')
        .map((x) => ({ product_id: x.id, qty: parseInt(x.qty, 10) || 1 }));
    }
  } catch { /* corrupt cart: nothing to merge */ }

  try {
    await fetch('/api/me/cart/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    });
    // Server is authoritative from here on; drop the local copy so the two
    // can't drift.
    localStorage.removeItem('ap_cart');
  } catch {
    // Merge failed — keep localStorage so the cart isn't lost, and let
    // account.js reconcile on next load.
  }
}

/* ── resend, with a visible cooldown ───────────────────────────── */
const resendBtn = $('resendBtn');

function startCooldown(seconds) {
  clearInterval(cooldownTimer);
  let left = seconds;
  const tick = () => {
    if (left <= 0) {
      clearInterval(cooldownTimer);
      resendBtn.disabled = false;
      resendBtn.textContent = 'Resend code';
      return;
    }
    resendBtn.disabled = true;
    resendBtn.textContent = `Resend in ${left}s`;
    left -= 1;
  };
  tick();
  cooldownTimer = setInterval(tick, 1000);
}

resendBtn.addEventListener('click', async () => {
  banner('');
  resendBtn.disabled = true;
  try {
    const res = await fetch('/api/auth/code/resend', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: pendingEmail }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Could not resend.');
    // The server may report its own remaining cooldown; honour it.
    startCooldown(data.cooldown_seconds || 60);
    banner(data.cooldown_seconds
      ? `Please wait ${data.cooldown_seconds}s before requesting another code.`
      : 'Another code is on its way.', false);
  } catch (err) {
    banner(err.message, true);
    resendBtn.disabled = false;
  }
});

$('changeEmailBtn').addEventListener('click', () => {
  clearInterval(cooldownTimer);
  banner('');
  clearFieldError('login_code');
  $('loginCode').value = '';
  $('stepCode').hidden = true;
  $('stepEmail').hidden = false;
  $('loginEmail').focus();
});

['loginEmail', 'loginCode'].forEach((id) => {
  $(id).addEventListener('input', () => {
    clearFieldError($(id).name);
    banner('');
  });
});

/* Already signed in? Skip straight through. */
(async () => {
  try {
    const me = await (await fetch('/api/me')).json();
    if (me.signedIn) location.replace('/account');
  } catch { /* not signed in; stay */ }
})();
