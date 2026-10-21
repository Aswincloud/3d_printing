// WhatsApp STOP / START for the shop's offers (2026-10-21).
//
// The support number's webhook reaches the shop through wa-relay, which forwards
// Meta's exact bytes and X-Hub-Signature-256. The signature is checked here with
// the Meta app secret, so nothing but Meta can opt a number in or out — a forged
// POST without the secret is refused before the body is read as JSON.
//
// Acts on exactly two words and ignores every other message (Chatwoot answers
// those). STOP records the phone in wa_optouts and turns wa_offers off and
// reminders_off on for any account with that phone; START removes the opt-out.
// Nothing is sent back: ShipTrack already acknowledges STOP on this number, and
// a second reply to the same word would be noise.
import { json, hmacHex, timingSafeEqualHex, now } from "./lib.js";

export const phoneKey = (s) => String(s || "").replace(/\D/g, "").slice(-10);

// Same words ShipTrack honours on this number.
export const isStop = (t) => /^\W*(stop|unsubscribe)\W*$/i.test(String(t || ""));
export const isStart = (t) => /^\W*(start|subscribe|resume)\W*$/i.test(String(t || ""));

export async function waOptedOut(env, phone) {
  const key = phoneKey(phone);
  if (key.length !== 10) return false;
  return Boolean(await env.DB.prepare(`SELECT 1 AS hit FROM wa_optouts WHERE phone = ?`).bind(key).first());
}

function inbound(payload, phoneId) {
  const out = [];
  for (const entry of payload?.entry ?? []) {
    for (const change of entry?.changes ?? []) {
      const v = change?.value || {};
      if (phoneId && String(v.metadata?.phone_number_id || "") !== String(phoneId)) continue;
      for (const m of v.messages ?? []) {
        // A typed reply, or the quick-reply text of a button.
        const text = m?.text?.body ?? m?.button?.text ?? m?.interactive?.button_reply?.title ?? "";
        if (m?.from) out.push({ from: String(m.from), text: String(text) });
      }
    }
  }
  return out;
}

export async function waWebhookHandler(request, env) {
  const secret = env.WA_APP_SECRET;
  if (!secret) return json({ error: "not configured" }, 503);
  const raw = await request.text();
  const header = request.headers.get("x-hub-signature-256") || "";
  if (!header.startsWith("sha256=") || !timingSafeEqualHex(header.slice(7).toLowerCase(), await hmacHex(raw, secret))) {
    return json({ error: "bad signature" }, 401);
  }
  let payload;
  try { payload = JSON.parse(raw); } catch { return json({ ok: true }); }

  for (const m of inbound(payload, env.WA_SUPPORT_PHONE_ID)) {
    const key = phoneKey(m.from);
    if (key.length !== 10) continue;
    try {
      if (isStop(m.text)) {
        await env.DB.prepare(`INSERT OR IGNORE INTO wa_optouts (phone, created_at) VALUES (?, ?)`).bind(key, now()).run();
        // users.phone is stored as typed, so match on its digits in JS rather
        // than trust SQL to strip every separator a customer might use.
        const { results } = await env.DB.prepare(`SELECT id, phone FROM users WHERE phone IS NOT NULL AND phone != ''`).all();
        for (const u of results || []) {
          if (phoneKey(u.phone) === key) {
            await env.DB.prepare(`UPDATE users SET wa_offers = 0, reminders_off = 1 WHERE id = ?`).bind(u.id).run();
          }
        }
        console.log("whatsapp STOP recorded");
      } else if (isStart(m.text)) {
        await env.DB.prepare(`DELETE FROM wa_optouts WHERE phone = ?`).bind(key).run();
        console.log("whatsapp START recorded");
      }
    } catch (e) {
      // Never fail the batch: Meta would redeliver all of it to every receiver.
      console.error("whatsapp opt-out failed", e?.message || e);
    }
  }
  // 200 once authenticated, as every receiver behind the relay does.
  return json({ ok: true });
}
