// Quote requests, and answering one with a live payment link.
//
// The assertions that matter here are the ones about money and about the link:
// the amount is typed by hand rather than computed from the catalogue, so the
// bounds are the only thing between a slipped digit and a payable link for the
// wrong sum; and a second link for one job would take a second payment nobody
// can attribute.

import { listQuotes, replyToQuote, updateQuoteStatus } from "../src/quotes.js";
import { QUOTE_MIN_PAISE, QUOTE_MAX_PAISE } from "../src/razorpay.js";
import { quotationEmail } from "../src/emails.js";

let pass = 0, fail = 0;
const ok = (name, cond, detail = "") => {
  if (cond) { pass++; console.log(`  ok   ${name}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? " — " + detail : ""}`); }
};
const section = (s) => console.log(`\n${s}`);
const read = async (res) => [res.status, await res.json()];

const QUOTE = {
  id: "11111111-1111-4111-8111-111111111111",
  receipt: "QT-ABCD1234", status: "new",
  cust_name: "Priya", cust_email: "priya@example.com", cust_phone: "9000090000",
  type: "Personalised Gift", qty: 2, description: "A keychain with a name on it.",
  ref_item: "", file_url: "", file_name: "", reply_note: "",
  quoted_paise: null, rzp_plink_id: null, plink_url: "", plink_expires: null,
  order_id: null, created_at: 1, replied_at: null, updated_at: 1,
};

function envWith(quotes = [{ ...QUOTE }], orders = []) {
  const db = { quotes, orders };
  const run = (sql, a) => {
    const s = sql.replace(/\s+/g, " ").trim();
    if (s.startsWith("SELECT * FROM quotes WHERE id")) {
      return { first: db.quotes.find((q) => q.id === a[0]) || null };
    }
    if (s.startsWith("SELECT id, status FROM quotes WHERE id")) {
      const q = db.quotes.find((x) => x.id === a[0]);
      return { first: q ? { id: q.id, status: q.status } : null };
    }
    if (s.startsWith("SELECT id, receipt, status, cust_name")) {
      const rows = a.length ? db.quotes.filter((q) => q.status === a[0]) : db.quotes;
      return { results: rows };
    }
    if (s.startsWith("SELECT id, receipt, addr_line FROM orders")) {
      const want = new Set(a);
      return { results: db.orders.filter((o) => want.has(o.id)) };
    }
    if (s.startsWith("SELECT status, COUNT(*) AS n FROM quotes")) {
      const m = new Map();
      for (const q of db.quotes) m.set(q.status, (m.get(q.status) || 0) + 1);
      return { results: [...m].map(([status, n]) => ({ status, n })) };
    }
    if (s.startsWith("UPDATE quotes SET status = 'replied'")) {
      const [note, paise, plink, url, exp, rep, upd, id] = a;
      const q = db.quotes.find((x) => x.id === id);
      if (!q) return { meta: { changes: 0 } };
      Object.assign(q, { status: "replied", reply_note: note, quoted_paise: paise,
        rzp_plink_id: plink, plink_url: url, plink_expires: exp, replied_at: rep, updated_at: upd });
      return { meta: { changes: 1 } };
    }
    if (s.startsWith("UPDATE quotes SET status = ?")) {
      const q = db.quotes.find((x) => x.id === a[2]);
      if (q) { q.status = a[0]; q.updated_at = a[1]; }
      return { meta: { changes: q ? 1 : 0 } };
    }
    throw new Error("unhandled SQL: " + s.slice(0, 90));
  };
  return {
    OWNER_EMAIL: "aswin@aswincloud.com",
    APP_BASE_URL: "https://3d-prints.aswincloud.com",
    RAZORPAY_KEY_ID: "rzp_test_x", RAZORPAY_KEY_SECRET: "secret_x",
    RESEND_API_KEY: "re_fake",
    DB: {
      _db: db,
      prepare(sql) {
        return { bind(...a) { this._a = a; return this; },
          async all() { return run(sql, this._a || []); },
          async first() { return run(sql, this._a || []).first ?? null; },
          async run() { return run(sql, this._a || []); } };
      },
      async batch(sts) { return Promise.all(sts); },
    },
  };
}

