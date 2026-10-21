-- WhatsApp STOP (2026-10-21). The comeback_offer template says "Reply STOP to
-- opt out of offers", so a STOP to the support number must stop them — for a
-- phone with no account too, which is why it is keyed on the phone and not on
-- users. Last 10 digits, the same comparison the reminders use. START removes it.
CREATE TABLE IF NOT EXISTS wa_optouts (
  phone      TEXT PRIMARY KEY,     -- last 10 digits
  created_at INTEGER NOT NULL
);
