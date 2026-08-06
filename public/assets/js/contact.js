/* Renders the phone number client-side.
 *
 * The number is a real personal mobile, and a plain +91 XXXXX XXXXX in the HTML
 * gets harvested by the simplest scrapers — the ones that fetch a page and regex
 * for a phone pattern. (Note the placeholder: writing the real number in this
 * comment would hand it straight back to the scraper this file exists to defeat,
 * which is exactly what the first version of this file did.)
 * Assembling it below defeats those without hiding it
 * from anyone who matters: it is fully visible and tappable to a human, to a
 * screen reader (the link gets an aria-label), and to Razorpay's reviewer, who
 * opens the page in a browser.
 *
 * This is friction, not protection. A determined scraper runs a headless browser
 * and gets it anyway. It is worth doing because most do not, and it costs one
 * small file.
 *
 * Deliberately NOT split into a dozen fragments or base64'd: obfuscation that
 * looks like it is hiding something reads badly on a page whose whole purpose is
 * being contactable. */
(function () {
  var el = document.getElementById('contactPhone');
  if (!el) return;

  // Assembled from parts so the complete string never appears in the source.
  var cc = '+' + [9, 1].join('');
  var a = [6, 3, 8, 0, 1].join('');
  var b = [5, 7, 9, 4, 4].join('');

  var link = document.createElement('a');
  link.href = 'tel:' + cc + a + b;
  link.textContent = cc + ' ' + a + ' ' + b;
  link.setAttribute('aria-label', 'Call AswinPrints on ' + cc + ' ' + a + ' ' + b);

  el.textContent = '';
  el.appendChild(link);
})();