// Captures both outbound calls: Razorpay's payment_links, and Resend.
function stubFetch({ linkOk = true } = {}) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    calls.push({ url: u, body: init?.body ? JSON.parse(init.body) : null });
    if (u.includes("/payment_links")) {
      if (!linkOk) {
        return new Response(JSON.stringify({ error: { description: "nope" } }), { status: 400 });
      }
      return new Response(JSON.stringify({
        id: "plink_TEST123", short_url: "https://rzp.io/i/abc", status: "created",
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "email_1" }), { status: 200 });
  };
  return calls;
}

// ══ AMOUNT BOUNDS ════════════════════════════════════════════════
section("reply — the amount is typed by hand, so the bounds are the guard");
{
  for (const [label, amount] of [
    ["zero", 0], ["negative", -50], ["not a number", "abc"], ["empty", ""],
    ["below the ₹1 floor", 0.5],
    ["above the ₹5,00,000 ceiling", (QUOTE_MAX_PAISE / 100) + 1],
  ]) {
    const env = envWith(); const calls = stubFetch();
    const [status] = await read(await replyToQuote(env, QUOTE.id, { amount_rupees: amount }));
    ok(`${label} → 400`, status === 400, String(status));
    // The critical half: no live payment link was created for a bad amount.
    ok(`${label} created no link`, calls.every((c) => !c.url.includes("payment_links")));
  }

  const env = envWith(); stubFetch();
  const [okStatus] = await read(await replyToQuote(env, QUOTE.id, { amount_rupees: QUOTE_MIN_PAISE / 100 }));
  ok("exactly ₹1 is allowed", okStatus === 200, String(okStatus));
}

// ══ ONE LINK PER QUOTE ═══════════════════════════════════════════
section("reply — a second link is refused");
{
  const env = envWith(); const calls = stubFetch();
  const [first] = await read(await replyToQuote(env, QUOTE.id, { amount_rupees: 499, note: "Two days." }));
  ok("first reply succeeds", first === 200, String(first));

  const [second, out] = await read(await replyToQuote(env, QUOTE.id, { amount_rupees: 999 }));
  ok("second reply → 409", second === 409, String(second));
  ok("says why", /already been sent/i.test(out.error || ""), out.error);
  const links = calls.filter((c) => c.url.includes("payment_links"));
  ok("only ONE payment link was ever created", links.length === 1, String(links.length));
}

// ══ WHAT REACHES RAZORPAY ════════════════════════════════════════
section("reply — the link carries the reference the webhook needs");
{
  const env = envWith(); const calls = stubFetch();
  await replyToQuote(env, QUOTE.id, { amount_rupees: 1234.5, note: "Hi", expiry_days: 3 });
  const link = calls.find((c) => c.url.includes("payment_links")).body;

  ok("amount in paise", link.amount === 123450, String(link.amount));
  // Without this the payment_link.paid webhook has no way back to the quote and
  // the money arrives unattributable.
  ok("reference_id is the quote receipt", link.reference_id === "QT-ABCD1234", link.reference_id);
  ok("customer carried", link.customer.email === "priya@example.com");
  ok("expiry set", Number.isInteger(link.expire_by), String(link.expire_by));
  // Razorpay wants seconds, not milliseconds. Off by 1000 and the link expires
  // in 1970 or in the year 57000.
  ok("expiry is in SECONDS", String(link.expire_by).length === 10, String(link.expire_by));

  const q = env.DB._db.quotes[0];
  ok("stored on the quote", q.rzp_plink_id === "plink_TEST123" && q.status === "replied");
  ok("stored the amount", q.quoted_paise === 123450, String(q.quoted_paise));
}

