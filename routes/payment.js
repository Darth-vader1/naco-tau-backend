// routes/payments.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin, requireSuperAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { successResponse, errorResponse, generateTransactionId } = require('../utils/helpers');
const { sendEventTicketEmail, sendPaymentAdminNotificationEmail } = require('../services/email');
const crypto = require('crypto');
const { markAbandonedCheckouts, maybeMarkAbandonedCheckouts } = require('../utils/abandonedCheckouts');
const rateLimit = require('express-rate-limit');
const { registerLimiter } = require('../middleware/rateLimitInstances');
const {
  MAX_TICKETS_PER_ORDER,
  parseTicketQuantity,
  quantityOf,
  orderTotal,
  seatsRemaining,
  syncAttendeeCount
} = require('../utils/tickets');
const {
  getFeeSettings,
  invalidateFeeSettings,
  serviceFeePerTicket,
  orderBreakdown,
  gatewayFeeOf,
  gatewayFeePaidByOf,
  money
} = require('../utils/fees');
const {
  loadEventItems,
  playsRemainingForItem,
  titleWithGames,
  gamesSummary,
  playsLabel,
  parseGameLines,
  linesFromRow,
  priceGameLines,
  gameBreakdown,
  gameColumns,
  describeGameOrder
} = require('../utils/games');

// ============================================
// PAYMENT SAFETY HELPERS
// ============================================

const isProductionEnv = () =>
  process.env.NODE_ENV === 'production' || process.env.VERCEL_ENV === 'production';

// Simulated (fake) payments are only ever allowed when explicitly opted in for
// local development. They can never be enabled on a production deployment.
const isPaymentSimulationAllowed = () =>
  process.env.ALLOW_PAYMENT_SIMULATION === 'true' && !isProductionEnv();

const isBachsKeyConfigured = (key) => !!key && !key.includes('placeholder');

// ---- Gateway response helpers ----------------------------------------------
// Bachs (like most gateways) reports state in several fields and uses
// different words for "paid" (e.g. status "complete" + payment_status "paid").
// A payment counts as paid if ANY status field says so.
const PAID_STATES = new Set(['completed', 'complete', 'success', 'successful', 'succeeded', 'paid', 'captured', 'settled']);
const statusFieldsOf = (obj = {}) =>
  [obj.status, obj.payment_status, obj.paymentStatus, obj.state, obj.charge?.status, obj.payment?.status]
    .filter(v => typeof v === 'string' && v.trim())
    .map(v => v.trim().toLowerCase());
const isGatewayPaid = (obj = {}) => obj.paid === true || statusFieldsOf(obj).some(s => PAID_STATES.has(s));
const describeGatewayStatus = (obj = {}) => statusFieldsOf(obj).join('/');

// Every identifier a gateway object may carry. Checkout-session IDs come first:
// they are what our server records when a checkout starts (chk_...), while
// "id" on a payment/charge event is the charge ID (ch_...).
const gatewayIdsOf = (obj = {}) => {
  const ids = [
    obj.checkout_id, obj.checkout_session_id, obj.checkoutSessionId, obj.session_id,
    obj.checkout?.id, obj.checkout_session?.id, obj.session?.id,
    obj.metadata?.checkout_id, obj.metadata?.checkout_session_id,
    obj.id, obj.reference, obj.payment_id, obj.charge_id, obj.charge?.id, obj.code
  ];
  return [...new Set(ids.filter(v => typeof v === 'string' && v.trim()).map(v => v.trim()))];
};

// Constant-time string comparison (returns false on length mismatch).
const safeEqual = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

/**
 * Load a payable event and its authoritative price (in Naira) from the DB.
 * The client-supplied amount is never trusted.
 */
async function loadPayableEvent(eventId, { guest = false, lines = null, settling = false } = {}) {
  const { data: event, error } = await supabase
    .from('events')
    .select('*')
    .eq('id', eventId)
    .maybeSingle();
  if (error) throw error;
  if (!event) return { error: 'Target event not found', status: 404 };

  // Game events: the buyer picks one or more games, each with a number of
  // plays; every game is priced PER PLAY. The order quantity is total plays.
  const items = await loadEventItems(event.id);
  // Game lines sent for an event that has no games: refuse, so the order
  // can't fall through to ticket pricing with no quantity (a ₦0 checkout).
  if (!items.length && lines && lines.length && !settling) {
    return { error: 'This event has no games to choose from.', status: 400 };
  }
  if (items.length || (settling && lines && lines.length)) {
    if (!lines || !lines.length) return { error: 'Please choose at least one game.', status: 400 };
    const game = await priceGameLines(event, lines, { guest, settling, activeItems: items });
    if (game.error) return game;
    return { event, game, price: game.lines.length === 1 ? game.lines[0].unit_price : null };
  }

  if (guest) {
    // Non-members pay the per-event guest price, only when the admin has
    // opened the event to the public.
    const guestPrice = Number(event.public_price);
    if (!event.open_to_public || !Number.isFinite(guestPrice) || guestPrice <= 0) {
      return { error: 'This event is not open to non-members.', status: 403 };
    }
    return { event, price: guestPrice };
  }

  const price = Number(event.payment_amount);
  if (!Number.isFinite(price) || price <= 0) {
    return { error: 'This event does not require payment.', status: 400 };
  }
  return { event, price };
}

/** Refuse an order that asks for more plays of a game than it has left. */
async function gameCapacityError(game) {
  if (!game) return null;
  for (const l of game.lines) {
    const left = await playsRemainingForItem(l._item || { id: l.item_id });
    if (l.plays > left) {
      return left === 0 ? `${l.name} is fully booked.` : `Only ${left} play(s) of ${l.name} left.`;
    }
  }
  return null;
}

/** "FIFA × 2, Ludo × 1 (3 plays)" or "2 tickets" for checkout labels. */
const orderLabel = (game, quantity) => game
  ? `${gamesSummary(game.lines)}${game.lines.length > 1 ? ` (${playsLabel(quantity)})` : `, ${playsLabel(quantity)}`}`
  : `${quantity} ticket${quantity > 1 ? 's' : ''}`;

/** Public view of the games in an order. */
const publicGames = (lines) => lines && lines.length
  ? lines.map(l => ({ id: l.item_id, name: l.name, plays: l.plays, ...(l.unit_price != null ? { unit_price: l.unit_price } : {}) }))
  : null;

/**
 * Build a simulated (fake) payment-session response — local development only.
 */
const simulationSession = (res, price, eventId, reason) => successResponse(res, {
  checkout_url: `/simulation-checkout.html?amount=${price}&event_id=${encodeURIComponent(eventId)}`,
  checkout_id: `chk_mock_${Date.now()}`,
  is_simulation: true,
  simulation_reason: reason
}, 'Mock session created');

// Marks a payments row that was created when an online checkout started (not a
// manually uploaded proof). Such rows are settled only by gateway confirmation
// (verify / re-check / webhook), never by an admin manually approving them.
const ONLINE_CHECKOUT_MARKER = '[online-checkout]';
const isOnlineCheckoutRow = (p) => !!p && typeof p.notes === 'string' && p.notes.includes(ONLINE_CHECKOUT_MARKER);

// Archived (soft-deleted) payments, e.g. test orders: migration 029. The
// column is detected (and the answer cached for 5 minutes) so reports keep
// working before the migration has been run.
let archiveSupport = { ok: false, at: 0 };
async function archiveColumnExists() {
  if (archiveSupport.at && Date.now() - archiveSupport.at < 300000) return archiveSupport.ok;
  const { error } = await supabase.from('payments').select('archived_at').limit(1);
  archiveSupport = { ok: !error, at: Date.now() };
  return archiveSupport.ok;
}

const frontendBase = () => process.env.FRONTEND_URL ? process.env.FRONTEND_URL.split(',')[0].trim() : 'https://nacosportal.vercel.app';
const receiptUrlFor = (reference) => `${frontendBase()}/receipt.html?reference=${encodeURIComponent(reference)}`;

// Deterministic ticket number: identical to the receipt page fallback, so the
// emailed ticket, the receipt and repeated verifications always agree.
const ticketNumberFor = (eventId, paymentId) =>
  'NACOS-' + String(eventId).substring(0, 4).toUpperCase() + '-' + String(paymentId).substring(0, 6).toUpperCase();

// Resolve within `ms` or give up (the work keeps going, we just stop waiting).
const withTimeout = (promise, ms, label) => Promise.race([
  promise,
  new Promise(resolve => setTimeout(() => {
    console.warn(`[payments] ${label} still running after ${ms}ms; continuing without waiting.`);
    resolve();
  }, ms))
]);

/**
 * Idempotently register `userId` for `event` against a verified `payment`,
 * then (first time only) send the ticket + admin emails and sync the admin
 * payment_verification table.
 *
 * Safe to call any number of times for the same payment (verify, re-check and
 * webhook may all race): the registration upsert is keyed on (event_id,
 * user_id) and emails are only sent when this call created the link.
 */
async function issueEventTicket({ payment, event }) {
  const userId = payment.user_id || null;
  const isGuest = !userId && !!payment.guest_email;
  if (!userId && !isGuest) throw new Error('Cannot issue a ticket for a payment with no owner');

  // Idempotency: one registration per order (UNIQUE linked_payment_id).
  const findOrderReg = async () => {
    const { data, error } = await supabase
      .from('event_registrations')
      .select('*')
      .eq('linked_payment_id', payment.id)
      .limit(1);
    if (error) throw error;
    return Array.isArray(data) && data.length ? data[0] : null;
  };

  const existingOrderReg = await findOrderReg();
  if (existingOrderReg) {
    return {
      registration: existingOrderReg,
      ticketNumber: existingOrderReg.ticket_number || ticketNumberFor(event.id, payment.id),
      newlyIssued: false
    };
  }

  // Game orders (pay per play) can always be repeated: play once, buy again.
  const gameLines = await describeGameOrder(payment);

  // Without "Allow repeat purchases", a member keeps a single paid order per
  // event: a second payment is logged as a refund case instead of a ticket.
  if (userId && !event.allow_repeat_orders && !gameLines) {
    const { data: priorPaid, error: priorErr } = await supabase
      .from('event_registrations')
      .select('*')
      .eq('event_id', event.id)
      .eq('user_id', userId)
      .not('linked_payment_id', 'is', null)
      .limit(1);
    if (priorErr) throw priorErr;
    const prior = Array.isArray(priorPaid) && priorPaid.length ? priorPaid[0] : null;
    if (prior) {
      console.warn(`[payments] Duplicate payment ${payment.id} for user ${userId} on event ${event.id}; repeat purchases are off, existing ticket kept (refund candidate).`);
      return {
        registration: prior,
        ticketNumber: prior.ticket_number || ticketNumberFor(event.id, prior.linked_payment_id),
        newlyIssued: false
      };
    }
  }

  const { data: registration, error: regErr } = await supabase
    .from('event_registrations')
    .insert([{
      event_id: event.id,
      user_id: userId,
      guest_name: isGuest ? payment.guest_name : null,
      guest_email: isGuest ? payment.guest_email : null,
      guest_phone: isGuest ? payment.guest_phone : null,
      registration_date: new Date().toISOString(),
      status: 'registered',
      linked_payment_id: payment.id,
      ticket_quantity: quantityOf(payment),
      ...(gameLines ? gameColumns(gameLines) : {})
    }])
    .select()
    .single();

  if (regErr) {
    // Another request (verify / re-check / webhook) issued this order first.
    if (regErr.code === '23505') {
      const raced = await findOrderReg();
      if (raced) {
        return { registration: raced, ticketNumber: ticketNumberFor(event.id, payment.id), newlyIssued: false };
      }
    }
    throw regErr;
  }

  const ticketNumber = registration?.ticket_number || ticketNumberFor(event.id, payment.id);

  await syncAttendeeCount(event.id);

  // Tickets and admin emails name the games, e.g. "Game Night: FIFA × 2, Ludo × 1".
  const emailEvent = gameLines ? { ...event, title: titleWithGames(event, gameLines) } : event;

  // Notifications are awaited (bounded) so a serverless platform cannot freeze
  // the function before they are sent, but a slow mail provider can't block
  // the buyer's confirmation for long either.
  await withTimeout((async () => {
    try {
      let recipient;
      if (isGuest) {
        recipient = { name: payment.guest_name || 'Guest', email: payment.guest_email, is_guest: true };
      } else {
        const { data: student } = await supabase.from('students').select('*').eq('user_id', userId).maybeSingle();
        recipient = student;
      }
      if (recipient && recipient.email) {
        await sendEventTicketEmail({ student: recipient, event: emailEvent, ticketNumber, payment, games: gameLines });
      }
      await sendPaymentAdminNotificationEmail({
        student: recipient || { name: 'Student', email: '' },
        event: emailEvent,
        payment,
        ticketNumber,
        games: gameLines
      });
      if (!isGuest) {
        try {
          await supabase.from('payment_verification').insert([{
            student_id: recipient?.id || null,
            event_id: event.id,
            amount: payment.amount,
            payment_reference: payment.transaction_id,
            status: 'verified',
            created_at: new Date().toISOString()
          }]);
        } catch (pvErr) {
          console.warn('payment_verification sync notice:', pvErr?.message || pvErr);
        }
      }
    } catch (notifyErr) {
      console.error('Ticket/Admin email dispatch error:', notifyErr);
    }
  })(), 8000, 'ticket notifications');

  return { registration, ticketNumber, newlyIssued: true };
}

