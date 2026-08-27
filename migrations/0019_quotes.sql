-- 0019_quotes.sql — quote requests become records, answerable with a price
--
-- Until now a quote request was two emails and nothing else: the handler in
-- src/index.js mailed Aswin and the customer, and wrote nothing. So the part of
-- the business that turns strangers into orders had none of what orders have —
-- no record, no status, no history, no view of how many arrive or convert. Lose
-- the email and the request is gone.
--
-- receipt is 'QT-<8hex>', mirroring the 'AP-' on orders. It is not decoration:
-- it becomes the Razorpay payment link's reference_id, and reference_id is the
-- ONLY field of ours that survives into the payment_link.paid webhook. It is how
-- a payment finds its way back to the quote that produced it.
CREATE TABLE IF NOT EXISTS quotes (
  id            TEXT PRIMARY KEY,
  receipt       TEXT NOT NULL UNIQUE,
  -- new -> replied (a link was sent) -> paid (the link was paid, an order exists)
  -- won / lost are manual, for work that closed off the payment link path.
  status        TEXT NOT NULL DEFAULT 'new',

  cust_name     TEXT NOT NULL,
  cust_email    TEXT NOT NULL,
  cust_phone    TEXT NOT NULL DEFAULT '',
  type          TEXT NOT NULL DEFAULT '',
  qty           INTEGER NOT NULL DEFAULT 1,
  description   TEXT NOT NULL DEFAULT '',
  -- Which product or photo the request was about, when it came from a card or
  -- the lightbox rather than the open form.
  ref_item      TEXT NOT NULL DEFAULT '',
  -- The uploaded STL or image. Today this exists only as a link inside one email;
  -- losing that email loses the model the customer wants printed.
  file_url      TEXT NOT NULL DEFAULT '',
  file_name     TEXT NOT NULL DEFAULT '',

  -- The answer.
  reply_note    TEXT NOT NULL DEFAULT '',
  quoted_paise  INTEGER,
  -- UNIQUE so a double-clicked Send cannot leave two live, payable links for one
  -- job. The handler also guards on this being NULL before creating one.
  rzp_plink_id  TEXT UNIQUE,
  plink_url     TEXT NOT NULL DEFAULT '',
  plink_expires INTEGER,
  -- Set when the link is paid and a real order row is created from it.
  order_id      TEXT,

  created_at    INTEGER NOT NULL,
  replied_at    INTEGER,
  updated_at    INTEGER NOT NULL
);

-- The dashboard's only hot query is "quotes by status, newest first".
CREATE INDEX IF NOT EXISTS idx_quotes_status ON quotes(status, created_at DESC);
-- The webhook's lookup. UNIQUE on receipt already indexes it, but the webhook
-- reaches for it by that column on every payment and the intent is worth stating.
CREATE INDEX IF NOT EXISTS idx_quotes_receipt ON quotes(receipt);
