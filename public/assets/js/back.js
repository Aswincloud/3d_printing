// /back/<token>: a reminder's "Finish my order" link. Puts the items back in the
// cart and hands over to checkout with the COMEBACK code filled in. Ids and
// quantities only — the shop prices everything at checkout, as it always does.
(function () {
  const el = document.getElementById('back');
  if (!el) return;
  let cfg = {};
  try { cfg = JSON.parse(el.dataset.cfg || '{}'); } catch { /* fall through to the shop */ }
  const cart = Array.isArray(cfg.cart) ? cfg.cart : [];
  try {
    if (cart.length) {
      localStorage.setItem('ap_cart', JSON.stringify(cart));
      // Not any account's mirror any more. Left in place, an expired session's
      // stamp makes main.js drop this freshly restored cart as a stale mirror.
      localStorage.removeItem('ap_cart_owner');
      if (cfg.own) {
        // An account's own cart: on sign-in it replaces the server copy rather
        // than merging (which would double it). Timestamped, and honoured only
        // briefly — see CART_BACK_KEY in main.js.
        localStorage.setItem('ap_cart_back', String(Date.now()));
      } else {
        localStorage.removeItem('ap_cart_back');
      }
    }
    if (cfg.code) sessionStorage.setItem('ap_promo', String(cfg.code));
  } catch { /* private mode: the shop still opens; they can type the code */ }
  location.replace('/#checkout');
})();
