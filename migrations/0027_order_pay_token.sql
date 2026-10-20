-- A link a customer can use to finish paying a pending order (2026-10-20).
--
-- /o/<pay_token> shows the order and opens Razorpay Checkout for the SAME
-- Razorpay order and the SAME amount — the server reads both from the row; the
-- page cannot change either. The token is 32 hex characters of randomness, unique,
-- minted when the order is created (and lazily for older pending orders).
--
-- pay_reminder_at: when the owner last sent the "payment pending" WhatsApp,
-- so the dashboard can show it and warn before sending a second.
ALTER TABLE orders ADD COLUMN pay_token TEXT;
ALTER TABLE orders ADD COLUMN pay_reminder_at INTEGER;
CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_pay_token ON orders(pay_token) WHERE pay_token IS NOT NULL;
