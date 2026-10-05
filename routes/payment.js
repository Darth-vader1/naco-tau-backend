// routes/payments.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { successResponse, errorResponse, generateTransactionId } = require('../utils/helpers');

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
