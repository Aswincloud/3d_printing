// POST /api/sync/shipment — the invoicer telling the shop an order shipped or
// was delivered (2026-10-12).
//
// Until now the sync ran one way. Marking a shop order shipped IN THE SHOP told
// the invoicer (sendOrderShipment), which sent the WhatsApp. Marking it shipped
// IN THE INVOICER sent the WhatsApp and told nobody: AP-f814ee35 sat at "ready"
// in the shop for days after the customer had their tracking message, and
// shipping it there would have looked like it re-notified them.
//
// This is the other direction. It is instant — the invoicer calls it the moment
// its dashboard records a shipment; nothing polls.
//
// What it may do, and nothing more:
//   * move ONE order, found by receipt, along the legal stage transitions to
//     "shipped" or "delivered", stamping the time, and record courier/tracking;
//   * send the shop's own email for that stage, only on the transition.
// What it may never do: touch prices, payment state, items or the customer, move
// a cancelled/refunded order, or call the invoicer back (no loop — the invoicer
// has already sent the WhatsApp; that is why it is calling).
//
// Auth is the shared SHOP_INGEST_SECRET the two Workers already use, HMAC over
// the exact bytes, plus a ±5 minute timestamp window against replay. Fails
// closed when the secret is unset or the feature is off.
import { json, bad, now, hmacHex, timingSafeEqualHex } from "./lib.js";
import { applyStageFromInvoicer } from "./admin.js";

const REPLAY_WINDOW_MS = 5 * 60 * 1000;

export async function shipmentSyncHandler(request, env, ctx) {
  if (String(env.INVOICE_ENABLED ?? "").toLowerCase() !== "true" || !env.SHOP_INGEST_SECRET) {
    return json({ error: "shipment sync is disabled" }, 503);
  }
  const raw = await request.text();
  const sig = request.headers.get("x-invoicer-signature") || "";
  if (!sig) return bad("unauthorized", 401);
  // A distinct prefix, so a body the SHOP signed for the invoicer can never be
  // replayed back at the shop as if the invoicer had sent it.
  const expected = await hmacHex("invoicer->shop\n" + raw, env.SHOP_INGEST_SECRET);
  if (!timingSafeEqualHex(expected, sig)) return bad("unauthorized", 401);

  let b;
  try { b = JSON.parse(raw || "{}"); } catch { return bad("bad request", 400); }
  const skew = Math.abs(now() - Number(b?.ts || 0));
  if (!Number.isFinite(skew) || skew > REPLAY_WINDOW_MS) return bad("unauthorized", 401);

  const receipt = String(b?.receipt || "").trim();
  const kind = String(b?.kind || "");
  if (!/^AP-[0-9a-zA-Z]{6,20}$/.test(receipt)) return bad("bad receipt", 400);
  if (kind !== "shipped" && kind !== "delivered") return bad("bad kind", 400);

  return applyStageFromInvoicer(env, {
    receipt, kind,
    courier: String(b?.courier || "").slice(0, 60),
    tracking: String(b?.tracking || "").slice(0, 80),
    email: b?.email !== false,
  }, ctx);
}
