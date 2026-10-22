// Shopper activity (src/activity.js): tells the shop "a visitor viewed / added /
// opened checkout / pressed Pay", so the owner's dashboard can show that someone
// is shopping — guests included. The visitor id is random and per browser; no
// name, email or phone is ever sent from here. Fire-and-forget: it can never
// block or break a page, and a failed send is simply lost.
(function () {
  const KEY = 'ap_sid';
  let sid = '';
  try {
    sid = localStorage.getItem(KEY) || '';
    if (!/^[0-9a-f]{16}$/.test(sid)) {
      const b = new Uint8Array(8);
      crypto.getRandomValues(b);
      sid = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(KEY, sid);
    }
  } catch { /* private mode: one id for this page view only */ }
  if (!sid) {
    const b = new Uint8Array(8); crypto.getRandomValues(b);
    sid = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  }
  const seen = new Set();
  window.apTrack = function (kind, data = {}) {
    // One view per product per page load: reopening a lightbox is not news.
    if (kind === 'view') { const k = 'v:' + data.product_id; if (seen.has(k)) return; seen.add(k); }
    try {
      const body = JSON.stringify({ sid, kind, ...data });
      // keepalive so "pressed Pay" survives the page handing over to Razorpay.
      fetch('/api/activity', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
    } catch { /* never break the page */ }
  };
})();
