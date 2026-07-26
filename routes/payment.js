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
router.post('/submit', authenticate, async (req, res) => {
  try {
    const {
      amount,
      payment_type,
      transaction_id,
      payment_proof_url,
      description
    } = req.body;

    if (!amount || !payment_type || !payment_proof_url) {
      return errorResponse(res, 'Amount, payment type, and proof are required', 400);
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
        type: data.payment_type
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
        status: status
      },
      ip: req.ip
    });

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
