// /o/<token>: open Razorpay Checkout for the pending order, then confirm.
// The order id and amount come from the server-rendered data attribute.
(function () {
  const btn = document.getElementById('pay');
  const msg = document.getElementById('msg');
  if (!btn || !window.Razorpay) return;
  const cfg = JSON.parse(btn.dataset.cfg || '{}');
  const say = (t, cls) => { msg.textContent = t; msg.className = 'msg' + (cls ? ' ' + cls : ''); };
  btn.addEventListener('click', () => {
    btn.disabled = true;
    const rzp = new window.Razorpay({
      key: cfg.key, order_id: cfg.order_id, amount: cfg.amount, currency: 'INR',
      name: 'AswinPrints', description: 'Order ' + cfg.receipt,
      prefill: { name: cfg.name, email: cfg.email, contact: cfg.contact },
      notes: { receipt: cfg.receipt }, theme: { color: '#ff6b00' },
      modal: { ondismiss() { btn.disabled = false; say('Payment cancelled — you can try again any time.'); } },
      async handler(r) {
        say('Confirming…');
        try {
          const res = await fetch('/api/orders/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ razorpay_payment_id: r.razorpay_payment_id, razorpay_order_id: r.razorpay_order_id, razorpay_signature: r.razorpay_signature }) });
          if (!res.ok) throw new Error();
          btn.hidden = true;
          say('Payment received — thank you! You’ll get a confirmation by email and WhatsApp shortly.', 'ok');
        } catch {
          say('Your payment went through but we couldn’t confirm it here. Reference ' + (r.razorpay_payment_id || '') + ' — please email aswin@aswincloud.com.', 'err');
        }
      },
    });
    rzp.on('payment.failed', (e) => { btn.disabled = false; say((e?.error?.description || 'The payment did not go through.') + ' You can try again.', 'err'); });
    rzp.open();
  });
})();
