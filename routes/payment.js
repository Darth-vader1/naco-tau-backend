// routes/payments.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');
const { successResponse, errorResponse } = require('../utils/helpers');

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
        amount: parseFloat(amount),
        payment_type,
        transaction_id: transaction_id || `NACOS-${Date.now()}`,
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
    const { 
      page = 1, 
      limit = 20, 
      status,
      payment_type 
    } = req.query;
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

    const { data, error } = await supabase
      .from('payments')
      .update({
        status: status,
        verified_by: req.userId,
        verified_at: new Date().toISOString(),
        notes: notes || null
      })
      .eq('id', id)
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
        student: data.students.name,
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
        return errorResponse(
          res,
          `Payment ${status}, but automatic event registration could not be synced. Please register the student manually.`,
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
    // Get total payments
    const { data: totalData, error: totalError } = await supabase
      .from('payments')
      .select('amount', { count: 'exact' });

    if (totalError) throw totalError;

    const totalAmount = totalData.reduce((sum, p) => sum + p.amount, 0);

    // Get verified payments
    const { data: verifiedData, error: verifiedError } = await supabase
      .from('payments')
      .select('amount')
      .eq('status', 'verified');

    if (verifiedError) throw verifiedError;

    const verifiedAmount = verifiedData.reduce((sum, p) => sum + p.amount, 0);

    // Get pending count
    const { count: pendingCount, error: pendingError } = await supabase
      .from('payments')
      .select('*', { count: 'exact', head: true })
      .eq('status', 'pending');

    if (pendingError) throw pendingError;

    // Get total count
    const { count: totalCount, error: countError } = await supabase
      .from('payments')
      .select('*', { count: 'exact', head: true });

    if (countError) throw countError;

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