// ============================================
// CREATE BACHS CHECKOUT SESSION
// ============================================
router.post('/bachs-session', authenticate, async (req, res) => {
  try {
    // SECURITY: the client-supplied `amount` is ignored. The price always
    // comes from the event record so a tampered request cannot pay less.
    const { event_id } = req.body;
    if (!event_id) {
      return errorResponse(res, 'event_id is required to start a checkout session', 400);
    }

    const picked = parseGameLines(req.body, req.body.quantity);
    if (picked.error) return errorResponse(res, picked.error, 400);
    let quantity = picked.lines ? null : parseTicketQuantity(req.body.quantity);
    if (!picked.lines && !quantity) {
      return errorResponse(res, `You can buy between 1 and ${MAX_TICKETS_PER_ORDER} tickets per order.`, 400);
    }

    const payable = await loadPayableEvent(event_id, { lines: picked.lines });
    if (payable.error) {
      return errorResponse(res, payable.error, payable.status);
    }
    const game = payable.game || null;
    if (game) quantity = game.quantity;
    const unitPrice = game ? null : payable.price;
    const feeSettings = await getFeeSettings();
    const feePerTicket = serviceFeePerTicket(payable.event, feeSettings, { guest: false });
    const breakdown = game
      ? gameBreakdown(game, feePerTicket)
      : orderBreakdown({ unitPrice, quantity, feePerTicket });
    const price = breakdown.total_amount; // tickets + service fee (Bachs adds its own fee on top)
    // Never open a checkout for nothing (or less), whatever the request said.
    if (!(Number.isFinite(price) && price > 0) || !(breakdown.quantity > 0)) {
      return errorResponse(res, 'This order could not be priced. Please choose your tickets again.', 400);
    }

    // One order per student per event unless the admin has switched on
    // "Allow repeat purchases" for this event. Games are always pay-per-play.
    if (!payable.event.allow_repeat_orders && !game) {
      const { data: existingRegs, error: existingRegErr } = await supabase
        .from('event_registrations')
        .select('id, ticket_quantity')
        .eq('event_id', payable.event.id)
        .eq('user_id', req.userId);
      if (existingRegErr) throw existingRegErr;
      if (Array.isArray(existingRegs) && existingRegs.length) {
        const held = existingRegs.reduce((sum, r) => sum + quantityOf(r), 0);
        return errorResponse(res, `You already have ${held} ticket(s) for this event.`, 409);
      }
    }

    const remaining = await seatsRemaining(payable.event);
    if (quantity > remaining) {
      return errorResponse(res, remaining === 0
        ? 'This event is fully booked.'
        : `Only ${remaining} ticket(s) left for this event.`, 409);
    }
    const capErr = await gameCapacityError(game);
    if (capErr) return errorResponse(res, capErr, 409);

    const bachsSecret = process.env.BACHS_SECRET_KEY;

    if (!isBachsKeyConfigured(bachsSecret)) {
      if (!isPaymentSimulationAllowed()) {
        console.error('[Bachs] BACHS_SECRET_KEY is missing/placeholder and simulation is not allowed.');
        return errorResponse(res, 'Payment gateway configuration error. Please contact administrator.', 503);
      }
      console.warn('[Bachs] BACHS_SECRET_KEY not configured; returning local simulation session.');
      return simulationSession(res, price, event_id, 'BACHS_SECRET_KEY is not configured (local simulation mode).');
    }

    // Format amount with 2 decimal places as required by Bachs pricing schema
    const formattedAmount = price.toFixed(2);
    const ticketLabel = orderLabel(game, quantity);

    // Call Bachs API to create a session with documented pricing source
    const payload = {
      pricing: {
        amount: formattedAmount,
        currency: 'NGN'
      },
      customer: {
        email: req.user?.email || 'student@tau.edu.ng',
        name: req.user?.name || 'Student'
      },
      success_url: `${process.env.FRONTEND_URL || 'https://nacosportal.vercel.app'}/events.html?payment=success&event_id=${encodeURIComponent(event_id)}`,
      cancel_url: `${process.env.FRONTEND_URL || 'https://nacosportal.vercel.app'}/events.html?payment=cancelled`,
      // Bachs adds its processing fee on top for the buyer, so NACOS receives the full amount.
      ...(feeSettings.customer_bears_gateway_fee ? { customer_bears_fee: true } : {})
    };

    // Automatically determine base URL
    const isLive = bachsSecret.startsWith('sk_live_');
    const baseUrl = isLive ? 'https://api.bachs.io' : 'https://sandbox-api.bachs.io';
    const targetUrl = `${baseUrl}/v1/checkout-sessions`;

    let bachsRes = null;
    let data = null;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 7500);

      const res = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${bachsSecret}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      bachsRes = res;
      data = await res.json().catch(() => null);
    } catch (fetchErr) {
      console.error('[Bachs] Fetch error connecting to Bachs gateway:', fetchErr.message);
    }

    if (!bachsRes || !bachsRes.ok) {
      const errDetail = data?.detail || data?.message || data?.error_code || 'Unable to establish session with Bachs';
      const status = bachsRes ? bachsRes.status : 504;
      console.error('Bachs session error:', status, data);
      if (isPaymentSimulationAllowed()) {
        return simulationSession(res, price, event_id, `Bachs API error (${status}): ${errDetail}`);
      }
      return errorResponse(res, 'The payment gateway is temporarily unavailable. Please try again shortly.', 502);
    }

    const checkoutId = data.id || data.checkout_id || data.session_id;

    // Record the checkout server-side so the payment can always be recovered
    // (webhook, re-check button) even if the student's tab/session is lost
    // during the gateway redirect. Non-fatal: checkout still proceeds if this fails.
    let paymentId = null;
    if (checkoutId) {
      const { data: intent, error: intentErr } = await supabase
        .from('payments')
        .insert([{
          user_id: req.userId,
          event_id: payable.event.id,
          amount: price,
          subtotal_amount: breakdown.subtotal_amount,
          service_fee: breakdown.service_fee,
          ticket_quantity: quantity,
          ...(game ? gameColumns(game.lines) : {}),
          payment_type: 'event_registration',
          transaction_id: String(checkoutId),
          payment_proof_url: receiptUrlFor(String(checkoutId)),
          description: `Online payment for event: ${payable.event.title} (${ticketLabel})`,
          status: 'pending',
          submitted_at: new Date().toISOString(),
          notes: `${ONLINE_CHECKOUT_MARKER} Checkout started; awaiting gateway confirmation.`
        }])
        .select('id')
        .maybeSingle();
      if (intentErr) {
        console.error('[Bachs] Could not record checkout intent:', intentErr.message);
      } else {
        paymentId = intent?.id || null;
      }
    }

    return successResponse(res, {
      checkout_url: data.checkout_url || data.url,
      checkout_id: checkoutId,
      payment_id: paymentId,
      quantity,
      ...(game ? { games: publicGames(game.lines) } : {}),
      ...breakdown,
      gateway_fee_added_at_checkout: !!feeSettings.customer_bears_gateway_fee
    }, 'Session created successfully');
  } catch (error) {
    console.error('Bachs checkout session error:', error);
    return errorResponse(res, 'Internal server error while creating checkout session', 500);
  }
});

// ============================================
// SUBMIT PAYMENT (Student)
// ============================================
const VALID_PAYMENT_TYPES = ['association_fee', 'event_registration', 'other'];

router.post('/submit', authenticate, async (req, res) => {
  try {
    const {
      amount,
      payment_type,
      transaction_id,
      payment_proof_url,
      description,
      event_id,
      ticket_quantity
    } = req.body;

    if (!amount || !payment_type || !payment_proof_url) {
      return errorResponse(res, 'Amount, payment type, and proof are required', 400);
    }

    // Amount: finite, positive, sane upper bound, max 2 decimal places.
    const parsedAmount = Number(amount);
    if (!Number.isFinite(parsedAmount) || parsedAmount <= 0 || parsedAmount > 10000000) {
      return errorResponse(res, 'Amount must be a positive number.', 400);
    }
    if (Math.round(parsedAmount * 100) !== parsedAmount * 100 && Math.abs(Math.round(parsedAmount * 100) - parsedAmount * 100) > 1e-6) {
      return errorResponse(res, 'Amount can have at most 2 decimal places.', 400);
    }

    // Proof URL: must be https and hosted on our Supabase project. This field is
    // exempt from global HTML escaping, so it must be strictly validated here.
    let proofUrl;
    try {
      proofUrl = new URL(String(payment_proof_url));
    } catch {
      return errorResponse(res, 'payment_proof_url must be a valid URL.', 400);
    }
    const allowedHost = process.env.SUPABASE_URL ? new URL(process.env.SUPABASE_URL).host : null;
    if (proofUrl.protocol !== 'https:' || (allowedHost && proofUrl.host !== allowedHost)) {
      return errorResponse(res, 'Payment proof must be uploaded through the portal.', 400);
    }

    const cleanTransactionId = typeof transaction_id === 'string' ? transaction_id.trim().slice(0, 64) : '';
    if (description !== undefined && description !== null && (typeof description !== 'string' || description.length > 500)) {
      return errorResponse(res, 'Description must be text up to 500 characters.', 400);
    }

    if (!VALID_PAYMENT_TYPES.includes(payment_type)) {
      return errorResponse(res, `Invalid payment_type. Use one of: ${VALID_PAYMENT_TYPES.join(', ')}`, 400);
    }

    // Event registration payments MUST be linked to a specific event.
    if (payment_type === 'event_registration' && !event_id) {
      return errorResponse(res, 'event_id is required for event_registration payments.', 400);
    }

    const quantity = payment_type === 'event_registration' ? parseTicketQuantity(ticket_quantity) : 1;
    if (!quantity) {
      return errorResponse(res, `You can buy between 1 and ${MAX_TICKETS_PER_ORDER} tickets per order.`, 400);
    }

    // If event_id is provided, confirm the target event actually exists and validate price.
    let resolvedEventId = null;
    if (event_id) {
      const { data: targetEvent, error: evErr } = await supabase
        .from('events')
        .select('id, title, requires_payment, payment_amount')
        .eq('id', event_id)
        .maybeSingle();

      if (evErr) throw evErr;
      if (!targetEvent) {
        return errorResponse(res, `Event ${event_id} does not exist.`, 400);
      }
      resolvedEventId = targetEvent.id;

      // Medium Finding #3: Validate submitted amount against event payment_amount
      // (Previously checked a non-existent `is_paid` column, so this never ran.)
      if (Number(targetEvent.payment_amount) > 0) {
        const requiredAmount = orderTotal(targetEvent.payment_amount, quantity);
        if (parsedAmount < requiredAmount) {
          return errorResponse(res, `Submitted amount (₦${parsedAmount}) is less than the required total (₦${requiredAmount} for ${quantity} ticket${quantity > 1 ? 's' : ''}) for "${targetEvent.title}".`, 400);
        }
      }
    }

    const { data, error } = await supabase
      .from('payments')
      .insert([{
        user_id: req.userId,
        amount: parsedAmount,
        ticket_quantity: quantity,
        payment_type,
        transaction_id: cleanTransactionId || generateTransactionId(),
        payment_proof_url,
        description,
        event_id: resolvedEventId,
        status: 'pending',
        submitted_at: new Date().toISOString()
      }])
      .select()
      .single();

    if (error) throw error;

    await auditLog({
      action: 'payment_submitted',
      userId: req.userId,
      details: { 
        payment_id: data.id,
        amount: data.amount,
        type: data.payment_type,
        event_id: data.event_id || null
      },
      ip: req.ip
    });

    return successResponse(res, { payment: data }, 'Payment submitted for verification', 201);

  } catch (error) {
    console.error('Payment submission error:', error);
    return errorResponse(res, 'Failed to submit payment', 500, error);
  }
});

// ============================================
// GET PAYSTACK CONFIG (Public Key)
// ============================================
router.get('/paystack/config', (req, res) => {
  return successResponse(res, {
    publicKey: process.env.PAYSTACK_PUBLIC_KEY || ''
  }, 'Paystack configuration');
});

