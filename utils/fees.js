// utils/fees.js
// Ticket fee rules: a per-ticket service fee (set by the super admin, with a
// per-event override) added to the ticket price, and the Bachs processing fee,
// which Bachs adds on top for the buyer when "customer bears fee" is on.
//
// Breakdown of an online ticket order:
//   subtotal     = ticket price x quantity          -> NACOS
//   service fee  = service fee per ticket x qty     -> portal service fee
//   total        = subtotal + service fee           -> what we ask Bachs to charge
//   + Bachs fee  (added by Bachs at checkout when customer bears fee)

const { supabase } = require('../config/supabase');

const DEFAULT_SETTINGS = Object.freeze({
  member_service_fee: 0,
  guest_service_fee: 0,
  customer_bears_gateway_fee: true
});

const CACHE_MS = 60 * 1000;
let cache = null;
let cacheAt = 0;

const money = (n) => Math.round(Number(n || 0) * 100) / 100;

/** Current fee settings (cached for a minute). Falls back to no service fee. */
async function getFeeSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < CACHE_MS) return cache;
  try {
    const { data, error } = await supabase.from('fee_settings').select('*').eq('id', 1).maybeSingle();
    if (error) throw error;
    cache = data
      ? {
          member_service_fee: money(data.member_service_fee),
          guest_service_fee: money(data.guest_service_fee),
          customer_bears_gateway_fee: data.customer_bears_gateway_fee !== false,
          updated_at: data.updated_at || null
        }
      : { ...DEFAULT_SETTINGS };
  } catch (err) {
    // Before migration 023 the table doesn't exist: charge no service fee.
    console.warn('[fees] using defaults:', err?.message || err);
    cache = { ...DEFAULT_SETTINGS };
  }
  cacheAt = Date.now();
  return cache;
}

function invalidateFeeSettings() {
  cache = null;
  cacheAt = 0;
}

/** Service fee per ticket for this event and buyer type. */
function serviceFeePerTicket(event, settings, { guest = false } = {}) {
  const override = event?.service_fee_override;
  if (override !== null && override !== undefined && override !== '' && Number.isFinite(Number(override))) {
    return money(Math.max(0, Number(override)));
  }
  return money(guest ? settings.guest_service_fee : settings.member_service_fee);
}

/** Full price breakdown for an online order. */
function orderBreakdown({ unitPrice, quantity, feePerTicket }) {
  const subtotal = money(Number(unitPrice) * quantity);
  const serviceFee = money(Number(feePerTicket || 0) * quantity);
  return {
    unit_price: money(unitPrice),
    quantity,
    service_fee_per_ticket: money(feePerTicket || 0),
    subtotal_amount: subtotal,
    service_fee: serviceFee,
    total_amount: money(subtotal + serviceFee)
  };
}

/** Bachs processing fee reported on a gateway object, if any (in naira). */
function gatewayFeeOf(obj = {}) {
  const raw = obj.fees?.amount ?? obj.fee ?? obj.processing_fee ?? obj.fees_amount;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? money(n) : null;
}

module.exports = {
  getFeeSettings,
  invalidateFeeSettings,
  serviceFeePerTicket,
  orderBreakdown,
  gatewayFeeOf,
  money
};