section("reply — the link is stored even if the email fails");
{
  const env = envWith();
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/payment_links")) {
      return new Response(JSON.stringify({ id: "plink_X", short_url: "https://rzp.io/i/x" }), { status: 200 });
    }
    return new Response("boom", { status: 500 });   // Resend down
  };
  const [status, out] = await read(await replyToQuote(env, QUOTE.id, { amount_rupees: 100 }));
  ok("still 200", status === 200, String(status));
  ok("reports the email failed", out.emailed === false);
  // Mailing a link we have no record of is the one outcome that cannot be undone.
  ok("the link is recorded", env.DB._db.quotes[0].rzp_plink_id === "plink_X");
}

section("reply — Razorpay refusing means nothing is recorded");
{
  const env = envWith(); stubFetch({ linkOk: false });
  const [status] = await read(await replyToQuote(env, QUOTE.id, { amount_rupees: 500 }));
  ok("502", status === 502, String(status));
  ok("quote untouched", env.DB._db.quotes[0].status === "new");
  ok("no phantom link id", !env.DB._db.quotes[0].rzp_plink_id);
}

// ══ STATUS ═══════════════════════════════════════════════════════
section("status — paid is the webhook's word, not the dashboard's");
{
  const env = envWith();
  const [status, out] = await read(await updateQuoteStatus(env, QUOTE.id, { status: "paid" }));
  // Same rule as orders: the dashboard cannot claim money moved.
  ok("cannot be set to paid by hand", status === 400, String(status));
  ok("says why", /payment/i.test(out.error || ""), out.error);

  ok("unknown status refused",
     (await read(await updateQuoteStatus(env, QUOTE.id, { status: "banana" })))[0] === 400);

  const [w] = await read(await updateQuoteStatus(env, QUOTE.id, { status: "won" }));
  ok("won is allowed", w === 200 && env.DB._db.quotes[0].status === "won");

  const paidEnv = envWith([{ ...QUOTE, status: "paid" }]);
  ok("a paid quote cannot be reopened",
     (await read(await updateQuoteStatus(paidEnv, QUOTE.id, { status: "lost" })))[0] === 409);
}

// ══ LISTING ══════════════════════════════════════════════════════
section("list — flags a paid quote whose order has nowhere to ship");
{
  const env = envWith(
    [{ ...QUOTE, status: "paid", order_id: "o-1" }],
    [{ id: "o-1", receipt: "AP-1", addr_line: "" }],
  );
  const [, out] = await read(await listQuotes(env, new URL("https://x/api/admin/quotes")));
  ok("flagged", out.quotes[0].needs_address === true, JSON.stringify(out.quotes[0].needs_address));

  const withAddr = envWith(
    [{ ...QUOTE, status: "paid", order_id: "o-1" }],
    [{ id: "o-1", receipt: "AP-1", addr_line: "1 Test Street" }],
  );
  const [, out2] = await read(await listQuotes(withAddr, new URL("https://x/api/admin/quotes")));
  ok("not flagged when the address is there", out2.quotes[0].needs_address === false);
}

// ══ THE EMAIL ════════════════════════════════════════════════════
section("the quotation email");
{
  const html = quotationEmail({ APP_BASE_URL: "https://shop.test" }, {
    ...QUOTE, quoted_paise: 123450, plink_url: "https://rzp.io/i/abc",
    plink_expires: 1787000000000, reply_note: "Two <days> & counting",
  });
  ok("carries the amount", html.includes("1,234.5"), html.slice(0, 0) || "amount missing");
  ok("carries the pay link", html.includes("https://rzp.io/i/abc"));
  ok("names the receipt", html.includes("QT-ABCD1234"));
  // Customer-typed text and owner-typed notes both land in HTML here.
  ok("the note is escaped", html.includes("&lt;days&gt;") && !html.includes("<days>"));
  ok("no NaN anywhere", !/NaN/.test(html));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