// ============================================
// GET PAYMENT RECEIPT / STATUS BY REFERENCE
// ============================================
// Unauthenticated callers receive a public-safe subset (ticket status + event
// info only — no student PII). Authenticated callers who own the payment
// receive the full receipt including student details.
router.get('/receipt/:reference', async (req, res) => {
  try {
    const { reference } = req.params;
    if (!reference) {
      return errorResponse(res, 'Reference is required', 400);
    }

    const { data: payment, error } = await supabase
      .from('payments')
      .select('*')
      .eq('transaction_id', reference)
      .maybeSingle();

    if (error) throw error;
    if (!payment) {
      return errorResponse(res, 'Payment receipt not found', 404);
    }

    // Resolve caller identity from Authorization header (optional — no 401 on failure)
    let callerId = null;
    try {
      const authHeader = req.headers.authorization;
      if (authHeader && authHeader.toLowerCase().startsWith('bearer ')) {
        const token = authHeader.slice(7).trim();
        if (token) {
          const { data: userData } = await supabase.auth.getUser(token);
          callerId = userData?.user?.id || null;
        }
      }
    } catch (_) { /* non-fatal — treat as unauthenticated */ }

    const isOwner = callerId && callerId === payment.user_id;

    // Fetch event info (public — no PII)
    let event = null;
    let registration = null;
    if (payment.event_id) {
      const [evResult, regResult] = await Promise.all([
        supabase.from('events').select('id, title, date, time, location, image_url').eq('id', payment.event_id).maybeSingle(),
        supabase.from('event_registrations').select('*').eq('linked_payment_id', payment.id).maybeSingle()
      ]);
      event = evResult.data || null;
      registration = regResult.data || null;
    }
    const receiptGames = await describeGameOrder(payment);
    if (event && receiptGames) event = { ...event, title: titleWithGames(event, receiptGames) };

    // Game tickets: plays used so far (marked by game marshals) and when.
    let receiptGamesView = publicGames(receiptGames);
    if (receiptGamesView && registration) {
      const { data: usedRows, error: usedErr } = await supabase
        .from('game_plays')
        .select('item_id, plays, created_at')
        .eq('registration_id', registration.id)
        .order('created_at', { ascending: true });
      if (usedErr) console.warn('[receipt] could not load plays used:', usedErr.message);
      const used = usedErr ? [] : (usedRows || []);
      receiptGamesView = receiptGamesView.map(g => {
        const mine = used.filter(u => u.item_id === g.id);
        const usedPlays = mine.reduce((sum, u) => sum + (u.plays || 0), 0);
        return {
          ...g,
          used: usedPlays,
          left: Math.max(0, g.plays - usedPlays),
          used_at: mine.flatMap(u => Array(Math.max(1, u.plays || 1)).fill(u.created_at))
        };
      });
    }

    const ticketNumber = registration?.ticket_number ||
      ('NACOS-' + (payment.event_id ? payment.event_id.substring(0, 4).toUpperCase() : 'PAY') +
       '-' + payment.id.substring(0, 6).toUpperCase());

    // Public-safe payload: ticket status and event info only — no student PII
    const ticketQuantity = quantityOf(registration || payment);
    const publicPayload = {
      ticket_number: ticketNumber,
      ticket_quantity: ticketQuantity,
      games: receiptGamesView,
      unit_price: money(Number(payment.subtotal_amount ?? payment.amount) / ticketQuantity),
      subtotal_amount: Number(payment.subtotal_amount ?? payment.amount),
      service_fee: Number(payment.service_fee || 0),
      gateway_fee: payment.gateway_fee != null ? Number(payment.gateway_fee) : null,
      status: payment.status,
      payment_type: payment.payment_type,
      amount: payment.amount,
      verified_at: payment.verified_at,
      submitted_at: payment.submitted_at,
      event,
      // Ticket status only: no buyer name, email, phone or account id, since
      // anyone holding the receipt link can open this.
      registration: registration ? {
        status: registration.status,
        ticket_quantity: registration.ticket_quantity,
        registration_date: registration.registration_date
      } : null
    };

    // Owners additionally receive their own student details
    if (isOwner) {
      const { data: student } = await supabase
        .from('students')
        .select('name, email, matric_no, department')
        .eq('user_id', payment.user_id)
        .maybeSingle();

      return successResponse(res, {
        ...publicPayload,
        payment,   // full payment row for the owner
        student    // PII only for the owner
      }, 'Receipt retrieved successfully');
    }

    return successResponse(res, publicPayload, 'Receipt retrieved successfully');

  } catch (error) {
    console.error('Receipt lookup error:', error);
    return errorResponse(res, 'Failed to fetch receipt', 500, error);
  }
});

// ============================================
// VERIFY PAYSTACK PAYMENT (Student instant verification)
// ============================================
/**
 * Ask the payment gateway whether `reference` is paid, for at least
 * `expectedAmount` NGN, and (when both are known) by `expectedEmail`.
 *
 * Returns { ok: true, data } or { ok: false, status, error }. Never treats an
 * unconfirmed reference as paid unless local simulation is explicitly enabled.
 */
