// routes/auditLogs.js
const express = require('express');
const router = express.Router();
const { supabase } = require('../config/supabase');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { successResponse, errorResponse } = require('../utils/helpers');

// ============================================
// SYSTEM TRAFFIC (hidden by default)
// ============================================
// Rows written before the audit middleware stopped recording server traffic:
// monitoring pings (HEAD /), dashboard housekeeping (bucket checks), session
// plumbing and unmatched-route probes. They stay in the table (audit rows are
// never deleted) but are hidden unless the admin asks for system traffic.
//
// Note: in PostgREST "like" patterns "*" is a wildcard, so the literal
// "auto_GET_*" action is excluded with an exact-match filter instead.
const SYSTEM_LIKE_PATTERNS = [
  'auto_HEAD%',
  'auto_OPTIONS%',
  '%ensure-buckets%',
  '%ensure-one%',
  '%session-status%',
  'auto_POST_refresh%',
  'auto_GET_verify%',
  'storage_bucket_check%'
];
const SYSTEM_EXACT = ['auto_GET_*', 'auto_GET_root', 'auto_HEAD_root'];

function excludeSystem(query) {
  let q = query;
  for (const pattern of SYSTEM_LIKE_PATTERNS) q = q.not('action', 'like', pattern);
  for (const exact of SYSTEM_EXACT) q = q.neq('action', exact);
  return q;
}

const wantsSystem = (req) => String(req.query.include_system || '').toLowerCase() === 'true';

// Characters with meaning inside PostgREST filter strings; stripped from free-text search.
const cleanSearch = (s) => String(s || '').replace(/[,()*%\\":]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100);

// Accept "YYYY-MM-DD" (whole day, inclusive) or a full ISO timestamp.
const startOf = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T00:00:00.000Z` : d);
const endOf = (d) => (/^\d{4}-\d{2}-\d{2}$/.test(d) ? `${d}T23:59:59.999Z` : d);

/** Apply the filters shared by the list, stats and export views. */
function applyFilters(query, req, { includeSearch = true } = {}) {
  const { action, user_email, user_id, start_date, end_date, ip_address, search } = req.query;
  let q = query;
  if (!wantsSystem(req)) q = excludeSystem(q);
  if (action && action !== 'all') q = q.eq('action', action);
  if (user_email) q = q.ilike('user_email', `%${cleanSearch(user_email)}%`);
  if (user_id) q = q.eq('user_id', user_id);
  if (ip_address) q = q.eq('ip_address', ip_address);
  if (start_date) q = q.gte('timestamp', startOf(start_date));
  if (end_date) q = q.lte('timestamp', endOf(end_date));
  if (includeSearch && search) {
    const term = cleanSearch(search);
    if (term) q = q.or(`action.ilike.%${term}%,user_email.ilike.%${term}%`);
  }
  return q;
}

/** Exact row count for a filtered query (no rows transferred). */
async function countRows(build) {
  const { count, error } = await build(supabase.from('audit_logs').select('id', { count: 'exact', head: true }));
  if (error) throw error;
  return count || 0;
}

/**
 * Read rows in pages (the database returns at most 1,000 rows per request).
 * Newest first, capped at `max` rows.
 */
async function readAll(build, columns, max = 20000) {
  const PAGE = 1000;
  const rows = [];
  for (let from = 0; from < max; from += PAGE) {
    const { data, error } = await build(supabase.from('audit_logs').select(columns))
      .order('timestamp', { ascending: false })
      .range(from, Math.min(from + PAGE, max) - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return rows;
}

// ============================================
// GET AUDIT LOGS (Admin Only)
// ============================================
router.get('/', authenticate, requireAdmin, async (req, res) => {
  try {
    const { page = 1, limit = 50, sort = 'timestamp-desc' } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(Math.max(1, parseInt(limit, 10) || 50), 500);
    const offset = (pageNum - 1) * limitNum;

    let query = applyFilters(supabase.from('audit_logs').select('*', { count: 'exact' }), req);

    const [sortField, sortOrder] = String(sort).split('-');
    const ascending = sortOrder === 'asc';
    if (sortField === 'action') {
      query = query.order('action', { ascending }).order('timestamp', { ascending: false });
    } else if (sortField === 'user') {
      query = query.order('user_email', { ascending, nullsFirst: false }).order('timestamp', { ascending: false });
    } else {
      query = query.order('timestamp', { ascending });
    }

    const { data, error, count } = await query.range(offset, offset + limitNum - 1);
    if (error) throw error;

    const total = count || 0;
    const totalPages = Math.max(1, Math.ceil(total / limitNum));
    return successResponse(res, {
      logs: data || [],
      pagination: { page: pageNum, limit: limitNum, total, totalPages, hasMore: pageNum < totalPages }
    }, 'Audit logs retrieved successfully');
  } catch (error) {
    console.error('Audit logs fetch error:', error);
    return errorResponse(res, 'Failed to fetch audit logs', 500, error);
  }
});

// ============================================
// GET AUDIT LOG STATISTICS (Admin Only)
// ============================================
// Counts are exact (database counts, not a capped sample). Top actions and
// unique actors are computed over the selected period (default: last 30 days).
router.get('/stats', authenticate, requireAdmin, async (req, res) => {
  try {
    const now = Date.now();
    const dayAgo = new Date(now - 24 * 60 * 60 * 1000).toISOString();
    const weekAgo = new Date(now - 7 * 24 * 60 * 60 * 1000).toISOString();

    const base = (q) => applyFilters(q, req, { includeSearch: false });

    const [totalLogs, last24, last7] = await Promise.all([
      countRows(base),
      countRows(q => base(q).gte('timestamp', dayAgo)),
      countRows(q => base(q).gte('timestamp', weekAgo))
    ]);

    // Breakdown window: the selected dates, or the last 30 days by default.
    const windowStart = req.query.start_date ? null : new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    const rows = await readAll(
      q => (windowStart ? base(q).gte('timestamp', windowStart) : base(q)),
      'action, user_id, user_email'
    );

    const actionBreakdown = {};
    const actors = new Set();
    for (const r of rows) {
      actionBreakdown[r.action] = (actionBreakdown[r.action] || 0) + 1;
      const actor = r.user_id || r.user_email;
      if (actor) actors.add(actor);
    }
    const topActions = Object.entries(actionBreakdown)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([action, count]) => ({ action, count }));

    return successResponse(res, {
      totalLogs,
      last24,
      last7,
      uniqueUsers: actors.size,
      topActions,
      period: windowStart ? 'last_30_days' : 'selected_dates',
      includesSystemTraffic: wantsSystem(req)
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
    const rows = await readAll(q => (wantsSystem(req) ? q : excludeSystem(q)), 'action', 50000);
    const uniqueActions = [...new Set(rows.map(r => r.action))].sort();
    return successResponse(res, uniqueActions, 'Unique actions retrieved successfully');
  } catch (error) {
    console.error('Unique actions fetch error:', error);
    return errorResponse(res, 'Failed to fetch unique actions', 500, error);
  }
});

module.exports = router;
