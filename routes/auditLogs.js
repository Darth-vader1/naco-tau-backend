// routes/auditLogs.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');

// ============================================
// GET AUDIT LOGS (Admin Only)
// ============================================
router.get('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const {
      page = 1,
      limit = 50,
      action,
      user_email,
      user_id,
      start_date,
      end_date,
      ip_address,
      search,
      sort = 'timestamp-desc'
    } = req.query;

    // Parse pagination
    const pageNum = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 200); // Max 200 per page
    const offset = (pageNum - 1) * limitNum;

    // Start building query
    let query = supabase
      .from('audit_logs')
      .select('*', { count: 'exact' });

    // Apply filters
    if (action && action !== 'all') {
      query = query.eq('action', action);
    }

    if (user_email) {
      query = query.ilike('user_email', `%${user_email}%`);
    }

    if (user_id) {
      query = query.eq('user_id', user_id);
    }

    if (ip_address) {
      query = query.eq('ip_address', ip_address);
    }

    if (start_date) {
      query = query.gte('timestamp', start_date);
    }

    if (end_date) {
      query = query.lte('timestamp', end_date);
    }

    // Search across action and user_email
    if (search && search.trim()) {
      query = query.or(`action.ilike.%${search.trim()}%,user_email.ilike.%${search.trim()}%`);
    }

    // Apply sorting
    const [sortField, sortOrder] = sort.split('-');
    const ascending = sortOrder === 'asc';
    
    if (sortField === 'timestamp') {
      query = query.order('timestamp', { ascending });
    } else if (sortField === 'action') {
      query = query.order('action', { ascending });
    } else if (sortField === 'user') {
      query = query.order('user_email', { ascending, nullsFirst: false });
    } else {
      query = query.order('timestamp', { ascending: false }); // Default
    }

    // Apply pagination
    query = query.range(offset, offset + limitNum - 1);

    // Execute query
    const { data, error, count } = await query;

    if (error) throw error;

    // Calculate pagination metadata
    const totalPages = Math.ceil(count / limitNum);

    return successResponse(res, {
      logs: data || [],
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count,
        totalPages,
        hasMore: pageNum < totalPages
      }
    }, 'Audit logs retrieved successfully');

  } catch (error) {
    console.error('Audit logs fetch error:', error);
    return errorResponse(res, 'Failed to fetch audit logs', 500, error);
  }
});

// ============================================
// GET AUDIT LOG STATISTICS (Admin Only)
// ============================================
router.get('/stats', authenticate, requireAdmin, async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    // Build base query
    let query = supabase.from('audit_logs').select('action, user_id, timestamp');

    if (start_date) {
      query = query.gte('timestamp', start_date);
    }

    if (end_date) {
      query = query.lte('timestamp', end_date);
    }

    const { data, error } = await query;

    if (error) throw error;

    const now = new Date();
    const dayAgo = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

    // Calculate statistics
    const stats = {
      totalLogs: data.length,
      uniqueUsers: new Set(data.filter(log => log.user_id).map(log => log.user_id)).size,
      last24: 0,
      last7: 0,
      actionBreakdown: {},
      recentActivity: []
    };

    // Count actions and relative time
    data.forEach(log => {
      stats.actionBreakdown[log.action] = (stats.actionBreakdown[log.action] || 0) + 1;
      const timestamp = new Date(log.timestamp);
      if (timestamp >= dayAgo) stats.last24 += 1;
      if (timestamp >= weekAgo) stats.last7 += 1;
    });

    // Get top 10 actions
    const topActions = Object.entries(stats.actionBreakdown)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([action, count]) => ({ action, count }));

    return successResponse(res, {
      ...stats,
      topActions
    }, 'Audit log statistics retrieved successfully');

  } catch (error) {
    console.error('Audit stats error:', error);
    return errorResponse(res, 'Failed to fetch audit statistics', 500, error);
  }
});

// ============================================
// GET UNIQUE ACTIONS (for filter dropdown)
// ============================================
router.get('/actions', authenticate, requireAdmin, async (req, res) => {
  try {
    const { data, error } = await supabase
      .from('audit_logs')
      .select('action')
      .order('action');

    if (error) throw error;

    // Get unique actions
    const uniqueActions = [...new Set(data.map(log => log.action))].sort();

    return successResponse(res, uniqueActions, 'Unique actions retrieved successfully');

  } catch (error) {
    console.error('Unique actions fetch error:', error);
    return errorResponse(res, 'Failed to fetch unique actions', 500, error);
  }
});

module.exports = router;
