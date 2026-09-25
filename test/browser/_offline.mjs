// Every browser suite runs against `python3 -m http.server public/`, but the
// pages still reach out for Google Fonts, the Razorpay checkout script, the
// Chatwoot widget and Cloudflare Insights. None of the suites assert on any of
// them — and `waitUntil: 'load'` waits for all of them.
//
// On a GitHub runner that wait sometimes exceeds Playwright's 30s goto timeout.
// The symptom is a `page.goto: Timeout` in whichever suite happens to be first
// to hit a slow host: hero-geometry in one run, checkout-mobile in the next,
// pin-control passing in between. Main has hit it once before this. Two runs on
// one commit failing in DIFFERENT suites is what distinguishes it from a real
// regression, which fails in the same place twice.
//
// So: abort every request to a host that is not the local server, before the
// page is opened. `load` then fires from local files alone, every suite keeps
// its existing `load` semantics, and no assertion changes meaning. Hosts are
// matched by suffix so a new CDN subdomain does not silently reopen the race.
export async function offline(page) {
  await page.route((url) => {
    const h = url.hostname;
    return h !== 'localhost' && h !== '127.0.0.1';
  }, (route) => route.abort('blockedbyclient'));
}
