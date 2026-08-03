// middleware/auth.js
const { supabase } = require('../config/supabase');
const { isAdminEmailAllowed, getPrimaryAdminEmail } = require('../utils/helpers');

/**
 * Upsert a row into admin_users so requireAdmin/super_admin gates can pass.
 *
 * The project spec (ADMIN_EMAILS env var drives admin grants, first entry =
 * super_admin) requires any email listed there to receive its role row
 * automatically on first login. Without this auto-seed, requireAdmin always
 * fails for newly-authorized admin emails even though Supabase Auth itself
 * accepted their login.
 */
const ensureAdminRoleRow = async (userId, email) => {
  if (!userId || !email) return null;
  const allowed = isAdminEmailAllowed(email);
  if (!allowed) return null;
  const role = (email.trim().toLowerCase() === (getPrimaryAdminEmail() || '').toLowerCase())
    ? 'super_admin'
    : 'admin';
  try {
    const { data: existing } = await supabase
      .from('admin_users')
      .select('user_id, role')
      .eq('user_id', userId)
      .maybeSingle();
    if (existing) {
      if (existing.role !== role && role === 'super_admin') {
        await supabase.from('admin_users').update({ role }).eq('user_id', userId);
        return role;
      }
      return existing.role;
    }
    const { error } = await supabase
      .from('admin_users')
      .insert([{ user_id: userId, email: email.toLowerCase().trim(), role }]);
    if (error) {
      console.warn('[auth.js] ensureAdminRoleRow upsert failed:', error.message);
      return null;
    }
    return role;
  } catch (e) {
    console.warn('[auth.js] ensureAdminRoleRow raised:', e.message);
    return null;
  }
};

/**
 * Read the JWT access token from either:
 *   1. Authorization: Bearer <token>  header (frontend API calls via fetch)
 *   2. The "sb-access-token" cookie (legacy browser GoTrue session cookie)
 *   3. The "sb:access-token" cookie (v2 SDK cookie naming variant with
 *      colon as separator — not always sent, check both).
 *
 * Returns the token string or null.
 */
function extractToken(req) {
  const authHeader = req.headers && req.headers.authorization;
  if (typeof authHeader === 'string' && authHeader.slice(0, 7).toLowerCase() === 'bearer ') {
    const t = authHeader.slice(7).trim();
    if (t) return t;
  }
  const cookies = req.cookies || {};
  const cookie1 = cookies['sb-access-token'];
  if (typeof cookie1 === 'string' && cookie1.length) return cookie1;
  const cookie2 = cookies['sb:access-token'];
  if (typeof cookie2 === 'string' && cookie2.length) return cookie2;
  // Also check for raw Cookie header via req.headers.cookie fallback
  if (!cookie1 && !cookie2 && req.headers && typeof req.headers.cookie === 'string') {
    const raw = req.headers.cookie;
    const m1 = raw.match(/(?:^|;\s*)sb-access-token=([^;]+)/i);
    if (m1 && m1[1]) return decodeURIComponent(m1[1]);
    const m2 = raw.match(/(?:^|;\s*)sb:access-token=([^;]+)/i);
    if (m2 && m2[1]) return decodeURIComponent(m2[1]);
  }
  return null;
}

/**
 * Verify a JWT via the auth-admin API (preferred on server).
 * The service_role key allows `auth.admin.getUser(jwt)` to verify the
 * signature locally via HS256, then enrich with the Supabase Auth row data
 * without a round-trip to GoTrue's /userinfo HTTP endpoint.
 *
 * Fall back to `auth.getUser(token)` (HTTP round-trip to /userinfo) if the
 * admin method throws an unusual error.
 *
 * Returns { user: {...} } on success, or null/falsy on failure.
 */
