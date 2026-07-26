// routes/payments.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { auditLog } = require('../middleware/audit');

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
      return res.status(400).json({
        error: 'Amount, payment type, and proof are required'
      });
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

    res.status(201).json({
      success: true,
      message: 'Payment submitted for verification',
      payment: data
    });

  } catch (error) {
    console.error('Payment submission error:', error);
    res.status(500).json({
      error: 'Failed to submit payment'
    });
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

    res.json(data || []);
  } catch (error) {
    console.error('Payments fetch error:', error);
    res.status(500).json({
      error: 'Failed to fetch payments'
    });
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

    res.json({
      payments: data,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total: count,
        pages: Math.ceil(count / limit)
      }
    });
  } catch (error) {
    console.error('Payments fetch error:', error);
    res.status(500).json({
      error: 'Failed to fetch payments'
    });
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
      return res.status(400).json({
        error: 'Invalid status. Use "verified" or "rejected".'
      });
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
        return res.status(404).json({
          error: 'Payment record not found'
        });
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

    res.json({
      success: true,
      message: `Payment ${status} successfully`,
      payment: data
    });

  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).json({
      error: 'Failed to verify payment'
    });
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

    res.json({
      total_payments: totalCount || 0,
      total_amount: totalAmount || 0,
      verified_amount: verifiedAmount || 0,
      pending_count: pendingCount || 0,
      verified_count: verifiedData?.length || 0
    });

  } catch (error) {
    console.error('Payment stats error:', error);
    res.status(500).json({
      error: 'Failed to fetch payment statistics'
    });
  }
});

module.exports = router;