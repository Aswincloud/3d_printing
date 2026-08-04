-- 0001_init.sql — shop schema for 3dprints-db
--
-- Conventions follow ~/projects/invoicer: IF NOT EXISTS everywhere,
-- TEXT PRIMARY KEY holding a uuid, timestamps as INTEGER epoch-ms supplied by
-- the app (not SQLite defaults), indexes named idx_<table>_<cols>,
-- forward-only migrations.
--
-- One deliberate deviation from invoicer: money is INTEGER *paise*, not REAL
-- rupees. Razorpay's API is integer-paise natively, so this avoids a
-- float→int conversion on every amount, and avoids rounding drift when
-- summing line items.

CREATE TABLE IF NOT EXISTS products (
  id          TEXT PRIMARY KEY,        -- uuid
  slug        TEXT NOT NULL UNIQUE,    -- 'tinkerbell-figurine'
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  price_paise INTEGER NOT NULL,        -- 34900 = ₹349
  image       TEXT NOT NULL,           -- assets/images/....jpg
  images      TEXT NOT NULL DEFAULT '',-- extra views, comma-separated
  category    TEXT NOT NULL DEFAULT '',-- figurine | decor | functional | set
  visible     INTEGER NOT NULL DEFAULT 0,
  sort        INTEGER NOT NULL DEFAULT 0,
  created_at  INTEGER NOT NULL,
  updated_at  INTEGER NOT NULL
);

-- The shop's only hot query is "visible products in display order".
CREATE INDEX IF NOT EXISTS idx_products_visible ON products(visible, sort);

CREATE TABLE IF NOT EXISTS orders (
  id              TEXT PRIMARY KEY,      -- uuid, our id
  receipt         TEXT NOT NULL UNIQUE,  -- 'AP-<8hex>'; Razorpay caps receipt at 40 chars
  rzp_order_id    TEXT UNIQUE,
  rzp_payment_id  TEXT,
  status          TEXT NOT NULL,         -- pending|paid|failed|shipped|cancelled|refunded
  subtotal_paise  INTEGER NOT NULL,      -- every amount here is server-computed
  shipping_paise  INTEGER NOT NULL,
  total_paise     INTEGER NOT NULL,
  currency        TEXT NOT NULL DEFAULT 'INR',
  delivery        TEXT NOT NULL DEFAULT 'ship',  -- ship|pickup
  cust_name       TEXT NOT NULL,
  cust_email      TEXT NOT NULL,
  cust_phone      TEXT NOT NULL DEFAULT '',
  addr_line       TEXT NOT NULL DEFAULT '',
  addr_city       TEXT NOT NULL DEFAULT '',
  addr_state      TEXT NOT NULL DEFAULT '',
  addr_pin        TEXT NOT NULL DEFAULT '',
  notes           TEXT NOT NULL DEFAULT '',
  created_at      INTEGER NOT NULL,
  paid_at         INTEGER,
  shipped_at      INTEGER
);

CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_orders_created ON orders(created_at DESC);

-- Line items SNAPSHOT name and price at purchase time. Prices change; an order
-- must always render what was actually charged, so nothing that displays money
-- may join back to products.
CREATE TABLE IF NOT EXISTS order_items (
  id           TEXT PRIMARY KEY,
  order_id     TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id   TEXT,                  -- nullable on purpose: product may be deleted later
  name         TEXT NOT NULL,         -- snapshot
  price_paise  INTEGER NOT NULL,      -- snapshot
  qty          INTEGER NOT NULL,
  pos          INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_order_items_order ON order_items(order_id, pos);

-- Webhook idempotency. Razorpay delivery is at-least-once and unordered, so
-- the primary key is *their* event id: a redelivery is an INSERT OR IGNORE
-- no-op and the handler can exit 200 without touching order state again.
CREATE TABLE IF NOT EXISTS webhook_events (
  event_id    TEXT PRIMARY KEY,      -- x-razorpay-event-id header
  event_type  TEXT NOT NULL,
  order_id    TEXT,
  received_at INTEGER NOT NULL
);
