// routes/payments.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { successResponse, errorResponse, generateTransactionId } = require('../utils/helpers');
const { sendEventTicketEmail, sendPaymentAdminNotificationEmail } = require('../services/email');
const crypto = require('crypto');

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
async function loadPayableEvent(eventId) {
  const { data: event, error } = await supabase
    .from('events')
    .select('*')
    .eq('id', eventId)
    .maybeSingle();
  if (error) throw error;
  if (!event) return { error: 'Target event not found', status: 404 };
  const price = Number(event.payment_amount);
  if (!Number.isFinite(price) || price <= 0) {
    return { error: 'This event does not require payment.', status: 400 };
  }
  return { event, price };
}

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
async function issueEventTicket({ payment, event, userId }) {
  const { data: existingReg, error: regLookupErr } = await supabase
    .from('event_registrations')
    .select('*')
    .eq('event_id', event.id)
    .eq('user_id', userId)
    .maybeSingle();
  if (regLookupErr) throw regLookupErr;

  // Already linked to this payment => a retry; already linked to a DIFFERENT
  // payment => the student paid twice. Either way keep the existing ticket.
  if (existingReg && existingReg.linked_payment_id) {
    if (existingReg.linked_payment_id !== payment.id) {
      console.warn(`[payments] Duplicate payment ${payment.id} for user ${userId} on event ${event.id}; existing registration kept (refund candidate).`);
    }
    return {
      registration: existingReg,
      ticketNumber: existingReg.ticket_number || ticketNumberFor(event.id, existingReg.linked_payment_id),
      newlyIssued: false
    };
  }

  const { data: registration, error: regErr } = await supabase
    .from('event_registrations')
    .upsert([{
      event_id: event.id,
      user_id: userId,
      registration_date: new Date().toISOString(),
      status: 'registered',
      linked_payment_id: payment.id
    }], { onConflict: 'event_id,user_id' })
    .select()
    .single();
  if (regErr) throw regErr;

  const ticketNumber = registration?.ticket_number || ticketNumberFor(event.id, payment.id);

  try {
    const { count } = await supabase.from('event_registrations').select('id', { count: 'exact', head: true }).eq('event_id', event.id);
    if (typeof count === 'number') await supabase.from('events').update({ current_attendees: count }).eq('id', event.id);
  } catch (_) { /* non-fatal */ }

  // Notifications are awaited (bounded) so a serverless platform cannot freeze
  // the function before they are sent, but a slow mail provider can't block
  // the student's confirmation for long either.
  await withTimeout((async () => {
    try {
      const { data: student } = await supabase.from('students').select('*').eq('user_id', userId).maybeSingle();
      if (student && student.email) {
        await sendEventTicketEmail({ student, event, ticketNumber, payment });
      }
      await sendPaymentAdminNotificationEmail({
        student: student || { name: 'Student', email: '' },
        event,
        payment,
        ticketNumber
      });
      try {
        await supabase.from('payment_verification').insert([{
          student_id: student?.id || null,
          event_id: event.id,
          amount: payment.amount,
          payment_reference: payment.transaction_id,
          status: 'verified',
          created_at: new Date().toISOString()
        }]);
      } catch (pvErr) {
        console.warn('payment_verification sync notice:', pvErr?.message || pvErr);
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

    const payable = await loadPayableEvent(event_id);
    if (payable.error) {
      return errorResponse(res, payable.error, payable.status);
    }
    const { price } = payable;

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
      cancel_url: `${process.env.FRONTEND_URL || 'https://nacosportal.vercel.app'}/events.html?payment=cancelled`
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
          payment_type: 'event_registration',
          transaction_id: String(checkoutId),
          payment_proof_url: receiptUrlFor(String(checkoutId)),
          description: `Online payment for event: ${payable.event.title}`,
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
      payment_id: paymentId
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
      event_id
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

    // If event_id is provided, confirm the target event actually exists and validate price.
    let resolvedEventId = null;
    if (event_id) {
      const { data: targetEvent, error: evErr } = await supabase
        .from('events')
        .select('id, title, is_paid, payment_amount')
        .eq('id', event_id)
        .maybeSingle();

      if (evErr) throw evErr;
      if (!targetEvent) {
        return errorResponse(res, `Event ${event_id} does not exist.`, 400);
      }
      resolvedEventId = targetEvent.id;

      // Medium Finding #3: Validate submitted amount against event payment_amount
      if (targetEvent.is_paid && targetEvent.payment_amount) {
        const requiredAmount = Number(targetEvent.payment_amount);
        if (parsedAmount < requiredAmount) {
          return errorResponse(res, `Submitted amount (₦${parsedAmount}) is less than the required fee (₦${requiredAmount}) for "${targetEvent.title}".`, 400);
        }
      }
    }

    const { data, error } = await supabase
      .from('payments')
      .insert([{
        user_id: req.userId,
        amount: parsedAmount,
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

    const ticketNumber = registration?.ticket_number ||
      ('NACOS-' + (payment.event_id ? payment.event_id.substring(0, 4).toUpperCase() : 'PAY') +
       '-' + payment.id.substring(0, 6).toUpperCase());

    // Public-safe payload: ticket status and event info only — no student PII
    const publicPayload = {
      ticket_number: ticketNumber,
      status: payment.status,
      payment_type: payment.payment_type,
      amount: payment.amount,
      verified_at: payment.verified_at,
      submitted_at: payment.submitted_at,
      event,
      registration
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
 * Verify `reference` with the gateway and, if it is paid in full, record the
 * payment and issue the event ticket. Shared by /verify-paystack (redirect
 * return) and /:id/recheck (student-initiated recovery). Idempotent.
 */
async function verifyAndSettle(req, res, { reference, event_id }) {
  try {
    // This endpoint only settles event tickets; the price must come from an event.
    const payment_type = 'event_registration';

    if (!reference || typeof reference !== 'string' || reference.length > 200) {
      return errorResponse(res, 'A valid payment reference is required', 400);
    }

    if (!event_id) {
      return errorResponse(res, 'event_id is required for event registration payments', 400);
    }

    // 1. Fetch event details and its authoritative price (Naira)
    const payable = await loadPayableEvent(event_id);
    if (payable.error) {
      return errorResponse(res, payable.error, payable.status);
    }
    const targetEvent = payable.event;
    const expectedAmount = payable.price;

    // 2. Prevent replay: a reference belongs to exactly one user AND one event
    const { data: existingPayment, error: existingPayErr } = await supabase
      .from('payments')
      .select('*')
      .eq('transaction_id', reference)
      .maybeSingle();

    if (existingPayErr) throw existingPayErr;

    if (existingPayment && existingPayment.user_id && existingPayment.user_id !== req.userId) {
      return errorResponse(res, 'This payment reference is already associated with another account.', 403);
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

    // Capacity check (skipped when this user is already registered, e.g. a retried verification)
    if (typeof targetEvent.max_attendees === 'number' && targetEvent.max_attendees > 0) {
      const { data: ownReg } = await supabase
        .from('event_registrations')
        .select('id')
        .eq('event_id', targetEvent.id)
        .eq('user_id', req.userId)
        .maybeSingle();

      if (!ownReg) {
        const { count, error: cntErr } = await supabase
          .from('event_registrations')
          .select('id', { count: 'exact', head: true })
          .eq('event_id', targetEvent.id);

        if (cntErr) throw cntErr;
        if ((count ?? 0) >= targetEvent.max_attendees) {
          return errorResponse(res, `Event is fully booked (${targetEvent.max_attendees} attendees reached).`, 409);
        }
      }
    }

    const simulatedPayment = (channel) => ({
      status: 'success',
      amount: expectedAmount * 100,
      currency: 'NGN',
      channel,
      reference,
      paid_at: new Date().toISOString()
    });

    // 3. Verify with Bachs API
    const bachsSecret = process.env.BACHS_SECRET_KEY;
    let verifiedPaymentData = null;

    if (isBachsKeyConfigured(bachsSecret)) {
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

        const sessionStatus = String(sessionObj.status || sessionObj.payment_status || sessionObj.state || '').toLowerCase();
        const isPaidOrCompleted = 
          sessionStatus === 'completed' || 
          sessionStatus === 'success' || 
          sessionStatus === 'successful' || 
          sessionStatus === 'paid' ||
          sessionObj.paid === true;

        if (!verifyRes || !verifyRes.ok || !isPaidOrCompleted) {
          // SECURITY: an unverified reference is never treated as paid (not even
          // on a sandbox key) unless simulation is explicitly enabled for local dev.
          if (isPaymentSimulationAllowed()) {
            console.warn(`[Bachs] Local simulation: accepting unverified reference "${reference}"`);
            verifiedPaymentData = simulatedPayment('card (local simulation)');
          } else {
            const reason = verifyData?.message || verifyData?.detail || `Session status is "${sessionStatus || 'unknown'}" (expected completed/paid)`;
            return errorResponse(res, `Payment could not be verified: ${reason}`, 400);
          }
        } else {
          // Verified by the gateway. The gateway must report the amount; never
          // fall back to the event price.
          const rawAmount = sessionObj.pricing?.amount ?? sessionObj.amount;
          const gatewayNaira = parseFloat(rawAmount);
          const currency = String(sessionObj.pricing?.currency || sessionObj.currency || 'NGN').toUpperCase();

          if (!Number.isFinite(gatewayNaira)) {
            console.error('[Bachs] Verified session has no readable amount:', reference);
            return errorResponse(res, 'Payment could not be verified: amount missing from gateway response.', 400);
          }
          if (currency !== 'NGN') {
            return errorResponse(res, `Payment could not be verified: unexpected currency ${currency}.`, 400);
          }
          // 1 kobo rounding tolerance
          if (gatewayNaira + 0.01 < expectedAmount) {
            console.warn(`[Bachs] Amount mismatch for ${reference}: paid ${gatewayNaira}, expected ${expectedAmount} (event ${targetEvent.id}, user ${req.userId})`);
            return errorResponse(res, `Amount paid (₦${gatewayNaira}) is less than the event fee (₦${expectedAmount}).`, 400);
          }

          // Bind the checkout to the paying account when the gateway reports a customer email.
          const customerEmail = String(sessionObj.customer?.email || sessionObj.customer_email || '').trim().toLowerCase();
          const userEmail = String(req.user?.email || '').trim().toLowerCase();
          if (customerEmail && userEmail && customerEmail !== userEmail) {
            return errorResponse(res, 'This payment was made from a different account.', 403);
          }

          verifiedPaymentData = {
            status: 'success',
            amount: Math.round(gatewayNaira * 100),
            currency,
            channel: sessionObj.mode || sessionObj.channel || 'online checkout',
            reference: sessionObj.id || sessionObj.checkout_id || sessionObj.reference || reference,
            paid_at: sessionObj.completed_at || sessionObj.paid_at || new Date().toISOString()
          };
        }
      } catch (err) {
        console.error('Bachs verify fetch error:', err);
        return errorResponse(res, 'Internal server error during payment verification', 500);
      }
    } else {
      if (!isPaymentSimulationAllowed()) {
        console.error('[Bachs] BACHS_SECRET_KEY missing and simulation not allowed; refusing verification.');
        return errorResponse(res, 'Payment gateway configuration error. Please contact administrator.', 503);
      }
      console.warn(`[Bachs] BACHS_SECRET_KEY not set. Local simulation accepting reference "${reference}".`);
      verifiedPaymentData = simulatedPayment('card (local simulation)');
    }

    const paidAmount = verifiedPaymentData.amount / 100;

    // 4. Save/update payment record in database
    let paymentRecord = existingPayment;

    if (!paymentRecord) {
      const { data: newPayment, error: createPayErr } = await supabase
        .from('payments')
        .insert([{
          user_id: req.userId,
          amount: paidAmount,
          payment_type: payment_type,
          transaction_id: reference,

          payment_proof_url: `${process.env.FRONTEND_URL || 'https://nacosportal.vercel.app'}/receipt.html?reference=${encodeURIComponent(reference)}`,
          description: targetEvent ? `Online payment for event: ${targetEvent.title}` : `Bachs online payment`,
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
        payment_type
      };
      if (paymentRecord.status !== 'verified') {
        Object.assign(updates, {
          amount: paidAmount,
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
      await issueEventTicket({ payment: paymentRecord, event: targetEvent, userId: req.userId });

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
          ticket_number: ticketNumber
        },
        ip: req.ip
      });
    }

    return successResponse(res, {
      payment: paymentRecord,
      registration: registrationRecord,
      ticket_number: ticketNumber,
      event: targetEvent ? {
        id: targetEvent.id,
        title: targetEvent.title,
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
  verifyAndSettle(req, res, { reference: req.body?.reference, event_id: req.body?.event_id })
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
      'Student Name',
      'Matric No',
      'Student Email',
      'Department',
      'Purpose / Event',
      'Payment Type',
      'Amount (NGN)',
      'Status',
      'Gateway',
      'Ticket Number',
      'Date Submitted',
      'Verified At'
    ];

    const rows = (payments || []).map(p => {
      const student = studentMap[p.user_id];
      const studentName = student ? (student.name || `${student.first_name || ''} ${student.last_name || ''}`.trim()) : 'Student';
      const matricNo = student?.matric_no || '';
      const email = student?.email || '';
      const department = student?.department || '';
      const eventInfo = p.event_id ? eventMap[p.event_id] : null;
      const purpose = eventInfo?.title || p.description || (p.payment_type === 'event_registration' ? 'Event Registration' : 'Payment');
      const amount = Number(p.amount) || 0;
      const gateway = p.gateway || (p.transaction_id?.startsWith('bach_') ? 'Bachs' : 'Paystack');
      const dateSubmitted = p.submitted_at || p.created_at ? new Date(p.submitted_at || p.created_at).toISOString() : '';
      const verifiedAt = p.verified_at ? new Date(p.verified_at).toISOString() : '';

      return [
        escapeCsv(p.transaction_id || p.id || ''),
        escapeCsv(studentName),
        escapeCsv(matricNo),
        escapeCsv(email),
        escapeCsv(department),
        escapeCsv(purpose),
        escapeCsv(p.payment_type || 'event_registration'),
        escapeCsv(amount),
        escapeCsv(p.status || 'verified'),
        escapeCsv(gateway),
        escapeCsv(p.ticket_number || ''),
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
    if (data.payment_type === 'event_registration' && data.event_id && data.user_id) {
      try {
        if (status === 'verified') {
          const { error: regErr } = await supabase
            .from('event_registrations')
            .upsert(
              [{
                event_id: data.event_id,
                user_id: data.user_id,
                registration_date: new Date().toISOString(),
                status: 'registered',
                linked_payment_id: data.id
              }],
              { onConflict: 'event_id,user_id', ignoreDuplicates: false }
            );

          if (regErr) throw regErr;
          try {
            const { count: c } = await supabase.from('event_registrations').select('id', { count: 'exact', head: true }).eq('event_id', data.event_id);
            if (typeof c === 'number') await supabase.from('events').update({ current_attendees: c }).eq('id', data.event_id);
          } catch (_) {}

          await auditLog({
            action: 'event_registration_auto_created',
            userId: req.userId,
            details: {
              event_id: data.event_id,
              student_id: data.user_id,
              payment_id: data.id,
              amount: data.amount
            },
            ip: req.ip
          });
        } else if (status === 'rejected') {
          // If admin rejects the proof, revoke any auto-created registration
          // that was linked to this specific payment (to keep manual registrations intact).
          await supabase
            .from('event_registrations')
            .delete()
            .eq('event_id', data.event_id)
            .eq('user_id', data.user_id)
            .eq('linked_payment_id', data.id);
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
    const [
      { data: totalData, count: totalCount, error: totalError },
      { data: verifiedData, error: verifiedError },
      { count: pendingCount, error: pendingError }
    ] = await Promise.all([
      supabase.from('payments').select('amount', { count: 'exact' }),
      supabase.from('payments').select('amount').eq('status', 'verified'),
      supabase.from('payments').select('*', { count: 'exact', head: true }).eq('status', 'pending')
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
      const ref = bData.id || bData.checkout_id || bData.reference || bData.code;
      const status = String(bData.status || bData.state || event.type || '').toLowerCase();

      if (ref && (status.includes('completed') || status.includes('success') || status.includes('paid'))) {
        const rawAmt = bData.pricing?.amount ?? bData.amount;
        const result = await settleWebhookPayment({
          reference: String(ref),
          amountNaira: parseFloat(rawAmt),
          currency: bData.pricing?.currency || bData.currency || 'NGN',
          customerEmail: bData.customer?.email || event.customer?.email || bData.metadata?.email,
          source: 'Bachs webhook'
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
async function settleWebhookPayment({ reference, amountNaira, currency, customerEmail, hintedEventId = null, hintedUserId = null, source }) {
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

  // Resolve owner
  let userId = existing?.user_id || hintedUserId || null;
  if (!userId && customerEmail) {
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
  const eventId = existing?.event_id || hintedEventId || null;
  if (eventId) {
    const payable = await loadPayableEvent(eventId);
    if (!payable.error) {
      targetEvent = payable.event;
      expected = payable.price;
    }
  }

  const amountOk = Number.isFinite(amountNaira) && String(currency || 'NGN').toUpperCase() === 'NGN';
  const underpaid = !!targetEvent && (!amountOk || amountNaira + 0.01 < expected);
  const now = new Date().toISOString();
  const notes = underpaid
    ? `${source}: UNDERPAID or unreadable amount (paid ${amountNaira} ${currency}, expected ${expected} NGN). Needs admin review; no ticket issued.`
    : `Verified via ${source}`;

  let payment = existing;
  if (!existing) {
    const { data: inserted, error: insErr } = await supabase
      .from('payments')
      .insert([{
        user_id: userId,
        event_id: targetEvent ? targetEvent.id : null,
        amount: Number.isFinite(amountNaira) ? amountNaira : 0,
        payment_type: targetEvent ? 'event_registration' : 'other',
        transaction_id: reference,
        payment_proof_url: receiptUrlFor(reference),
        description: targetEvent ? `Online payment for event: ${targetEvent.title}` : `Online payment (${source})`,
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
        amount: Number.isFinite(amountNaira) ? amountNaira : existing.amount,
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

  if (targetEvent && payment.user_id && payment.status === 'verified') {
    const { ticketNumber, newlyIssued } = await issueEventTicket({ payment, event: targetEvent, userId: payment.user_id });
    if (newlyIssued) {
      await auditLog({
        action: 'webhook_payment_verified',
        userId: payment.user_id,
        details: { payment_id: payment.id, amount: payment.amount, reference, event_id: targetEvent.id, ticket_number: ticketNumber, source },
        ip: null
      });
    }
    return { action: newlyIssued ? 'ticket_issued' : 'already_issued', payment_id: payment.id, ticket_number: ticketNumber };
  }

  return { action: 'recorded', payment_id: payment.id, has_event: !!targetEvent, has_user: !!payment.user_id };
}

module.exports = router;