async function checkGatewayPayment({ reference, expectedAmount, expectedEmail, logContext = '' }) {
  const simulated = (channel) => ({
    ok: true,
    data: {
      status: 'success',
      amount: Math.round(expectedAmount * 100),
      currency: 'NGN',
      channel,
      reference,
      paid_at: new Date().toISOString()
    }
  });

  const bachsSecret = process.env.BACHS_SECRET_KEY;
  if (!isBachsKeyConfigured(bachsSecret)) {
    if (!isPaymentSimulationAllowed()) {
      console.error('[Bachs] BACHS_SECRET_KEY missing and simulation not allowed; refusing verification.');
      return { ok: false, status: 503, error: 'Payment gateway configuration error. Please contact administrator.' };
    }
    console.warn(`[Bachs] BACHS_SECRET_KEY not set. Local simulation accepting reference "${reference}".`);
    return simulated('card (local simulation)');
  }

  const isLive = bachsSecret.startsWith('sk_live_');
  const baseUrl = isLive ? 'https://api.bachs.io' : 'https://sandbox-api.bachs.io';
  const candidateGetUrls = [
    `${baseUrl}/v1/checkout-sessions/${encodeURIComponent(reference)}`,
    `${baseUrl}/v1/checkout/sessions/${encodeURIComponent(reference)}`,
    `${baseUrl}/v1/payments/${encodeURIComponent(reference)}`
  ];

  try {
    let verifyRes = null;
    let verifyData = null;

    for (const testUrl of candidateGetUrls) {
      try {
        const resp = await fetch(testUrl, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${bachsSecret}`,
            'Content-Type': 'application/json'
          }
        });
        const j = await resp.json().catch(() => null);
        if (resp.status !== 404 && j) {
          verifyRes = resp;
          verifyData = j;
          break;
        }
      } catch (fetchErr) {
        console.warn(`[Bachs] Error testing ${testUrl}:`, fetchErr.message);
      }
    }

    const sessionObj = verifyData?.data || verifyData || {};
    const sessionStatus = describeGatewayStatus(sessionObj);
    const isPaidOrCompleted = isGatewayPaid(sessionObj);
    // IDs/status only (no customer data) so failed confirmations can be diagnosed from the logs.
    console.log(`[Bachs] verify ${reference}: http=${verifyRes ? verifyRes.status : 'none'} status=${sessionStatus || 'none'} paid=${isPaidOrCompleted} ids=${gatewayIdsOf(sessionObj).join(',')}`);

    if (!verifyRes || !verifyRes.ok || !isPaidOrCompleted) {
      if (isPaymentSimulationAllowed()) {
        console.warn(`[Bachs] Local simulation: accepting unverified reference "${reference}"`);
        return simulated('card (local simulation)');
      }
      const reason = verifyData?.message || verifyData?.detail || `Session status is "${sessionStatus || 'unknown'}" (expected completed/paid)`;
      return { ok: false, status: 400, error: `Payment could not be verified: ${reason}` };
    }

    // The gateway must report the amount; never fall back to the event price.
    const rawAmount = sessionObj.pricing?.amount ?? sessionObj.amount;
    const gatewayNaira = parseFloat(rawAmount);
    const currency = String(sessionObj.pricing?.currency || sessionObj.currency || 'NGN').toUpperCase();

    if (!Number.isFinite(gatewayNaira)) {
      console.error('[Bachs] Verified session has no readable amount:', reference);
      return { ok: false, status: 400, error: 'Payment could not be verified: amount missing from gateway response.' };
    }
    if (currency !== 'NGN') {
      return { ok: false, status: 400, error: `Payment could not be verified: unexpected currency ${currency}.` };
    }
    // 1 kobo rounding tolerance
    if (gatewayNaira + 0.01 < expectedAmount) {
      console.warn(`[Bachs] Amount mismatch for ${reference}: paid ${gatewayNaira}, expected ${expectedAmount} (${logContext})`);
      return { ok: false, status: 400, error: `Amount paid (₦${gatewayNaira}) is less than the order total (₦${expectedAmount}).` };
    }

    // Bind the checkout to the payer when the gateway reports a customer email.
    const customerEmail = String(sessionObj.customer?.email || sessionObj.customer_email || '').trim().toLowerCase();
    const wanted = String(expectedEmail || '').trim().toLowerCase();
    if (customerEmail && wanted && customerEmail !== wanted) {
      return { ok: false, status: 403, error: 'This payment was made from a different account.' };
    }

    return {
      ok: true,
      data: {
        status: 'success',
        amount: Math.round(gatewayNaira * 100),
        currency,
        channel: sessionObj.mode || sessionObj.channel || 'online checkout',
        reference: sessionObj.id || sessionObj.checkout_id || sessionObj.reference || reference,
        paid_at: sessionObj.completed_at || sessionObj.paid_at || new Date().toISOString(),
        // Bachs processing fee, if reported (naira), and who paid it
        gateway_fee: gatewayFeeOf(sessionObj),
        gateway_fee_paid_by: gatewayFeePaidByOf(sessionObj)
      }
    };
  } catch (err) {
    console.error('Bachs verify fetch error:', err);
    return { ok: false, status: 500, error: 'Internal server error during payment verification' };
  }
}

/**
 * Verify `reference` with the gateway and, if it is paid in full, record the
 * payment and issue the event ticket. Shared by /verify-paystack (redirect
 * return) and /:id/recheck (student-initiated recovery). Idempotent.
 */
async function verifyAndSettle(req, res, { reference, event_id, quantity: requestedQuantity, item_id: requestedItemId, items: requestedItems }) {
  try {
    // This endpoint only settles event tickets; the price must come from an event.
    const payment_type = 'event_registration';

    if (!reference || typeof reference !== 'string' || reference.length > 200) {
      return errorResponse(res, 'A valid payment reference is required', 400);
    }

    if (!event_id) {
      return errorResponse(res, 'event_id is required for event registration payments', 400);
    }

    // 1. The order recorded when checkout started (if any)
    const { data: existingPayment, error: existingPayErr } = await supabase
      .from('payments')
      .select('*')
      .eq('transaction_id', reference)
      .maybeSingle();

    if (existingPayErr) throw existingPayErr;

    // 2. Fetch event details and its authoritative price (Naira). For game
    //    events the games recorded on the order win over what the browser sends.
    const recordedLines = existingPayment && existingPayment.event_id === event_id ? linesFromRow(existingPayment) : null;
    let lines = recordedLines;
    if (!lines) {
      const picked = parseGameLines({ items: requestedItems, item_id: requestedItemId }, requestedQuantity);
      if (picked.error) return errorResponse(res, picked.error, 400);
      lines = picked.lines;
    }
    const payable = await loadPayableEvent(event_id, { lines, settling: true });
    if (payable.error) {
      return errorResponse(res, payable.error, payable.status);
    }
    const targetEvent = payable.event;
    const unitPrice = payable.price;
    const game = payable.game || null;

    // Prevent replay: a reference belongs to exactly one user AND one event

    if (existingPayment && existingPayment.user_id && existingPayment.user_id !== req.userId) {
      return errorResponse(res, 'This payment reference is already associated with another account.', 403);
    }

    if (existingPayment && existingPayment.guest_email) {
      return errorResponse(res, 'This is a guest order. Use the guest ticket lookup with the email used at checkout.', 403);
    }

    if (existingPayment && existingPayment.event_id && existingPayment.event_id !== targetEvent.id) {
      return errorResponse(res, 'This payment reference has already been used for a different event.', 409);
    }

    if (existingPayment && !existingPayment.event_id) {
      // A webhook-created row has no event yet. Only claim it if no registration already uses it.
      const { data: linkedReg, error: linkedErr } = await supabase
        .from('event_registrations')
        .select('id, event_id')
        .eq('linked_payment_id', existingPayment.id)
        .maybeSingle();
      if (linkedErr) throw linkedErr;
      if (linkedReg && linkedReg.event_id !== targetEvent.id) {
        return errorResponse(res, 'This payment reference has already been used for a different event.', 409);
      }
    }

    // Ticket quantity: the server-recorded checkout is authoritative. Without
    // one (legacy / failed intent insert) the requested quantity is used, and
    // the gateway amount check below guarantees it was paid for in full.
    let quantity;
    if (existingPayment && existingPayment.event_id === targetEvent.id && existingPayment.ticket_quantity) {
      quantity = quantityOf(existingPayment);
    } else if (game) {
      quantity = game.quantity;
    } else {
      quantity = parseTicketQuantity(requestedQuantity);
      if (!quantity) {
        return errorResponse(res, `You can buy between 1 and ${MAX_TICKETS_PER_ORDER} tickets per order.`, 400);
      }
    }
    // A checkout recorded by the server is held to the total (tickets + service
    // fee) quoted when it started, so a later price or fee change can't break a
    // paid order. Without one, price it now with the current fee settings.
    const fromRecordedCheckout = !!(existingPayment && isOnlineCheckoutRow(existingPayment) &&
      (existingPayment.status === 'pending' || existingPayment.status === 'abandoned') && Number(existingPayment.amount) > 0);
    const feeSettings = await getFeeSettings();
    const priced = fromRecordedCheckout
      ? {
          total_amount: money(existingPayment.amount),
          subtotal_amount: money(existingPayment.subtotal_amount ?? existingPayment.amount),
          service_fee: money(existingPayment.service_fee || 0)
        }
      : game
        ? gameBreakdown(game, serviceFeePerTicket(targetEvent, feeSettings, { guest: false }))
        : orderBreakdown({ unitPrice, quantity, feePerTicket: serviceFeePerTicket(targetEvent, feeSettings, { guest: false }) });
    const expectedAmount = priced.total_amount;

    // Capacity check (skipped when this order already has its tickets, e.g. a retried verification)
    let alreadyIssued = false;
    if (existingPayment) {
      const { data: orderReg } = await supabase
        .from('event_registrations')
        .select('id')
        .eq('linked_payment_id', existingPayment.id)
        .limit(1);
      alreadyIssued = Array.isArray(orderReg) && orderReg.length > 0;
    }

    if (!alreadyIssued) {
      const remaining = await seatsRemaining(targetEvent);
      if (quantity > remaining) {
        return errorResponse(res, remaining === 0
          ? `Event is fully booked (${targetEvent.max_attendees} tickets issued).`
          : `Only ${remaining} ticket(s) left for this event.`, 409);
      }
      const capErr = await gameCapacityError(game);
      if (capErr) return errorResponse(res, capErr, 409);
    }

    // 3. Confirm with the gateway (amount, currency, payer)
    const gw = await checkGatewayPayment({
      reference,
      expectedAmount,
      expectedEmail: req.user?.email,
      logContext: `event ${targetEvent.id}, user ${req.userId}`
    });
    if (!gw.ok) {
      return errorResponse(res, gw.error, gw.status);
    }
    const verifiedPaymentData = gw.data;

    // Store our breakdown (tickets + service fee). The gateway's figure may
    // include the Bachs fee the buyer paid on top, which is recorded separately.
    const paidAmount = priced.total_amount;
    const feeColumns = {
      subtotal_amount: priced.subtotal_amount,
      service_fee: priced.service_fee,
      ...(verifiedPaymentData.gateway_fee != null ? { gateway_fee: verifiedPaymentData.gateway_fee } : {}),
      ...(verifiedPaymentData.gateway_fee_paid_by ? { gateway_fee_paid_by: verifiedPaymentData.gateway_fee_paid_by } : {})
    };

    // 4. Save/update payment record in database
    let paymentRecord = existingPayment;

    if (!paymentRecord) {
      const { data: newPayment, error: createPayErr } = await supabase
        .from('payments')
        .insert([{
          user_id: req.userId,
          amount: paidAmount,
          ...feeColumns,
          ticket_quantity: quantity,
          ...(game ? gameColumns(game.lines) : {}),
          payment_type: payment_type,
          transaction_id: reference,
          payment_proof_url: receiptUrlFor(reference),
          description: `Online payment for event: ${targetEvent.title} (${orderLabel(game, quantity)})`,
          event_id: targetEvent ? targetEvent.id : null,
          status: 'verified',
          verified_by: req.userId,
          verified_at: new Date().toISOString(),
          submitted_at: new Date().toISOString(),
          notes: `Verified via Bachs (${verifiedPaymentData.channel || 'online checkout'})`
        }])
        .select()
        .single();

      if (createPayErr) throw createPayErr;
      paymentRecord = newPayment;
    } else if (paymentRecord.status !== 'verified' || !paymentRecord.event_id || !paymentRecord.user_id) {
      // Claim the row for this user + event. The filter makes the claim atomic:
      // if a concurrent request already bound it to another event/user, no row matches.
      const updates = {
        event_id: targetEvent.id,
        user_id: req.userId,
        payment_type,
        ticket_quantity: quantity,
        ...(game ? gameColumns(game.lines) : {})
      };
      if (paymentRecord.status !== 'verified') {
        Object.assign(updates, {
          amount: paidAmount,
          ...feeColumns,
          status: 'verified',
          verified_by: req.userId,
          verified_at: new Date().toISOString(),
          notes: `Verified via Bachs (${verifiedPaymentData.channel || 'online checkout'})`
        });
      }

      const { data: updatedPayment, error: updatePayErr } = await supabase
        .from('payments')
        .update(updates)
        .eq('id', paymentRecord.id)
        .or(`event_id.is.null,event_id.eq.${targetEvent.id}`)
        .or(`user_id.is.null,user_id.eq.${req.userId}`)
        .select()
        .maybeSingle();

      if (updatePayErr) throw updatePayErr;
      if (!updatedPayment) {
        return errorResponse(res, 'This payment reference has already been used for a different event.', 409);
      }
      paymentRecord = updatedPayment;
    }

    // 5. Register student and issue the ticket (idempotent; emails only on first issue)
    const { registration: registrationRecord, ticketNumber, newlyIssued } =
      await issueEventTicket({ payment: paymentRecord, event: targetEvent });

    // 6. Audit log (first settlement only, so retries/re-checks don't spam the trail)
    if (newlyIssued) {
      await auditLog({
        action: 'bachs_payment_verified',
        userId: req.userId,
        details: {
          payment_id: paymentRecord.id,
          amount: paidAmount,
          reference: reference,
          event_id: targetEvent.id,
          ticket_number: ticketNumber,
          ticket_quantity: quantityOf(paymentRecord)
        },
        ip: req.ip
      });
    }

    return successResponse(res, {
      payment: paymentRecord,
      registration: registrationRecord,
      ticket_number: ticketNumber,
      ticket_quantity: quantityOf(registrationRecord || paymentRecord),
      unit_price: unitPrice,
      total_amount: Number(paymentRecord.amount),
      subtotal_amount: Number(paymentRecord.subtotal_amount ?? paymentRecord.amount),
      service_fee: Number(paymentRecord.service_fee || 0),
      gateway_fee: paymentRecord.gateway_fee != null ? Number(paymentRecord.gateway_fee) : null,
      games: game ? publicGames(game.lines) : null,
      event: targetEvent ? {
        id: targetEvent.id,
        title: titleWithGames(targetEvent, game ? game.lines : null),
        date: targetEvent.date,
        time: targetEvent.time,
        location: targetEvent.location,
        payment_amount: targetEvent.payment_amount
      } : null
    }, 'Payment successfully verified and registration confirmed!', 200);

  } catch (error) {
    console.error('Payment verification error:', error);
    return errorResponse(res, 'Failed to verify payment. Please try again.', 500, error);
  }
}

// Student returns from the gateway (redirect / inline success callback)
router.post('/verify-paystack', authenticate, (req, res) =>
  verifyAndSettle(req, res, { reference: req.body?.reference, event_id: req.body?.event_id, quantity: req.body?.quantity, item_id: req.body?.item_id, items: req.body?.items })
);

// ============================================
// RE-CHECK AN ONLINE PAYMENT (Student self-service recovery)
// ============================================
// For a checkout the student started (e.g. paid, then lost signal during the
// redirect). Re-queries the gateway using the server-recorded reference and
// event, so nothing has to survive in the browser.
router.post('/:id/recheck', authenticate, async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) {
      return errorResponse(res, 'Invalid payment id', 400);
    }

    const { data: payment, error } = await supabase
      .from('payments')
      .select('id, user_id, event_id, transaction_id, status, notes')
      .eq('id', id)
      .maybeSingle();
    if (error) throw error;

    // Same 404 for "not yours" and "missing" so ids can't be probed.
    if (!payment || payment.user_id !== req.userId) {
      return errorResponse(res, 'Payment not found', 404);
    }
    if (!payment.event_id || !payment.transaction_id) {
      return errorResponse(res, 'This payment cannot be re-checked online. Please contact an administrator.', 400);
    }
    if (payment.status === 'rejected') {
      return errorResponse(res, 'This payment was rejected. Please contact an administrator.', 409);
    }

    return verifyAndSettle(req, res, { reference: payment.transaction_id, event_id: payment.event_id });
  } catch (error) {
    console.error('Payment re-check error:', error);
    return errorResponse(res, 'Failed to re-check payment. Please try again.', 500, error);
  }
});

// ============================================
// GUEST (NON-MEMBER) CHECKOUT
// ============================================
// Non-members buy tickets without an account, at the event's guest price,
// only for events the admin has opened to the public. The ticket is emailed
// to the address they give; they recover it with reference + email.

const guestLimiter = registerLimiter('guest', (store) => rateLimit({
  windowMs: 15 * 60 * 1000,
  max: Math.max(1, parseInt(process.env.GUEST_CHECKOUT_RATE_LIMIT || '20', 10)),
  standardHeaders: true,
  legacyHeaders: false,
  message: { success: false, error: 'Too many guest checkout attempts. Please try again in a few minutes.' },
  validate: { trustProxy: false },
  store
}));

const GUEST_EMAIL_RE = /^[^\s@<>"']+@[^\s@<>"']+\.[A-Za-z]{2,}$/;
const MEMBER_EMAIL_RE = /@(st\.)?tau\.edu\.ng$/i;
const GUEST_PHONE_RE = /^\+?[0-9][0-9 ()-]{6,19}$/;

/** Validate and normalise guest buyer details. */
function parseGuestDetails(body = {}) {
  const name = typeof body.name === 'string' ? body.name.trim().replace(/\s+/g, ' ') : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  const phone = typeof body.phone === 'string' ? body.phone.trim() : '';
  if (name.length < 2 || name.length > 100) return { error: 'Please enter your full name (2–100 characters).' };
  if (!GUEST_EMAIL_RE.test(email) || email.length > 254) return { error: 'Please enter a valid email address. Your ticket will be sent there.' };
  if (!GUEST_PHONE_RE.test(phone)) return { error: 'Please enter a valid phone number.' };
  return { name, email, phone };
}

/** Members must buy through their account (member price, ticket on their profile). */
async function isMemberEmail(email) {
  if (MEMBER_EMAIL_RE.test(email)) return true;
  const { data } = await supabase.from('students').select('id').eq('email', email).limit(1);
  return Array.isArray(data) && data.length > 0;
}

const publicEventSummary = (ev) => ev ? {
  id: ev.id,
  title: ev.title,
  date: ev.date,
  time: ev.time,
  location: ev.location,
  public_price: ev.public_price
} : null;

/**
 * Confirm a server-recorded online order (member or guest) with the gateway,
 * using the checkout ID we saved when it started, then issue its tickets.
 * Idempotent: an already-verified order just returns its ticket.
 *
 * Returns { ok: true, settled, ticketNumber, newlyIssued } or { ok: false, status, error }.
 */
async function confirmOnlineOrder({ payment, event, source }) {
  const quantity = quantityOf(payment);
  let settled = payment;

  if (payment.status !== 'verified') {
    // Seats were checked at checkout; re-check only if this order has no tickets yet.
    const { data: orderReg } = await supabase.from('event_registrations').select('id').eq('linked_payment_id', payment.id).limit(1);
    if (!(Array.isArray(orderReg) && orderReg.length)) {
      const remaining = await seatsRemaining(event);
      if (quantity > remaining) {
        return { ok: false, status: 409, error: 'This event filled up before the payment was confirmed. Please contact the organisers for a refund.' };
      }
    }

    let expectedEmail = payment.guest_email || null;
    if (!expectedEmail && payment.user_id) {
      const { data: st } = await supabase.from('students').select('email').eq('user_id', payment.user_id).maybeSingle();
      expectedEmail = st?.email || null;
    }

    const gw = await checkGatewayPayment({
      reference: payment.transaction_id,
      expectedAmount: Number(payment.amount),
      expectedEmail,
      logContext: `${source}, order ${payment.id}`
    });
    if (!gw.ok) return { ok: false, status: gw.status, error: gw.error };

    const tag = payment.guest_email && !payment.user_id ? '[guest] ' : '';
    const { data: updated, error: updErr } = await supabase
      .from('payments')
      .update({
        // Keep the recorded breakdown (tickets + service fee); the Bachs fee the
        // buyer paid on top is stored separately when Bachs reports it.
        amount: money(payment.amount) > 0 ? money(payment.amount) : gw.data.amount / 100,
        subtotal_amount: payment.subtotal_amount ?? money(payment.amount),
        service_fee: money(payment.service_fee || 0),
        ...(gw.data.gateway_fee != null ? { gateway_fee: gw.data.gateway_fee } : {}),
        ...(gw.data.gateway_fee_paid_by ? { gateway_fee_paid_by: gw.data.gateway_fee_paid_by } : {}),
        status: 'verified',
        verified_at: new Date().toISOString(),
        notes: `${tag}Verified via Bachs ${source} (${gw.data.channel || 'online checkout'})`
      })
      .eq('id', payment.id)
      .neq('status', 'verified')
      .select()
      .maybeSingle();
    if (updErr) throw updErr;
    if (updated) {
      settled = updated;
    } else {
      const { data: fresh } = await supabase.from('payments').select('*').eq('id', payment.id).maybeSingle();
      settled = fresh || payment;
    }
  }

  const { ticketNumber, newlyIssued } = await issueEventTicket({ payment: settled, event });
  return { ok: true, settled, ticketNumber, newlyIssued };
}

// ============================================
// ADMIN: RE-CHECK AN ONLINE CHECKOUT WITH THE GATEWAY
// ============================================
// Online checkouts can't be approved by hand (an unpaid one looks the same as
// a paid one). This asks Bachs directly, using the checkout ID recorded when
// the checkout started, and issues the tickets if it is paid in full.
router.post('/:id/gateway-recheck', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    if (!/^[0-9a-f-]{36}$/i.test(id)) return errorResponse(res, 'Invalid payment id', 400);

    const { data: payment, error } = await supabase.from('payments').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    if (!payment) return errorResponse(res, 'Payment not found', 404);
    if (!payment.transaction_id || !payment.event_id) {
      return errorResponse(res, 'This payment has no gateway checkout to re-check.', 400);
    }
    if (payment.status === 'rejected') {
      return errorResponse(res, 'This payment was rejected.', 409);
    }

    const { data: event, error: evErr } = await supabase.from('events').select('*').eq('id', payment.event_id).maybeSingle();
    if (evErr) throw evErr;
    if (!event) return errorResponse(res, 'Linked event not found.', 404);

    const outcome = await confirmOnlineOrder({ payment, event, source: 'admin re-check' });
    if (!outcome.ok) return errorResponse(res, outcome.error, outcome.status);

    await auditLog({
      action: 'payment_gateway_rechecked',
      userId: req.userId,
      details: {
        payment_id: payment.id,
        reference: payment.transaction_id,
        ticket_number: outcome.ticketNumber,
        ticket_quantity: quantityOf(outcome.settled),
        newly_issued: outcome.newlyIssued
      },
      ip: req.ip
    });

    return successResponse(res, {
      payment: outcome.settled,
      ticket_number: outcome.ticketNumber,
      ticket_quantity: quantityOf(outcome.settled),
      newly_issued: outcome.newlyIssued
    }, outcome.newlyIssued
      ? 'Payment confirmed by the gateway. Ticket issued and emailed.'
      : 'Payment already confirmed. Ticket was issued earlier.');
  } catch (err) {
    console.error('Admin gateway re-check error:', err);
    return errorResponse(res, 'Could not re-check this payment. Please try again.', 500);
  }
});

router.post('/guest-session', guestLimiter, async (req, res) => {
  try {
    const { event_id } = req.body || {};
    if (!event_id) return errorResponse(res, 'event_id is required', 400);

    const picked = parseGameLines(req.body, req.body.quantity);
    if (picked.error) return errorResponse(res, picked.error, 400);
    let quantity = picked.lines ? null : parseTicketQuantity(req.body.quantity);
    if (!picked.lines && !quantity) {
      return errorResponse(res, `You can buy between 1 and ${MAX_TICKETS_PER_ORDER} tickets per order.`, 400);
    }

    const guest = parseGuestDetails(req.body);
    if (guest.error) return errorResponse(res, guest.error, 400);

    const payable = await loadPayableEvent(event_id, { guest: true, lines: picked.lines });
    if (payable.error) return errorResponse(res, payable.error, payable.status);
    if (payable.event.is_active === false) return errorResponse(res, 'This event is no longer available.', 400);
    const game = payable.game || null;
    if (game) quantity = game.quantity;

    if (await isMemberEmail(guest.email)) {
      return errorResponse(res, 'This email belongs to a NACOS member. Please sign in to buy at the member price.', 409);
    }

    const remaining = await seatsRemaining(payable.event);
    if (quantity > remaining) {
      return errorResponse(res, remaining === 0 ? 'This event is fully booked.' : `Only ${remaining} ticket(s) left for this event.`, 409);
    }
    const capErr = await gameCapacityError(game);
    if (capErr) return errorResponse(res, capErr, 409);

    const unitPrice = payable.price;
    const feeSettings = await getFeeSettings();
    const feePerTicket = serviceFeePerTicket(payable.event, feeSettings, { guest: true });
    const breakdown = game ? gameBreakdown(game, feePerTicket) : orderBreakdown({ unitPrice, quantity, feePerTicket });
    const total = breakdown.total_amount; // tickets + service fee (Bachs adds its own fee on top)
    // Never open a checkout for nothing (or less), whatever the request said.
    if (!(Number.isFinite(total) && total > 0) || !(breakdown.quantity > 0)) {
      return errorResponse(res, 'This order could not be priced. Please choose your tickets again.', 400);
    }
    const ticketLabel = orderLabel(game, quantity);

    let checkoutId = null;
    let checkoutUrl = null;
    let isSimulation = false;

    const bachsSecret = process.env.BACHS_SECRET_KEY;
    if (!isBachsKeyConfigured(bachsSecret)) {
      if (!isPaymentSimulationAllowed()) {
        return errorResponse(res, 'Payment gateway configuration error. Please contact the organisers.', 503);
      }
      isSimulation = true;
      checkoutId = `chk_mock_guest_${Date.now()}`;
    } else {
      const isLive = bachsSecret.startsWith('sk_live_');
      const baseUrl = isLive ? 'https://api.bachs.io' : 'https://sandbox-api.bachs.io';
      const payload = {
        pricing: { amount: total.toFixed(2), currency: 'NGN' },
        customer: { email: guest.email, name: guest.name },
        success_url: `${frontendBase()}/events.html?payment=success&guest=1&event_id=${encodeURIComponent(event_id)}`,
        cancel_url: `${frontendBase()}/events.html?payment=cancelled`,
        ...(feeSettings.customer_bears_gateway_fee ? { customer_bears_fee: true } : {})
      };

      let gwRes = null;
      let data = null;
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 7500);
        gwRes = await fetch(`${baseUrl}/v1/checkout-sessions`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${bachsSecret}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        clearTimeout(timeoutId);
        data = await gwRes.json().catch(() => null);
      } catch (fetchErr) {
        console.error('[Bachs] Guest session fetch error:', fetchErr.message);
      }

      if (!gwRes || !gwRes.ok) {
        console.error('[Bachs] Guest session error:', gwRes ? gwRes.status : 'no response', data);
        return errorResponse(res, 'The payment gateway is temporarily unavailable. Please try again shortly.', 502);
      }
      checkoutId = data.id || data.checkout_id || data.session_id;
      checkoutUrl = data.checkout_url || data.url;
      if (!checkoutId) {
        return errorResponse(res, 'Invalid checkout session received from the payment gateway.', 502);
      }
    }

    // The order record is REQUIRED for guests: it is what ties the payment to
    // the guest's email, quantity and price.
    const { data: intent, error: intentErr } = await supabase
      .from('payments')
      .insert([{
        user_id: null,
        guest_name: guest.name,
        guest_email: guest.email,
        guest_phone: guest.phone,
        event_id: payable.event.id,
        amount: total,
        subtotal_amount: breakdown.subtotal_amount,
        service_fee: breakdown.service_fee,
        ticket_quantity: quantity,
        ...(game ? gameColumns(game.lines) : {}),
        payment_type: 'event_registration',
        transaction_id: String(checkoutId),
        payment_proof_url: receiptUrlFor(String(checkoutId)),
        description: `Guest online payment for event: ${payable.event.title} (${ticketLabel})`,
        status: 'pending',
        submitted_at: new Date().toISOString(),
        notes: `${ONLINE_CHECKOUT_MARKER} [guest] Checkout started; awaiting gateway confirmation.`
      }])
      .select('id')
      .single();
    if (intentErr) {
      console.error('[Guest] Could not record guest checkout:', intentErr.message);
      return errorResponse(res, 'Could not start checkout. Please try again.', 500);
    }

    return successResponse(res, {
      checkout_url: checkoutUrl,
      checkout_id: String(checkoutId),
      payment_id: intent.id,
      quantity,
      ...(game ? { games: publicGames(game.lines) } : {}),
      ...breakdown,
      gateway_fee_added_at_checkout: !!feeSettings.customer_bears_gateway_fee,
      ...(isSimulation ? { is_simulation: true } : {})
    }, 'Guest checkout created');
  } catch (error) {
    console.error('Guest checkout session error:', error);
    return errorResponse(res, 'Could not start checkout. Please try again.', 500);
  }
});

// Guest confirms a payment (after the gateway redirect, or later to recover
// the ticket) with the checkout reference and the email used at checkout.
router.post('/guest-verify', guestLimiter, async (req, res) => {
  try {
    const reference = typeof req.body?.reference === 'string' ? req.body.reference.trim() : '';
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!reference || reference.length > 200 || !email) {
      return errorResponse(res, 'Enter your payment reference and the email used at checkout.', 400);
    }

    const { data: payment, error } = await supabase
      .from('payments')
      .select('*')
      .eq('transaction_id', reference)
      .maybeSingle();
    if (error) throw error;

    // Same response whether the reference is unknown or the email is wrong.
    if (!payment || !payment.guest_email || payment.user_id ||
        !safeEqual(String(payment.guest_email).toLowerCase(), email)) {
      return errorResponse(res, 'No guest order found for that reference and email.', 404);
    }
    if (payment.status === 'rejected') {
      return errorResponse(res, 'This order was rejected. Please contact the organisers.', 409);
    }
    if (!payment.event_id) {
      return errorResponse(res, 'This order is not linked to an event. Please contact the organisers.', 400);
    }

    const { data: event, error: evErr } = await supabase.from('events').select('*').eq('id', payment.event_id).maybeSingle();
    if (evErr) throw evErr;
    if (!event) return errorResponse(res, 'Event not found.', 404);

    const quantity = quantityOf(payment);
    const outcome = await confirmOnlineOrder({ payment, event, source: 'guest lookup' });
    if (!outcome.ok) return errorResponse(res, outcome.error, outcome.status);
    const { settled, ticketNumber, newlyIssued } = outcome;

    if (newlyIssued) {
      await auditLog({
        action: 'guest_payment_verified',
        userId: null,
        details: { payment_id: settled.id, amount: settled.amount, ticket_quantity: quantity, reference, event_id: event.id, ticket_number: ticketNumber },
        ip: req.ip
      });
    }

    return successResponse(res, {
      ticket_number: ticketNumber,
      ticket_quantity: quantity,
      total_amount: Number(settled.amount),
      subtotal_amount: Number(settled.subtotal_amount ?? settled.amount),
      service_fee: Number(settled.service_fee || 0),
      gateway_fee: settled.gateway_fee != null ? Number(settled.gateway_fee) : null,
      unit_price: money(Number(settled.subtotal_amount ?? settled.amount) / quantity),
      payment: {
        id: settled.id,
        transaction_id: settled.transaction_id,
        amount: Number(settled.amount),
        status: settled.status,
        ticket_quantity: quantity
      },
      guest: { name: settled.guest_name, email: settled.guest_email },
      ...await (async () => {
        const summary = publicEventSummary(event);
        const gLines = await describeGameOrder(settled);
        return gLines
          ? { event: { ...summary, title: titleWithGames(event, gLines) }, games: publicGames(gLines) }
          : { event: summary, games: null };
      })()
    }, 'Payment confirmed. Your ticket has been emailed to you.');
  } catch (error) {
    console.error('Guest verify error:', error);
    return errorResponse(res, 'Could not confirm payment. Please try again.', 500);
  }
});

// ============================================
// TICKET FEE SETTINGS
// ============================================
// Public: what buyers will pay on top of the ticket price, so the events page
// can show the full breakdown BEFORE checkout.
router.get('/fees', async (req, res) => {
  try {
    const s = await getFeeSettings();
    return successResponse(res, {
      member_service_fee: s.member_service_fee,
      guest_service_fee: s.guest_service_fee,
      gateway_fee_added_at_checkout: s.customer_bears_gateway_fee
    }, 'Ticket fees');
  } catch (error) {
    console.error('Fee settings read error:', error);
    return errorResponse(res, 'Could not load ticket fees', 500);
  }
});

// Admin: read the full settings.
router.get('/fee-settings', authenticate, requireAdmin, async (req, res) => {
  try {
    return successResponse(res, await getFeeSettings({ fresh: true }), 'Fee settings');
  } catch (error) {
    return errorResponse(res, 'Could not load fee settings', 500);
  }
});

// Super admin only: change them (audited).
router.put('/fee-settings', authenticate, requireSuperAdmin, async (req, res) => {
  try {
    const body = req.body || {};
    const updates = {};
    for (const key of ['member_service_fee', 'guest_service_fee']) {
      if (body[key] === undefined) continue;
      const n = Number(body[key]);
      if (!Number.isFinite(n) || n < 0 || n > 100000) {
        return errorResponse(res, `${key.replace(/_/g, ' ')} must be between ₦0 and ₦100,000 per ticket.`, 400);
      }
      updates[key] = money(n);
    }
    if (body.customer_bears_gateway_fee !== undefined) {
      updates.customer_bears_gateway_fee = body.customer_bears_gateway_fee === true || body.customer_bears_gateway_fee === 'true';
    }
    if (!Object.keys(updates).length) return errorResponse(res, 'Nothing to update.', 400);

    const before = await getFeeSettings({ fresh: true });
    const { data, error } = await supabase
      .from('fee_settings')
      .upsert([{ id: 1, ...updates, updated_at: new Date().toISOString(), updated_by: req.userId }], { onConflict: 'id' })
      .select()
      .single();
    if (error) throw error;
    invalidateFeeSettings();

    await auditLog({
      action: 'fee_settings_updated',
      userId: req.userId,
      userEmail: req.user?.email,
      details: {
        target: 'Ticket fee settings',
        outcome: 'success',
        actor_type: 'admin',
        before: {
          member_service_fee: before.member_service_fee,
          guest_service_fee: before.guest_service_fee,
          customer_bears_gateway_fee: before.customer_bears_gateway_fee
        },
        after: updates
      },
      ip: req.ip,
      userAgent: req.headers['user-agent']
    });

    return successResponse(res, await getFeeSettings({ fresh: true }), 'Fee settings updated');
  } catch (error) {
    console.error('Fee settings update error:', error);
    return errorResponse(res, 'Could not update fee settings', 500);
  }
});

// ============================================
// REVENUE REPORT (Admin)
// ============================================
// Confirmed ticket orders split into: tickets (NACOS), service fees, and the
// Bachs processing fee buyers paid on top. Grouped by event and by month.
router.get('/revenue', authenticate, requireAdmin, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;
    const includeArchived = req.query.include_archived === '1' || req.query.include_archived === 'true';
    const hasArchive = await archiveColumnExists();
    const PAGE = 1000;
    const rows = [];
    for (let from = 0; from < 50000; from += PAGE) {
      let q = supabase
        .from('payments')
        .select(`id, event_id, amount, subtotal_amount, service_fee, gateway_fee, ticket_quantity, verified_at, submitted_at, user_id, guest_email, description${hasArchive ? ', archived_at, archive_reason' : ''}`)
        .eq('status', 'verified')
        .eq('payment_type', 'event_registration');
      // Archived (test) orders never count; they're only listed when asked for.
      if (hasArchive && !includeArchived) q = q.is('archived_at', null);
      if (start_date) q = q.gte('verified_at', /^\d{4}-\d{2}-\d{2}$/.test(start_date) ? `${start_date}T00:00:00.000Z` : start_date);
      if (end_date) q = q.lte('verified_at', /^\d{4}-\d{2}-\d{2}$/.test(end_date) ? `${end_date}T23:59:59.999Z` : end_date);
      const { data, error } = await q.order('verified_at', { ascending: false }).range(from, from + PAGE - 1);
      if (error) throw error;
      rows.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }

    const eventIds = [...new Set(rows.map(r => r.event_id).filter(Boolean))];
    const titles = {};
    if (eventIds.length) {
      const { data: evs } = await supabase.from('events').select('id, title, date').in('id', eventIds);
      (evs || []).forEach(e => { titles[e.id] = { title: e.title, date: e.date }; });
    }

    const blank = () => ({ orders: 0, tickets: 0, ticket_revenue: 0, service_fees: 0, gateway_fees: 0, collected: 0, guest_orders: 0 });
    const add = (bucket, r) => {
      const subtotal = money(r.subtotal_amount ?? r.amount);
      const fee = money(r.service_fee || 0);
      bucket.orders += 1;
      bucket.tickets += quantityOf(r);
      bucket.ticket_revenue = money(bucket.ticket_revenue + subtotal);
      bucket.service_fees = money(bucket.service_fees + fee);
      bucket.gateway_fees = money(bucket.gateway_fees + money(r.gateway_fee || 0));
      bucket.collected = money(bucket.collected + money(r.amount));
      if (!r.user_id && r.guest_email) bucket.guest_orders += 1;
    };

    const totals = blank();
    const byEvent = {};
    const byMonth = {};
    // Deleting an event unlinks its payments (event_id becomes null). The
    // order description still says "Online payment for event: <title> (...)",
    // so group those under their old title, marked as deleted.
    const deletedTitleOf = (r) => {
      const d = String(r.description || '');
      const m = d.match(/^Online payment for event: (.+)$/);
      if (!m) return null;
      const rest = m[1].trim();
      // Drop the trailing "(...)" order label, which can itself contain
      // brackets, e.g. "(Fifa × 1, Ludo × 1 (2 plays))".
      let cut = -1;
      if (rest.endsWith(')')) {
        let depth = 0;
        for (let i = rest.length - 1; i >= 0; i--) {
          if (rest[i] === ')') depth++;
          else if (rest[i] === '(' && --depth === 0) { cut = i; break; }
        }
      }
      return (cut > 0 ? rest.slice(0, cut) : rest).trim() || null;
    };
    for (const r of rows) {
      const archived = !!r.archived_at;
      if (!archived) add(totals, r);
      let ek = r.event_id || 'none';
      let title = titles[r.event_id]?.title;
      if (!title) {
        const old = deletedTitleOf(r);
        if (old) { ek = `deleted:${old}`; title = `${old} (deleted event)`; }
      }
      if (archived) { ek = `archived:${ek}`; title = `${title || 'Unknown event'} (archived)`; }
      byEvent[ek] = byEvent[ek] || { event_id: r.event_id, title: title || 'Unknown event (deleted)', date: titles[r.event_id]?.date || null, deleted: !titles[r.event_id], archived, payment_ids: [], ...blank() };
      add(byEvent[ek], r);
      byEvent[ek].payment_ids.push(r.id);
      if (archived) continue; // archived orders stay out of the monthly figures
      const mk = String(r.verified_at || r.submitted_at || '').slice(0, 7) || 'unknown';
      byMonth[mk] = byMonth[mk] || { month: mk, ...blank() };
      add(byMonth[mk], r);
    }

    return successResponse(res, {
      totals,
      by_event: Object.values(byEvent).sort((a, b) => (a.archived - b.archived) || (b.collected - a.collected)),
      archive_available: hasArchive,
      by_month: Object.values(byMonth).sort((a, b) => (a.month < b.month ? 1 : -1)),
      gateway_fee_note: 'Bachs fees are shown when Bachs reports them on the payment. With "buyer pays processing fee" on, they were paid by buyers on top of the amounts above.'
    }, 'Revenue report');
  } catch (error) {
    console.error('Revenue report error:', error);
    return errorResponse(res, 'Could not build the revenue report', 500);
  }
});

// ============================================
// GET MY PAYMENTS (Student)
// ============================================
router.get('/my', authenticate, async (req, res) => {
  try {
    const { status } = req.query;

    let query = supabase
      .from('payments')
      .select('*')
      .eq('user_id', req.userId);

    if (status) {
      query = query.eq('status', status);
    }

    const { data, error } = await query
      .order('submitted_at', { ascending: false });

    if (error) throw error;

    return successResponse(res, data || [], 'Payments retrieved successfully');
  } catch (error) {
    console.error('Payments fetch error:', error);
    return errorResponse(res, 'Failed to fetch payments', 500, error);
  }
});

// ============================================
// EXPORT PAYMENTS AS CSV (Admin)
// ============================================
router.get('/export/csv', authenticate, requireAdmin, async (req, res) => {
  try {
    const { status, payment_type, event_id } = req.query;

    let query = supabase
      .from('payments')
      .select('*')
      .order('submitted_at', { ascending: false });

    if (status) query = query.eq('status', status);
    if (payment_type) query = query.eq('payment_type', payment_type);
    if (event_id) query = query.eq('event_id', event_id);

    const { data: payments, error } = await query;
    if (error) throw error;

    // Join student details
    const userIds = [...new Set((payments || []).map(p => p.user_id).filter(Boolean))];
    let studentMap = {};
    if (userIds.length > 0) {
      const { data: studentsData } = await supabase
        .from('students')
        .select('user_id, name, first_name, last_name, email, matric_no, department')
        .in('user_id', userIds);
      studentMap = (studentsData || []).reduce((acc, s) => {
        acc[s.user_id] = s;
        return acc;
      }, {});
    }

    // Join event details
    const eventIds = [...new Set((payments || []).map(p => p.event_id).filter(Boolean))];
    let eventMap = {};
    if (eventIds.length > 0) {
      const { data: eventsData } = await supabase
        .from('events')
        .select('id, title, date')
        .in('id', eventIds);
      eventMap = (eventsData || []).reduce((acc, e) => {
        acc[e.id] = e;
        return acc;
      }, {});
    }

    const escapeCsv = (val) => {
      if (val === null || val === undefined) return '""';
      const str = String(val).replace(/"/g, '""');
      return `"${str}"`;
    };

    const headers = [
      'Transaction Ref',
      'Buyer Type',
      'Student Name',
      'Matric No',
      'Student Email',
      'Department',
      'Purpose / Event',
      'Payment Type',
      'Tickets',
      'Unit Price (NGN)',
      'Tickets Subtotal (NGN)',
      'Service Fee (NGN)',
      'Amount (NGN)',
      'Bachs Fee (NGN)',
      'Status',
      'Gateway',
      'Ticket Number',
      'Date Submitted',
      'Verified At'
    ];

    const rows = (payments || []).map(p => {
      const student = studentMap[p.user_id];
      const isGuest = !p.user_id && !!p.guest_email;
      const studentName = student
        ? (student.name || `${student.first_name || ''} ${student.last_name || ''}`.trim())
        : (isGuest ? (p.guest_name || 'Guest') : 'Student');
      const matricNo = student?.matric_no || '';
      const email = student?.email || (isGuest ? p.guest_email : '') || '';
      const department = student?.department || '';
      const eventInfo = p.event_id ? eventMap[p.event_id] : null;
      const purpose = eventInfo?.title || p.description || (p.payment_type === 'event_registration' ? 'Event Registration' : 'Payment');
      const amount = Number(p.amount) || 0;
      const tickets = p.payment_type === 'event_registration' ? quantityOf(p) : '';
      const subtotal = money(p.subtotal_amount ?? amount);
      const serviceFee = money(p.service_fee || 0);
      const unitPrice = tickets ? money(subtotal / tickets) : '';
      const gateway = p.gateway || (p.transaction_id?.startsWith('bach_') ? 'Bachs' : 'Paystack');
      const dateSubmitted = p.submitted_at || p.created_at ? new Date(p.submitted_at || p.created_at).toISOString() : '';
      const verifiedAt = p.verified_at ? new Date(p.verified_at).toISOString() : '';

      return [
        escapeCsv(p.transaction_id || p.id || ''),
        escapeCsv(isGuest ? 'Guest' : 'Member'),
        escapeCsv(studentName),
        escapeCsv(matricNo),
        escapeCsv(email),
        escapeCsv(department),
        escapeCsv(purpose),
        escapeCsv(p.payment_type || 'event_registration'),
        escapeCsv(tickets),
        escapeCsv(unitPrice),
        escapeCsv(subtotal),
        escapeCsv(serviceFee),
        escapeCsv(amount),
        escapeCsv(p.gateway_fee != null ? money(p.gateway_fee) : ''),
        escapeCsv(p.status || 'verified'),
        escapeCsv(gateway),
        escapeCsv(p.ticket_number || (p.event_id && p.status === 'verified' ? ticketNumberFor(p.event_id, p.id) : '')),
        escapeCsv(dateSubmitted),
        escapeCsv(verifiedAt)
      ].join(',');
    });

    const csvContent = '\uFEFF' + [headers.map(h => `"${h}"`).join(','), ...rows].join('\r\n');
    const dateStamp = new Date().toISOString().split('T')[0];
    const filename = `nacos_payments_${dateStamp}.csv`;

    await auditLog({
      action: 'payments_exported_csv',
      userId: req.userId,
      details: { count: rows.length, status: status || 'all', payment_type: payment_type || 'all' },
      ip: req.ip
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(csvContent);

  } catch (error) {
    console.error('Payments CSV export error:', error);
    return errorResponse(res, 'Failed to export payments CSV', 500, error);
  }
});

// ============================================
// GET ALL PAYMENTS (Admin)
// ============================================
router.get('/', authenticate, requireAdmin, async (req, res) => {
  try {
    maybeMarkAbandonedCheckouts(); // tidy stale unpaid checkouts (at most hourly, never blocks)
    const { status, payment_type } = req.query;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const offset = (page - 1) * limit;

    let query = supabase
      .from('payments')
      .select('*', { count: 'exact' });

    if (status) query = query.eq('status', status);
    if (payment_type) query = query.eq('payment_type', payment_type);

    const { data, error, count } = await query
      .range(offset, offset + limit - 1)
      .order('submitted_at', { ascending: false });

    if (error) throw error;

    // Manually join students based on user_id
    const userIds = [...new Set((data || []).map(p => p.user_id).filter(Boolean))];
    let studentMap = {};
    if (userIds.length > 0) {
      const { data: studentsData } = await supabase
        .from('students')
        .select('user_id, name, email, matric_no, department')
        .in('user_id', userIds);
      studentMap = (studentsData || []).reduce((acc, s) => {
        acc[s.user_id] = s;
        return acc;
      }, {});
    }

    const mappedData = (data || []).map(p => ({
      ...p,
      students: studentMap[p.user_id] || null
    }));

    return successResponse(res, {
      payments: mappedData,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    }, 'Payments retrieved successfully');
  } catch (error) {
    console.error('Payments fetch error:', error);
    return errorResponse(res, 'Failed to fetch payments', 500, error);
  }
});

// ============================================
// VERIFY PAYMENT (Admin)
// ============================================
router.put('/:id/verify', authenticate, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { status, notes } = req.body;

    if (!['verified', 'rejected'].includes(status)) {
      return errorResponse(res, 'Invalid status. Use "verified" or "rejected".', 400);
    }

    // State machine: only a pending payment can be decided, exactly once.
    const { data: existing, error: existingErr } = await supabase
      .from('payments')
      .select('id, status, user_id, notes')
      .eq('id', id)
      .maybeSingle();

    if (existingErr) throw existingErr;

    // Online checkouts are confirmed by the gateway, not by eye: approving one
    // manually could issue a ticket for a checkout that was never paid.
    if (existing && status === 'verified' && isOnlineCheckoutRow(existing)) {
      return errorResponse(res, 'This is an online checkout. It is confirmed automatically by the payment gateway (or by the student tapping "Re-check payment"); it cannot be approved manually.', 409);
    }
    if (!existing) {
      return errorResponse(res, 'Payment record not found', 404);
    }
    if (existing.status !== 'pending') {
      return errorResponse(res, `Payment has already been ${existing.status}.`, 409);
    }
    // Separation of duties: an admin cannot decide their own payment.
    if (existing.user_id === req.userId) {
      return errorResponse(res, 'You cannot verify or reject your own payment.', 403);
    }

    const { data, error } = await supabase
      .from('payments')
      .update({
        status: status,
        verified_by: req.userId,
        verified_at: new Date().toISOString(),
        notes: notes || null
      })
      .eq('id', id)
      .eq('status', 'pending') // optimistic concurrency guard
      .select('*')
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return errorResponse(res, 'Payment record not found', 404);
      }
      throw error;
    }
    
    // Manually join student data
    let student = null;
    if (data.user_id) {
      const { data: sData } = await supabase
        .from('students')
        .select('name, email, matric_no')
        .eq('user_id', data.user_id)
        .maybeSingle();
      student = sData;
    }
    data.students = student;

    await auditLog({
      action: `payment_${status}`,
      userId: req.userId,
      details: { 
        payment_id: id,
        amount: data.amount,
        student: data.students?.name || null,
        status: status,
        event_id: data.event_id || null
      },
      ip: req.ip
    });

    // ============================================
    // AUTO-REGISTER FOR EVENT (HIGH-4 fix)
    // When a verified event_registration payment is approved, create (or upsert)
    // the student's event_registration row — so the student doesn't have to
    // manually come back and register themselves.
    // If rejected, remove any previously-created auto-registration (if any).
    // ============================================
    if (data.payment_type === 'event_registration' && data.event_id && (data.user_id || data.guest_email)) {
      try {
        if (status === 'verified') {
          const { data: approvedEvent, error: evErr } = await supabase
            .from('events')
            .select('*')
            .eq('id', data.event_id)
            .maybeSingle();
          if (evErr) throw evErr;
          if (!approvedEvent) throw new Error('Linked event no longer exists');

          // Same routine as online payments: one registration per order,
          // idempotent, sends the ticket email, re-syncs seat counts.
          const { ticketNumber, newlyIssued } = await issueEventTicket({ payment: data, event: approvedEvent });

          await auditLog({
            action: 'event_registration_auto_created',
            userId: req.userId,
            details: {
              event_id: data.event_id,
              student_id: data.user_id || null,
              payment_id: data.id,
              amount: data.amount,
              ticket_quantity: quantityOf(data),
              ticket_number: ticketNumber,
              newly_issued: newlyIssued
            },
            ip: req.ip
          });
        } else if (status === 'rejected') {
          // If admin rejects the proof, revoke the registration created for
          // this specific order (other orders and free registrations stay intact).
          await supabase
            .from('event_registrations')
            .delete()
            .eq('event_id', data.event_id)
            .eq('linked_payment_id', data.id);
          await syncAttendeeCount(data.event_id);
        }
      } catch (autoErr) {
        console.error('Auto event registration sync error:', autoErr);
        // Rollback payment state back to 'pending' so it is not left in an inconsistent state
        await supabase
          .from('payments')
          .update({
            status: 'pending',
            verified_by: null,
            verified_at: null,
            notes: `Auto-registration failed: ${autoErr.message || 'database error'}`
          })
          .eq('id', id);

        return errorResponse(
          res,
          'Failed to complete event registration for this payment. Verification rolled back to pending.',
          502,
          autoErr
        );
      }
    }

    return successResponse(res, { payment: data }, `Payment ${status} successfully`);

  } catch (error) {
    console.error('Payment verification error:', error);
    return errorResponse(res, 'Failed to verify payment', 500, error);
  }
});

// ============================================
// GET PAYMENT STATISTICS (Admin)
// ============================================
router.get('/stats', authenticate, requireAdmin, async (req, res) => {
  try {
    // Execute aggregation queries in parallel
    // Archived (test) payments are left out of the stats.
    const hasArchive = await archiveColumnExists();
    const live = (q) => (hasArchive ? q.is('archived_at', null) : q);
    const [
      { data: totalData, count: totalCount, error: totalError },
      { data: verifiedData, error: verifiedError },
      { count: pendingCount, error: pendingError }
    ] = await Promise.all([
      live(supabase.from('payments').select('amount', { count: 'exact' })),
      live(supabase.from('payments').select('amount').eq('status', 'verified')),
      live(supabase.from('payments').select('*', { count: 'exact', head: true }).eq('status', 'pending'))
    ]);

    if (totalError) throw totalError;
    if (verifiedError) throw verifiedError;
    if (pendingError) throw pendingError;

    const totalAmount = (totalData || []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);
    const verifiedAmount = (verifiedData || []).reduce((sum, p) => sum + (Number(p.amount) || 0), 0);

    return successResponse(res, {
      total_payments: totalCount || 0,
      total_amount: totalAmount || 0,
      verified_amount: verifiedAmount || 0,
      pending_count: pendingCount || 0,
      verified_count: verifiedData?.length || 0
    }, 'Payment statistics retrieved successfully');

  } catch (error) {
    console.error('Payment stats error:', error);
    return errorResponse(res, 'Failed to fetch payment statistics', 500, error);
  }
});

// ============================================
// PAYMENT WEBHOOK LISTENER (Bachs & Paystack)
// ============================================
// ============================================
// ARCHIVE / RESTORE PAYMENTS (admin)
// ============================================
// Soft delete: archived orders are kept but left out of revenue, stats and
// the default Payments list. Body: { ids: [payment id, ...], reason? }.
const PAYMENT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function parseArchiveIds(body) {
  const ids = Array.isArray(body?.ids) ? [...new Set(body.ids.map(String))] : [];
  if (!ids.length) return { error: 'Choose at least one payment.' };
  if (ids.length > 500) return { error: 'At most 500 payments at a time.' };
  if (ids.some(id => !PAYMENT_ID_RE.test(id))) return { error: 'One of the payment ids is not valid.' };
  return { ids };
}
const archiveHandler = (restore) => async (req, res) => {
  try {
    if (!(await archiveColumnExists())) {
      return errorResponse(res, 'Archiving needs database migration 029 first.', 409);
    }
    const parsed = parseArchiveIds(req.body);
    if (parsed.error) return errorResponse(res, parsed.error, 400);
    const reason = typeof req.body?.reason === 'string' && req.body.reason.trim()
      ? req.body.reason.trim().replace(/\s+/g, ' ').slice(0, 200)
      : 'Archived by admin';
    let q = supabase.from('payments').update(restore
      ? { archived_at: null, archived_by: null, archive_reason: null }
      : { archived_at: new Date().toISOString(), archived_by: req.userId || null, archive_reason: reason })
      .in('id', parsed.ids);
    q = restore ? q.not('archived_at', 'is', null) : q.is('archived_at', null);
    const { data, error } = await q.select('id');
    if (error) throw error;
    const changed = (data || []).length;
    await auditLog({
      action: restore ? 'payments_restored' : 'payments_archived',
      userId: req.userId,
      details: { count: changed, ids: parsed.ids.slice(0, 100), ...(restore ? {} : { reason }) },
      ip: req.ip
    });
    return successResponse(res, { changed }, `${changed} payment(s) ${restore ? 'restored' : 'archived'}`);
  } catch (error) {
    console.error('[payments] archive error:', error);
    return errorResponse(res, restore ? 'Could not restore payments' : 'Could not archive payments', 500, error);
  }
};
router.post('/archive', authenticate, requireAdmin, archiveHandler(false));
router.post('/unarchive', authenticate, requireAdmin, archiveHandler(true));

// ============================================
// FETCH MISSING BACHS FEES (admin)
// ============================================
// Older orders were saved before the Bachs fee was read from the right place,
// and Bachs only reports the fee once a payment settles. This asks Bachs again
// for up to 40 paid online orders that have no fee recorded.
router.post('/refresh-gateway-fees', authenticate, requireAdmin, async (req, res) => {
  try {
    const bachsSecret = process.env.BACHS_SECRET_KEY;
    if (!isBachsKeyConfigured(bachsSecret)) return errorResponse(res, 'Bachs is not configured on the server.', 503);
    const baseUrl = bachsSecret.startsWith('sk_live_') ? 'https://api.bachs.io' : 'https://sandbox-api.bachs.io';

    const { data: rows, error } = await supabase
      .from('payments')
      .select('id, transaction_id, notes')
      .eq('status', 'verified')
      .is('gateway_fee', null)
      .not('transaction_id', 'is', null)
      // Bachs references: checkout "chk_..." or charge "ch_...". (The
      // "[online-checkout]" note is replaced when a payment is confirmed,
      // so it can't be used to find paid orders.)
      .ilike('transaction_id', 'ch%')
      .order('verified_at', { ascending: false })
      .limit(40);
    if (error) throw error;

    let updated = 0; let notFound = 0; let noFeeYet = 0;
    for (const p of rows || []) {
      const ref = String(p.transaction_id);
      const url = ref.startsWith('chk_')
        ? `${baseUrl}/v1/checkout-sessions/${encodeURIComponent(ref)}`
        : `${baseUrl}/v1/payments/${encodeURIComponent(ref)}`;
      try {
        const resp = await fetch(url, { headers: { 'Authorization': `Bearer ${bachsSecret}`, 'Content-Type': 'application/json' } });
        if (!resp.ok) { notFound += 1; continue; }
        const j = await resp.json().catch(() => null);
        const obj = (j && (j.data || j)) || {};
        const fee = gatewayFeeOf(obj);
        if (fee == null) { noFeeYet += 1; continue; }
        const paidBy = gatewayFeePaidByOf(obj);
        const { error: upErr } = await supabase
          .from('payments')
          .update({ gateway_fee: fee, ...(paidBy ? { gateway_fee_paid_by: paidBy } : {}) })
          .eq('id', p.id)
          .is('gateway_fee', null);
        if (upErr) throw upErr;
        updated += 1;
      } catch (e) {
        console.warn(`[Bachs] fee refresh failed for ${ref}:`, e.message);
        notFound += 1;
      }
    }
    if (updated) {
      await auditLog({ action: 'gateway_fees_refreshed', userId: req.userId, details: { checked: (rows || []).length, updated }, ip: req.ip });
    }
    return successResponse(res, { checked: (rows || []).length, updated, no_fee_yet: noFeeYet, not_found: notFound },
      `${updated} order(s) updated with their Bachs fee`);
  } catch (error) {
    console.error('[Bachs] refresh fees error:', error);
    return errorResponse(res, 'Could not fetch Bachs fees', 500, error);
  }
});

// ============================================
// MARK ABANDONED CHECKOUTS
// ============================================
// Called daily by Vercel Cron (Authorization: Bearer CRON_SECRET), or by an
// admin. Marks online checkouts still unpaid after 24h as "abandoned".
const cronOrAdmin = (req, res, next) => {
  const secret = process.env.CRON_SECRET;
  const header = req.headers.authorization || '';
  if (secret && header.length === `Bearer ${secret}`.length && safeEqual(header, `Bearer ${secret}`)) {
    req.viaCron = true;
    return next();
  }
  return authenticate(req, res, () => requireAdmin(req, res, next));
};
const runAbandonCleanup = async (req, res) => {
  try {
    const result = await markAbandonedCheckouts();
    if (result.marked) {
      await auditLog({ action: 'checkouts_marked_abandoned', userId: req.userId || null, details: { ...result, via: req.viaCron ? 'cron' : 'admin' }, ip: req.ip });
    }
    return successResponse(res, result, `${result.marked} unpaid checkout(s) marked abandoned`);
  } catch (error) {
    console.error('[checkouts] cleanup error:', error);
    return errorResponse(res, 'Could not clean up abandoned checkouts', 500, error);
  }
};
router.get('/cleanup-abandoned', cronOrAdmin, runAbandonCleanup);
router.post('/cleanup-abandoned', cronOrAdmin, runAbandonCleanup);

router.post('/webhook', async (req, res) => {
  const bachsSecret = process.env.BACHS_SECRET_KEY;
  const paystackSecret = process.env.PAYSTACK_SECRET_KEY;

  const event = req.body || {};
  console.log('[Webhook] Received event:', event.event || event.type || event.status || 'unknown');

  // Handle Bachs Webhook if payload matches Bachs format
  const isBachsEvent = 
    event.type?.startsWith('checkout.') || 
    event.type?.startsWith('payment.') || 
    event.event?.startsWith('checkout.') ||
    event.checkout_id ||
    event.data?.checkout_id;

  if (isBachsEvent) {
    // Critical Finding #1: Enforce signature / secret verification on Bachs webhook
    const signature = req.headers['x-bachs-signature'] || req.headers['bachs-signature'] || req.headers['x-signature'];
    // Shared-secret header only: query-string secrets end up in access logs.
    const webhookToken = req.headers['x-webhook-token'] || req.headers['x-webhook-secret'];

    let isAuthorized = false;
    if (bachsSecret) {
      if (signature) {
        const payloadString = req.rawBody || JSON.stringify(req.body);
        const expectedHmac256 = crypto.createHmac('sha256', bachsSecret).update(payloadString).digest('hex');
        const expectedHmac512 = crypto.createHmac('sha512', bachsSecret).update(payloadString).digest('hex');
        
        try {
          if (signature.length === expectedHmac256.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedHmac256))) {
            isAuthorized = true;
          } else if (signature.length === expectedHmac512.length && crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedHmac512))) {
            isAuthorized = true;
          }
        } catch (_) {}
      } else if (webhookToken && safeEqual(webhookToken, bachsSecret)) {
        isAuthorized = true;
      }
    }

    if (!isAuthorized) {
      console.warn('[Bachs Webhook] ❌ Blocked unsigned or invalid Bachs webhook request');
      return res.status(401).send('Unauthorized: Invalid or missing Bachs signature');
    }

    // Do all the work BEFORE acknowledging: on serverless platforms the function
    // can be frozen as soon as the response is sent. On failure we return 500 so
    // the gateway retries (settlement is idempotent).
    try {
      const bData = event.data || event;
      const eventType = String(event.type || event.event || '').toLowerCase();
      const candidateIds = gatewayIdsOf(bData);
      const paid = isGatewayPaid(bData) || /(completed|succeeded|success|paid)$/.test(eventType);

      // Match on whichever identifier we recorded when the checkout started
      // (the checkout ID), not just the event's own id (often the charge ID).
      let ref = null;
      if (candidateIds.length) {
        const { data: matches, error: matchErr } = await supabase
          .from('payments')
          .select('transaction_id')
          .in('transaction_id', candidateIds);
        if (matchErr) throw matchErr;
        const known = new Set((matches || []).map(m => m.transaction_id));
        ref = candidateIds.find(id => known.has(id)) || candidateIds[0];
      }
      const chargeId = candidateIds.find(id => id !== ref) || null;

      console.log(`[Bachs Webhook] type=${eventType || 'none'} status=${describeGatewayStatus(bData) || 'none'} paid=${paid} ids=${candidateIds.join(',')} matched=${ref || 'none'}`);

      if (ref && paid) {
        const rawAmt = bData.pricing?.amount ?? bData.amount_paid ?? bData.amount;
        const result = await settleWebhookPayment({
          reference: String(ref),
          amountNaira: parseFloat(rawAmt),
          currency: bData.pricing?.currency || bData.currency || 'NGN',
          customerEmail: bData.customer?.email || event.customer?.email || bData.metadata?.email,
          source: chargeId ? `Bachs webhook (gateway ref ${chargeId})` : 'Bachs webhook',
          gatewayFee: gatewayFeeOf(bData)
        });
        console.log('[Bachs Webhook] Settled', ref, JSON.stringify(result));
      }
      return res.sendStatus(200);
    } catch (bErr) {
      console.error('[Bachs Webhook Error]:', bErr);
      return res.status(500).send('Processing error; please retry');
    }
  }

  // Paystack verification
  if (!paystackSecret) return res.status(200).send('No paystack secret');

  // Validate Paystack signature
  const signature = req.headers['x-paystack-signature'];
  if (!signature) return res.status(400).send('No signature');
  
  let hash;
  if (req.rawBody) {
    hash = crypto.createHmac('sha512', paystackSecret).update(req.rawBody).digest('hex');
  } else {
    hash = crypto.createHmac('sha512', paystackSecret).update(JSON.stringify(req.body)).digest('hex');
  }
  
  if (!safeEqual(hash, signature)) {
    return res.status(400).send('Invalid signature');
  }

  // Process first, acknowledge after (see Bachs branch above for why).
  if (event.event !== 'charge.success') {
    return res.sendStatus(200);
  }

  try {
    const data = event.data || {};
    const metadata = data.metadata || {};
    let hintedEventId = null;
    let hintedUserId = null;
    if (Array.isArray(metadata.custom_fields)) {
      hintedEventId = metadata.custom_fields.find(f => f.variable_name === 'event_id')?.value || null;
      hintedUserId = metadata.custom_fields.find(f => f.variable_name === 'user_id')?.value || null;
    }

    const result = await settleWebhookPayment({
      reference: String(data.reference),
      amountNaira: Number(data.amount) / 100, // kobo -> Naira
      currency: data.currency || 'NGN',
      customerEmail: data.customer?.email,
      hintedEventId,
      hintedUserId,
      source: 'Paystack webhook'
    });
    console.log('[Paystack Webhook] Settled', data.reference, JSON.stringify(result));
    return res.sendStatus(200);
  } catch (err) {
    console.error('[Webhook Error] Processing Paystack charge.success:', err);
    return res.status(500).send('Processing error; please retry');
  }
});

/**
 * Record a gateway-confirmed payment from a webhook and, when the payment is
 * tied to an event and covers its fee, issue the ticket. Idempotent.
 *
 * The owner and event come from the server-recorded checkout row when one
 * exists (created by /bachs-session); webhook payload hints are only used as a
 * fallback. Underpaid payments are recorded as `pending` for admin review and
 * no ticket is issued.
 */
async function settleWebhookPayment({ reference, amountNaira, currency, customerEmail, hintedEventId = null, hintedUserId = null, source, gatewayFee = null }) {
  if (!reference || reference === 'undefined') throw new Error('Webhook payload has no reference');

  const { data: existing, error: existingErr } = await supabase
    .from('payments')
    .select('*')
    .eq('transaction_id', reference)
    .maybeSingle();
  if (existingErr) throw existingErr;

  if (existing && existing.status === 'rejected') {
    return { action: 'skipped', reason: 'payment previously rejected by an admin' };
  }

  // Resolve owner. Guest orders keep their guest details and are never matched
  // to a student account by email.
  const isGuestOrder = !!(existing && existing.guest_email && !existing.user_id);
  let userId = existing?.user_id || (isGuestOrder ? null : hintedUserId) || null;
  if (!userId && !isGuestOrder && customerEmail) {
    const { data: matched } = await supabase
      .from('students')
      .select('user_id')
      .eq('email', String(customerEmail).toLowerCase().trim())
      .maybeSingle();
    userId = matched?.user_id || null;
  }

  // Resolve event and its authoritative price
  let targetEvent = null;
  let expected = null;
  let quantity = 1;
  let priced = null; // { total_amount, subtotal_amount, service_fee }
  const eventId = existing?.event_id || hintedEventId || null;
  if (eventId) {
    // Game orders carry their game on the recorded checkout. A game-event
    // payment with no recorded checkout can't be priced here, so it is left
    // for admin review (no ticket) like any other unmatched payment.
    const payable = await loadPayableEvent(eventId, { guest: isGuestOrder, lines: existing && existing.event_id === eventId ? linesFromRow(existing) : null, settling: true });
    if (!payable.error) {
      targetEvent = payable.event;
      if (existing && existing.event_id && money(existing.amount) > 0) {
        // The server-recorded checkout is authoritative (quantity, tickets + service fee).
        quantity = quantityOf(existing);
        priced = {
          total_amount: money(existing.amount),
          subtotal_amount: money(existing.subtotal_amount ?? existing.amount),
          service_fee: money(existing.service_fee || 0)
        };
      } else {
        // No recorded checkout: infer how many full tickets (price + service
        // fee each) the confirmed amount covers, priced with current settings.
        const feeSettings = await getFeeSettings();
        const feePerTicket = serviceFeePerTicket(payable.event, feeSettings, { guest: isGuestOrder });
        if (existing && existing.event_id) quantity = quantityOf(existing);
        else if (Number.isFinite(amountNaira)) {
          quantity = Math.min(MAX_TICKETS_PER_ORDER, Math.max(1, Math.floor((amountNaira + 0.01) / (payable.price + feePerTicket))));
        }
        priced = orderBreakdown({ unitPrice: payable.price, quantity, feePerTicket });
      }
      expected = priced.total_amount;
    }
  }

  const amountOk = Number.isFinite(amountNaira) && String(currency || 'NGN').toUpperCase() === 'NGN';
  const underpaid = !!targetEvent && (!amountOk || amountNaira + 0.01 < expected);
  const now = new Date().toISOString();
  const notes = underpaid
    ? `${source}: UNDERPAID or unreadable amount (paid ${amountNaira} ${currency}, expected ${expected} NGN). Needs admin review; no ticket issued.`
    : `Verified via ${source}`;

  // Store our breakdown (tickets + service fee) for paid-in-full event orders;
  // the Bachs fee the buyer paid on top is recorded separately.
  const recordedAmount = (priced && !underpaid) ? priced.total_amount : (Number.isFinite(amountNaira) ? amountNaira : 0);
  const feeColumns = {
    ...(priced ? { subtotal_amount: priced.subtotal_amount, service_fee: priced.service_fee } : {}),
    ...(gatewayFee != null ? { gateway_fee: gatewayFee } : {})
  };

  let payment = existing;
  if (!existing) {
    const { data: inserted, error: insErr } = await supabase
      .from('payments')
      .insert([{
        user_id: userId,
        event_id: targetEvent ? targetEvent.id : null,
        amount: recordedAmount,
        ...feeColumns,
        ticket_quantity: quantity,
        payment_type: targetEvent ? 'event_registration' : 'other',
        transaction_id: reference,
        payment_proof_url: receiptUrlFor(reference),
        description: targetEvent
          ? `Online payment for event: ${targetEvent.title} (${quantity} ticket${quantity > 1 ? 's' : ''})`
          : `Online payment (${source})`,
        status: underpaid ? 'pending' : 'verified',
        verified_at: underpaid ? null : now,
        submitted_at: now,
        notes: userId ? notes : `${notes} (no matching student for email: ${customerEmail || 'unknown'})`
      }])
      .select()
      .single();
    if (insErr) throw insErr; // e.g. unique violation racing a verify call -> 500 -> gateway retries
    payment = inserted;
  } else if (existing.status !== 'verified') {
    const { data: updated, error: updErr } = await supabase
      .from('payments')
      .update({
        user_id: existing.user_id || userId,
        amount: (priced && !underpaid) ? priced.total_amount : (Number.isFinite(amountNaira) ? amountNaira : existing.amount),
        ...feeColumns,
        status: underpaid ? 'pending' : 'verified',
        verified_at: underpaid ? null : now,
        notes
      })
      .eq('id', existing.id)
      .neq('status', 'verified')
      .select()
      .maybeSingle();
    if (updErr) throw updErr;
    if (updated) payment = updated;
    else {
      // Settled concurrently by the student's verify call; re-read.
      const { data: fresh } = await supabase.from('payments').select('*').eq('id', existing.id).maybeSingle();
      payment = fresh || existing;
    }
  }

  if (underpaid) {
    console.warn(`[payments] ${source}: underpaid ${reference} (paid ${amountNaira}, expected ${expected}).`);
    return { action: 'recorded_underpaid', payment_id: payment.id };
  }

  if (targetEvent && (payment.user_id || payment.guest_email) && payment.status === 'verified') {
    const { ticketNumber, newlyIssued } = await issueEventTicket({ payment, event: targetEvent });
    if (newlyIssued) {
      await auditLog({
        action: 'webhook_payment_verified',
        userId: payment.user_id,
        details: { payment_id: payment.id, amount: payment.amount, ticket_quantity: quantityOf(payment), reference, event_id: targetEvent.id, ticket_number: ticketNumber, source },
        ip: null
      });
    }
    return { action: newlyIssued ? 'ticket_issued' : 'already_issued', payment_id: payment.id, ticket_number: ticketNumber };
  }

  return { action: 'recorded', payment_id: payment.id, has_event: !!targetEvent, has_user: !!payment.user_id };
}

module.exports = router;