async function verifyJwt(token) {
  if (!token || typeof token !== 'string') return null;
  // Try admin-level verify first: this avoids GoTrue /userinfo HTTP call and
  // is far more reliable (no rate-limit, no cross-region latency, no
  // "session not found" style errors for a valid JWT).
  try {
    if (supabase.auth && typeof supabase.auth.admin === 'object' && supabase.auth.admin && typeof supabase.auth.admin.getUser === 'function') {
      const { data, error } = await supabase.auth.admin.getUser(token);
      if (!error && data && data.user) return { user: data.user, method: 'auth.admin.getUser' };
      if (error) {
        console.warn('[auth] auth.admin.getUser(token) returned error:', JSON.stringify({
          msg: error.message, code: error.code, status: error.status
        }));
      }
    }
  } catch (e) {
    console.warn('[auth] auth.admin.getUser(token) threw; falling back to auth.getUser(token):', e.message);
  }

  try {
    const { data, error } = await supabase.auth.getUser(token);
    if (!error && data && data.user) return { user: data.user, method: 'auth.getUser' };
    if (error) {
      console.warn('[auth] auth.getUser(token) returned error:', JSON.stringify({
        msg: error.message, code: error.code, status: error.status
      }));
    }
    return null;
  } catch (e) {
    console.warn('[auth] auth.getUser(token) threw:', e.message);
    return null;
  }
}

/**
 * Authentication middleware
 * Verifies JWT token from Authorization header OR session cookies,
 * enforces student ban/reject status, auto-seeds admin_users rows for
 * ADMIN_EMAILS-list emails, and attaches req.user / req.userId / req.userRole.
 */
const authenticate = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (!token) {
      return res.status(401).json({
        error: 'Authentication required. Please provide a valid Bearer token in the Authorization header or an authenticated session cookie.'
      });
    }

    const verified = await verifyJwt(token);
    const user = verified?.user;

    if (!user) {
      console.error('[auth] Token verification failed for route:', req.method, req.originalUrl);
      return res.status(401).json({
        error: 'Invalid or expired token. Please log in again and refresh the page if necessary.'
      });
    }

    // Check if user is banned, rejected, or inactive
    const { data: userStatus, error: statusError } = await supabase
      .from('students')
      .select('status')
      .eq('user_id', user.id)
      .single();

    if (statusError && statusError.code !== 'PGRST116') {
      console.error('Status check error:', statusError);
    }

    if (userStatus?.status === 'banned') {
      return res.status(403).json({
        error: 'Your account has been suspended. Please contact support.'
      });
    }

    if (userStatus?.status === 'rejected') {
      return res.status(403).json({
        error: 'Your account registration was rejected. Please contact support for assistance.'
      });
    }

    // Attach user to request object
    req.user = user;
    req.userId = user.id;

    // Auto-seed admin role row BEFORE reading it, so allow-listed emails
    // pass the requireAdmin gate on their very first login.
    await ensureAdminRoleRow(user.id, user.email);

    // Get user role from database
    const { data: roleData } = await supabase
      .from('admin_users')
      .select('role')
      .eq('user_id', user.id)
      .maybeSingle();

    req.userRole = roleData?.role || 'student';

    next();
  } catch (error) {
    console.error('[auth] Auth middleware error for ', req.method, req.originalUrl, ':', error);
    res.status(500).json({
      error: 'Authentication failed. Please try again.'
    });
  }
};

/**
 * Admin authorization middleware
 * Requires user to have admin role
 */
const requireAdmin = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      error: 'Authentication required'
    });
  }

  if (req.userRole !== 'admin' && req.userRole !== 'super_admin') {
    return res.status(403).json({
      error: 'Access denied. Admin privileges required.'
    });
  }

  next();
};

/**
 * Super Admin authorization middleware
 * Requires user to have super_admin role
 */
const requireSuperAdmin = async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({
      error: 'Authentication required'
    });
  }

  if (req.userRole !== 'super_admin') {
    return res.status(403).json({
      error: 'Access denied. Super Admin privileges required.'
    });
  }

  next();
};

/**
 * Optional authentication (doesn't require token)
 * Accepts both Bearer header and session cookies for consistency with authenticate.
 */
const optionalAuth = async (req, res, next) => {
  try {
    const token = extractToken(req);
    if (token) {
      const verified = await verifyJwt(token);
      if (verified && verified.user) {
        req.user = verified.user;
        req.userId = verified.user.id;
      }
    }
    next();
  } catch (error) {
    next();
  }
};

module.exports = {
  authenticate,
  requireAdmin,
  requireSuperAdmin,
  optionalAuth
};
