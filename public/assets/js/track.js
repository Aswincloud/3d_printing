// /track: look up an order by number + email/phone. The server renders the
// result (POST /api/track returns the same fields orderHtml() draws), so this
// builds the same markup with textContent only — nothing from the response is
// ever parsed as HTML.
(function () {
  const form = document.getElementById('trackForm');
  const out = document.getElementById('trackResult');
  const msg = document.getElementById('trackMsg');
  if (!form || !out) return;
  const say = (t, err) => { msg.textContent = t; msg.className = 'msg' + (err ? ' err' : ''); };
  const rupees = (p) => '₹' + (Number(p || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 });
  const date = (ms) => ms ? new Date(Number(ms)).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '';
  const el = (tag, cls, text) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; };

  function render(o) {
    const sec = el('section', 'order');
    sec.append(el('h2', '', 'Order ' + o.receipt), el('p', 'sub', 'Placed ' + date(o.created_at)));
    if (o.stages) {
      const ol = el('ol', 'steps');
      for (const s of o.stages) {
        const li = el('li', (s.done ? 'done' : '') + (s.current ? ' cur' : ''));
        li.append(el('span', '', s.label));
        if (s.at) li.append(el('small', '', date(s.at)));
        ol.append(li);
      }
      sec.append(ol);
    } else {
      sec.append(el('p', 'badge', o.status_label));
    }
    if (o.tracking_id) {
      const ship = el('div', 'ship');
      ship.append(el('strong', '', 'Shipped' + (o.courier ? ' with ' + o.courier : '')));
      const line = el('span', '', 'Tracking number ');
      line.append(el('code', '', o.tracking_id));
      ship.append(line);
      // Only https links from the server's allowlist, never anything else.
      if (typeof o.tracking_url === 'string' && /^https:\/\//.test(o.tracking_url)) {
        const a = el('a', 'btn', 'Track the parcel');
        a.href = o.tracking_url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        ship.append(a);
      }
      sec.append(ship);
    }
    const table = el('table');
    const row = (l, r, cls) => { const tr = el('tr', cls || ''); tr.append(el('td', '', l), el('td', 'r', r)); table.append(tr); return tr; };
    for (const it of o.items) {
      const tr = row(it.name + ' × ' + it.qty, rupees(it.price_paise * it.qty));
      if (it.personalisation) { tr.firstChild.append(document.createElement('br'), el('small', '', '“' + it.personalisation + '”')); }
    }
    if (o.discount_paise > 0) row('Discount' + (o.coupon_code ? ' (' + o.coupon_code + ')' : ''), '−' + rupees(o.discount_paise));
    row('Shipping', o.shipping_paise ? rupees(o.shipping_paise) : 'Free');
    row('Total', rupees(o.total_paise), 't');
    sec.append(table);
    out.replaceChildren(sec);
  }

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const receipt = form.receipt.value.trim();
    const contact = form.contact.value.trim();
    if (!receipt || !contact) { say('Enter your order number and your email or phone.', true); return; }
    const btn = form.querySelector('button');
    btn.disabled = true; say('Looking up your order…');
    try {
      const res = await fetch('/api/track', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ receipt, contact }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) { out.replaceChildren(); say(data.error || 'Something went wrong. Please try again.', true); return; }
      say(''); render(data.order);
      out.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch {
      say('Could not reach the shop. Check your connection and try again.', true);
    } finally { btn.disabled = false; }
  });
})();
