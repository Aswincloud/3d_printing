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
      // Marks the copy as newer than the account's, so a signed-in visitor's
      // account cart is updated from it rather than replacing it.
      localStorage.setItem('ap_cart_dirty', '1');
      // Replace, never merge, on sign-in: see CART_BACK_KEY in main.js.
      localStorage.setItem('ap_cart_back', '1');
    }
    if (cfg.code) sessionStorage.setItem('ap_promo', String(cfg.code));
  } catch { /* private mode: the shop still opens; they can type the code */ }
  location.replace('/#checkout');
})();
