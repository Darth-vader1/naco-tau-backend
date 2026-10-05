// middleware/auth.js
const crypto = require('crypto');
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
const ensureAdminRoleRow = async (userId, email, emailConfirmed = false) => {
  if (!userId || !email) return null;
  const allowed = isAdminEmailAllowed(email);
  if (!allowed) return null;
  // SECURITY: never auto-grant admin to an account whose email isn't confirmed.
  if (!emailConfirmed) return null;
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

// ============================================
// AUTH CONTEXT CACHE
// One lookup per token per TTL instead of Auth + 3 DB queries per request.
// Trade-off: role changes and bans take effect within AUTH_CACHE_TTL_MS.
// ============================================
const AUTH_CACHE_TTL_MS = Math.max(0, parseInt(process.env.AUTH_CACHE_TTL_MS || '30000', 10));
const AUTH_NEGATIVE_TTL_MS = 10 * 1000;
const AUTH_CACHE_MAX_ENTRIES = 5000;
const authCache = new Map();     // tokenHash -> { exp, invalid?, user, status, role }
const authInflight = new Map();  // tokenHash -> Promise (de-duplicates concurrent lookups)

const tokenKey = (token) => crypto.createHash('sha256').update(token).digest('hex');

function authCacheSet(key, value, ttlMs) {
  if (ttlMs <= 0) return;
  if (authCache.size >= AUTH_CACHE_MAX_ENTRIES) {
    // Map preserves insertion order: evict the oldest entry.
    authCache.delete(authCache.keys().next().value);
  }
  authCache.set(key, { ...value, exp: Date.now() + ttlMs });
}

/** Drop a token from the cache (call on logout). */
function invalidateAuthCache(token) {
  if (token) authCache.delete(tokenKey(token));
}

/** Uncached resolution: verify JWT, then load student status and admin role in parallel. */
async function loadAuthContext(token) {
  const verified = await verifyJwt(token);
  const user = verified?.user;
  if (!user) return { invalid: true };

  const emailConfirmed = !!(user.email_confirmed_at || user.confirmed_at);

  // Auto-seed admin row (allow-listed + confirmed emails only), else read the role.
  const rolePromise = (async () => {
    const seeded = await ensureAdminRoleRow(user.id, user.email, emailConfirmed);
    if (seeded) return seeded;
    const { data } = await supabase
      .from('admin_users')
      .select('role')
      .eq('user_id', user.id)
      .maybeSingle();
    return data?.role || null;
  })();

  const statusPromise = supabase
    .from('students')
    .select('status')
    .eq('user_id', user.id)
    .maybeSingle();

  const [role, statusResult] = await Promise.all([rolePromise, statusPromise]);

  if (statusResult.error) {
    // Fail closed: if we can't confirm the account isn't banned, don't let the
    // request through (and don't cache this result).
    throw new Error(`Status check failed: ${statusResult.error.message}`);
  }

  return { invalid: false, user, status: statusResult.data?.status || null, role };
}

/**
 * Resolve { user, status, role } for a token, using the TTL cache.
 * Returns { invalid: true } for bad tokens. Throws on infrastructure errors.
 */
async function getAuthContext(token) {
  const key = tokenKey(token);
  const hit = authCache.get(key);
  if (hit) {
    if (hit.exp > Date.now()) return hit;
    authCache.delete(key);
  }

  if (authInflight.has(key)) return authInflight.get(key);

  const promise = (async () => {
    try {
      const ctx = await loadAuthContext(token);
      authCacheSet(key, ctx, ctx.invalid ? AUTH_NEGATIVE_TTL_MS : AUTH_CACHE_TTL_MS);
      return ctx;
    } finally {
      authInflight.delete(key);
    }
  })();

  authInflight.set(key, promise);
  return promise;
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

    const ctx = await getAuthContext(token);

    if (ctx.invalid) {
      console.error('[auth] Token verification failed for route:', req.method, req.originalUrl);
      return res.status(401).json({
        error: 'Invalid or expired token. Please log in again and refresh the page if necessary.'
      });
    }

    // Banned / rejected accounts are blocked on every request (status comes
    // from the short-TTL cache, so a ban takes effect within AUTH_CACHE_TTL_MS).
    if (ctx.status === 'banned') {
      return res.status(403).json({
        error: 'Your account has been suspended. Please contact support.'
      });
    }

    if (ctx.status === 'rejected') {
      return res.status(403).json({
        error: 'Your account registration was rejected. Please contact support for assistance.'
      });
    }

    // Attach user to request object
    req.user = ctx.user;
    req.userId = ctx.user.id;
    req.userRole = ctx.role || 'student';

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
      const ctx = await getAuthContext(token);
      if (ctx && !ctx.invalid && ctx.user) {
        req.user = ctx.user;
        req.userId = ctx.user.id;
        req.userRole = ctx.role || 'student';
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
  optionalAuth,
  extractToken,
  invalidateAuthCache
};
