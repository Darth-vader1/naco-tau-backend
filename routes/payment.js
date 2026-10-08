// routes/payments.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { successResponse, errorResponse, generateTransactionId } = require('../utils/helpers');
const { sendEventTicketEmail, sendPaymentAdminNotificationEmail } = require('../services/email');

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

    // If event_id is provided, confirm the target event actually exists.
    let resolvedEventId = null;
    if (event_id) {
      const { data: targetEvent, error: evErr } = await supabase
        .from('events')
        .select('id')
        .eq('id', event_id)
        .maybeSingle();

      if (evErr) throw evErr;
      if (!targetEvent) {
        return errorResponse(res, `Event ${event_id} does not exist.`, 400);
      }
      resolvedEventId = targetEvent.id;
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
// VERIFY PAYSTACK PAYMENT (Student instant verification)
// ============================================
router.post('/verify-paystack', authenticate, async (req, res) => {
  try {
    const { reference, event_id, payment_type = 'event_registration' } = req.body;

    if (!reference) {
      return errorResponse(res, 'Paystack transaction reference is required', 400);
    }

    if (payment_type === 'event_registration' && !event_id) {
      return errorResponse(res, 'event_id is required for event registration payments', 400);
    }

    // 1. Fetch Event Details if registering for an event
    let targetEvent = null;
    if (event_id) {
      const { data: event, error: eventErr } = await supabase
        .from('events')
        .select('*')
        .eq('id', event_id)
        .maybeSingle();

      if (eventErr) throw eventErr;
      if (!event) {
        return errorResponse(res, 'Target event not found', 404);
      }
      targetEvent = event;

      // Check capacity
      if (typeof targetEvent.max_attendees === 'number' && targetEvent.max_attendees > 0) {
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

    // 2. Prevent replay attacks: check if reference already exists for another user
    const { data: existingPayment, error: existingPayErr } = await supabase
      .from('payments')
      .select('*')
      .eq('transaction_id', reference)
      .maybeSingle();

    if (existingPayErr) throw existingPayErr;

    if (existingPayment && existingPayment.user_id !== req.userId) {
      return errorResponse(res, 'This payment reference is already associated with another account.', 403);
    }

    // 3. Verify with Paystack API
    const paystackSecret = process.env.PAYSTACK_SECRET_KEY;
    let verifiedPaystackData = null;

    if (paystackSecret && !paystackSecret.includes('placeholder')) {
      const verifyRes = await fetch(`https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`, {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${paystackSecret}`,
          'Content-Type': 'application/json'
        }
      });

      const verifyData = await verifyRes.json();

      if (!verifyRes.ok || !verifyData.status || verifyData.data?.status !== 'success') {
        const reason = verifyData.message || (verifyData.data && verifyData.data.gateway_response) || 'Payment verification failed on Paystack.';
        return errorResponse(res, `Paystack verification failed: ${reason}`, 400);
      }

      verifiedPaystackData = verifyData.data;

      // Validate payment amount (in kobo)
      if (targetEvent && targetEvent.requires_payment && Number(targetEvent.payment_amount) > 0) {
        const requiredKobo = Math.round(Number(targetEvent.payment_amount) * 100);
        if (verifiedPaystackData.amount < requiredKobo) {
          return errorResponse(
            res,
            `Amount paid (₦${(verifiedPaystackData.amount / 100).toLocaleString('en-NG')}) is less than required fee (₦${Number(targetEvent.payment_amount).toLocaleString('en-NG')}).`,
            400
          );
        }
      }
    } else {
      // Mock / Dev Fallback when secret key is not yet set
      console.warn(`[Paystack] PAYSTACK_SECRET_KEY not set or placeholder. Accepting test reference "${reference}" in dev mode.`);
      const simulatedAmount = targetEvent ? Number(targetEvent.payment_amount) * 100 : 0;
      verifiedPaystackData = {
        status: 'success',
        amount: simulatedAmount,
        currency: 'NGN',
        channel: 'card (test)',
        reference: reference,
        paid_at: new Date().toISOString()
      };
    }

    const paidAmount = verifiedPaystackData.amount ? verifiedPaystackData.amount / 100 : (targetEvent ? Number(targetEvent.payment_amount) : 0);

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
          payment_proof_url: `https://paystack.com/receipt/${encodeURIComponent(reference)}`,
          description: targetEvent ? `Online payment for event: ${targetEvent.title}` : `Paystack online payment`,
          event_id: targetEvent ? targetEvent.id : null,
          status: 'verified',
          verified_by: req.userId,
          verified_at: new Date().toISOString(),
          submitted_at: new Date().toISOString(),
          notes: `Verified via Paystack (${verifiedPaystackData.channel || 'online checkout'})`
        }])
        .select()
        .single();

      if (createPayErr) throw createPayErr;
      paymentRecord = newPayment;
    } else if (paymentRecord.status !== 'verified') {
      const { data: updatedPayment, error: updatePayErr } = await supabase
        .from('payments')
        .update({
          status: 'verified',
          verified_by: req.userId,
          verified_at: new Date().toISOString(),
          notes: `Verified via Paystack (${verifiedPaystackData.channel || 'online checkout'})`
        })
        .eq('id', paymentRecord.id)
        .select()
        .single();

      if (updatePayErr) throw updatePayErr;
      paymentRecord = updatedPayment;
    }

    // 5. If event registration, register student and generate ticket
    let registrationRecord = null;
    let ticketNumber = null;

    if (targetEvent) {
      ticketNumber = 'NACOS-' + targetEvent.id.substring(0, 4).toUpperCase() + '-' + Date.now().toString(36).toUpperCase();

      const { data: reg, error: regErr } = await supabase
        .from('event_registrations')
        .upsert([{
          event_id: targetEvent.id,
          user_id: req.userId,
          registration_date: new Date().toISOString(),
          status: 'registered',
          linked_payment_id: paymentRecord.id
        }], { onConflict: 'event_id,user_id' })
        .select()
        .single();

      if (regErr) {
        console.error('Event registration upsert error:', regErr);
        throw regErr;
      }
      registrationRecord = reg;

      // 6. Send Ticket & Admin Payment Alert Emails asynchronously
      (async () => {
        try {
          const { data: student } = await supabase
            .from('students')
            .select('*')
            .eq('user_id', req.userId)
            .maybeSingle();

          // A. Send ticket confirmation to student
          if (student && student.email) {
            await sendEventTicketEmail({
              student,
              event: targetEvent,
              ticketNumber,
              payment: paymentRecord
            });
          }

          // B. Send payment notification alert to nacos@tau.edu.ng
          await sendPaymentAdminNotificationEmail({
            student: student || { name: 'Student', email: req.userEmail || '' },
            event: targetEvent,
            payment: paymentRecord,
            ticketNumber
          });

          // C. Also sync to payment_verification table so admin dashboard displays it
          try {
            await supabase
              .from('payment_verification')
              .insert([{
                student_id: student?.id || null,
                event_id: targetEvent.id,
                amount: paidAmount,
                payment_reference: reference,
                status: 'verified',
                created_at: new Date().toISOString()
              }]);
          } catch (pvErr) {
            console.warn('payment_verification sync notice:', pvErr?.message || pvErr);
          }

        } catch (emailErr) {
          console.error('Ticket/Admin email dispatch error:', emailErr);
        }
      })();
    }

    // 7. Audit log
    await auditLog({
      action: 'paystack_payment_verified',
      userId: req.userId,
      details: {
        payment_id: paymentRecord.id,
        amount: paidAmount,
        reference: reference,
        event_id: targetEvent ? targetEvent.id : null,
        ticket_number: ticketNumber
      },
      ip: req.ip
    });

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
    console.error('Paystack verification error:', error);
    return errorResponse(res, error.message || 'Failed to verify Paystack payment', 500, error);
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
      .select(`
        *,
        students:user_id (
          name,
          email,
          matric_no,
          department
        )
      `, { count: 'exact' });

    if (status) query = query.eq('status', status);
    if (payment_type) query = query.eq('payment_type', payment_type);

    const { data, error, count } = await query
      .range(offset, offset + limit - 1)
      .order('submitted_at', { ascending: false });

    if (error) throw error;

    return successResponse(res, {
      payments: data,
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
      .select('id, status, user_id')
      .eq('id', id)
      .maybeSingle();

    if (existingErr) throw existingErr;
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
      .select(`
        *,
        students:user_id (
          name,
          email,
          matric_no
        )
      `)
      .single();

    if (error) {
      if (error.code === 'PGRST116') {
        return errorResponse(res, 'Payment record not found', 404);
      }
      throw error;
    }

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

module.exports = router;
