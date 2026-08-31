/* Chatwoot live chat — self-hosted, the same instance as aswincloud.com.
 *
 * An EXTERNAL file, not the inline <script> the portfolio uses. This site's CSP
 * has no 'unsafe-inline' in script-src (deliberately — it is the directive that
 * actually stops an injected script from running), so the portfolio's snippet
 * pasted into index.html would be blocked outright. Same code, different home.
 *
 * The CSP also needs support.aswincloud.com on five directives plus the wss://
 * origin for ActionCable; see the note in src/security.js. */

(function (d, t) {
  var BASE_URL = 'https://support.aswincloud.com';
  var g = d.createElement(t);
  var s = d.getElementsByTagName(t)[0];
  g.src = BASE_URL + '/packs/js/sdk.js';
  g.async = true;
  g.defer = true;
  s.parentNode.insertBefore(g, s);

  g.onload = function () {
    if (!window.chatwootSDK) return;
    window.chatwootSDK.run({
      // Inbox 2, "3D Prints" — NOT the portfolio's token. Same Chatwoot app, so
      // there is still one inbox list to check, but a separate inbox is what
      // lets the assistant answer with print facts instead of hosting facts.
      // Sharing the portfolio's token would have meant a customer asking about
      // turnaround being answered from a VPS knowledge base.
      websiteToken: 'oVzVm2LNC6kK1bXiLRC4rNeP',
      baseUrl: BASE_URL,
    });
  };

  // A chat widget is a nice-to-have. If the Chatwoot host is down or slow, the
  // shop must be completely unaffected — so failure is logged and ignored rather
  // than surfaced.
  g.onerror = function () {
    console.warn('chat widget unavailable');
  };
})(document, 'script');

/* Close the panel on an outside click.
 *
 * Carried over from the portfolio, including the reason it is written this way:
 * the chat panel renders in its own iframe, so clicks inside it never bubble to
 * this listener — anything we see is outside by definition. We only need to
 * (a) act while the panel is open and (b) leave the bubble alone so we are not
 * fighting its own toggle.
 *
 * Open state is read from the panel holder, which Chatwoot marks with
 * `woot--hide` when closed. An earlier version keyed off
 * `.woot-widget-bubble--expanded`, which never matches in this SDK version, so
 * outside-click-to-close silently never fired. Keeping the working selector. */
document.addEventListener('click', function (e) {
  if (!window.$chatwoot) return;
  var holder = document.querySelector('#cw-widget-holder, .woot-widget-holder');
  if (!holder || holder.classList.contains('woot--hide')) return;
  var bubble = document.querySelector('#cw-bubble-holder, .woot-widget-bubble');
  if (bubble && bubble.contains(e.target)) return;
  window.$chatwoot.toggle('close');
});

/* Tell Chatwoot who it is talking to.
 *
 * A signed-in customer's name and email mean a conversation arrives identified
 * rather than as "Visitor #4821" — worth a lot when someone is asking about an
 * order. Waits for chatwoot:ready, since setUser before then is a no-op.
 *
 * Guests are NOT identified: there is nothing to identify them with, and calling
 * setUser with empty values creates a junk contact record for every visitor.
 *
 * The identifier is the email, and it is now SIGNED. `identifier_hash` is an HMAC
 * of the email computed in the Worker with a secret the browser never sees, so a
 * visitor cannot open the console and claim someone else's identity — which they
 * could before, and which mattered the moment the assistant gained the ability to
 * read a customer's orders.
 *
 * `shop_token` is separate and does the heavier lifting. It is a short-lived,
 * purpose-bound token minted by /api/me for a verified session, and it is what
 * the bot presents to /api/chat/orders to say WHICH customer is asking.
 * Deliberately not the Chatwoot contact's email: that record is written from
 * here, so trusting it would put the customer list behind Chatwoot being
 * configured correctly. See src/chatorders.js. */
window.addEventListener('chatwoot:ready', function () {
  fetch('/api/me')
    .then(function (r) { return r.ok ? r.json() : null; })
    .then(function (me) {
      if (!me || !me.signedIn || !window.$chatwoot) return;
      window.$chatwoot.setUser(me.email, {
        email: me.email,
        name: me.name || me.email,
        phone_number: me.phone || undefined,
        // Absent until CHATWOOT_HMAC_SECRET is set on the Worker. Chatwoot
        // ignores an identity it cannot verify rather than failing, so this
        // degrades to exactly the old behaviour instead of breaking chat.
        identifier_hash: me.chat_identity_hash || undefined,
      });

      // Carried as a conversation attribute so the bot can read it off the
      // webhook payload. Safe to put here: it is signed, it expires in fifteen
      // minutes, and it is useless without the bot's own secret at the other end.
      if (me.chat_token && window.$chatwoot.setCustomAttributes) {
        window.$chatwoot.setCustomAttributes({ shop_token: me.chat_token });
      }
    })
    .catch(function () { /* not signed in, or the probe failed — chat still works */ });
});
