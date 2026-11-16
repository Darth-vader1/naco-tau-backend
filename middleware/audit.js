// backend/middleware/audit.js
const { supabase } = require('../config/supabase');

/**
 * Audit logging middleware
 * Logs all admin actions for security and compliance
 */
const auditLog = async ({
    action,
    userId,
    userEmail,
    details = {},
    ip = null,
    userAgent = null
}) => {
    try {
        // Don't log in test environment
        if (process.env.NODE_ENV === 'test') return;

        const logEntry = {
            action,
            user_id: userId || null,
            user_email: userEmail || null,
            details: details,
            ip_address: ip,
            user_agent: userAgent,
            timestamp: new Date().toISOString()
        };

        // Insert into audit_logs table
        const { error } = await supabase
            .from('audit_logs')
            .insert([logEntry]);

        if (error) {
            console.error('❌ Audit log error:', error);
        }

    } catch (error) {
        console.error('❌ Audit logging failed:', error);
    }
};

// ============================================
// WHAT GOES INTO THE AUDIT TRAIL
// ============================================
// The audit trail records actions people take (and their outcome), not
// server traffic. Monitoring pings, CORS preflights, token refreshes and
// dashboard housekeeping are excluded; they belong in the request logs.

// Request patterns that are never audit events (matched on method + full path).
const AUDIT_NOISE = [
    { methods: ['HEAD', 'OPTIONS'] },                              // monitors, CORS preflight
    { path: /^\/api\/health/ },
    { path: /^\/api\/storage\/ensure-(buckets|one)/ },             // admin dashboard housekeeping
    { path: /^\/api\/storage\/status/ },
    { path: /^\/api\/auth\/(session-status|refresh|verify)/ },     // session plumbing
    { path: /^\/api\/analytics\/track/ },                          // page-view analytics has its own table
    { path: /^\/(assets|frontend|vendor)\// }
];

// Actions already written explicitly by route handlers (avoid duplicate rows).
const EXPLICITLY_AUDITED = [
    { method: 'POST', path: /^\/api\/auth\/(register|login|admin\/login|logout|forgot-password)$/ },
    { method: 'POST', path: /^\/api\/payments\/(submit|verify-paystack|guest-verify|[^/]+\/recheck|[^/]+\/gateway-recheck|webhook)$/ },
    { method: 'PUT', path: /^\/api\/payments\/[^/]+\/verify$/ }
];

/** "admin" | "student" | "guest" (no login) */
function actorTypeOf(req) {
    if (req.user || req.userId) {
        return (req.userRole === 'admin' || req.userRole === 'super_admin') ? 'admin' : 'student';
    }
    return 'guest';
}

/** A short human-readable name for the record a request acted on. */
function titleOf(body) {
    if (!body || typeof body !== 'object') return '';
    const t = body.title || body.name || body.course_code || body.event_title || '';
    return typeof t === 'string' ? t.slice(0, 80) : '';
}

/**
 * Decide whether a finished request is an audit event and, if so, describe it.
 * Returns { action, target } or null to skip.
 */
function describeRequestForAudit(req, statusCode) {
    const method = req.method;
    const fullPath = (req.originalUrl || '').split('?')[0];

    for (const rule of AUDIT_NOISE) {
        if (rule.methods && rule.methods.includes(method)) return null;
        if (rule.path && rule.path.test(fullPath)) return null;
    }
    for (const rule of EXPLICITLY_AUDITED) {
        if (rule.method === method && rule.path.test(fullPath)) return null;
    }

    // Unmatched routes (404 from scanners/bots) are noise; honeypots log real probes.
    if (!req.route) return null;

    // Plain reads are only audited for admin data access (PII, exports).
    const isAdminArea = /\/admin(\/|$)|\/export\b|\/audit-logs|\/students(\/|$)/.test(fullPath);
    if (method === 'GET' && statusCode < 400 && !isAdminArea) return null;

    // Admin generic table writes: /api/admin/:table[/:id]
    const adminTable = fullPath.match(/^\/api\/admin\/([a-z_]+)(?:\/([^/]+))?(?:\/(batch-update))?$/);
    if (adminTable) {
        const [, table, id, batch] = adminTable;
        const verb = batch ? 'batch_update' : ({ POST: 'create', PUT: 'update', PATCH: 'update', DELETE: 'delete' }[method] || method.toLowerCase());
        const title = titleOf(req.body);
        const target = [table.replace(/_/g, ' '), title ? `"${title}"` : '', id && !batch ? `#${String(id).slice(0, 8)}` : '']
            .filter(Boolean).join(' ');
        return { action: `admin_${verb}_${table}`, target };
    }

    // Everything else: name it after the route pattern, e.g. "post_api_events_id_register"
    const routePattern = `${req.baseUrl || ''}${req.route.path || ''}`;
    const action = `${method}_${routePattern}`
        .toLowerCase()
        .replace(/[:*?]/g, '')
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 80);

    const idParam = req.params && (req.params.id || req.params.idOrSlug || req.params.subId);
    const title = titleOf(req.body);
    const target = [title ? `"${title}"` : '', idParam ? `#${String(idParam).slice(0, 8)}` : ''].filter(Boolean).join(' ');
    return { action, target };
}

/**
 * Middleware to log API requests
 * - Hooks res.send() to log AFTER response status is determined
 * - Does NOT log already-explicitly-audited actions (to avoid duplicate audit rows)
 * - Logs are recorded into audit_logs table with responseTime, path, method, status
 */
const auditMiddleware = (req, res, next) => {
    // Ensure request start time is tracked
    req._startTime = req._startTime || Date.now();

    // Store original send function
    const originalSend = res.send;

    // Override send to log after response
    res.send = function(data) {
        const statusCode = res.statusCode;

        // Only log if status is 2xx-4xx (5xx errors are logged separately)
        if (statusCode >= 200 && statusCode < 500) {
            const described = describeRequestForAudit(req, statusCode);

            if (described) {
                const userId = req.user?.id || req.userId || null;
                const userEmail = req.user?.email || null;
                const method = req.method;

                auditLog({
                    action: described.action,
                    userId,
                    userEmail,
                    details: {
                        target: described.target || undefined,
                        outcome: statusCode < 400 ? 'success' : 'failure',
                        actor_type: actorTypeOf(req),
                        method,
                        path: req.originalUrl,
                        query: Object.keys(req.query || {}).length ? req.query : undefined,
                        body: (method === 'GET' || method === 'DELETE') ? undefined :
                            Object.keys(req.body || {}).length
                                ? redactSecrets(req.body)
                                : undefined,
                        statusCode,
                        responseTime: Date.now() - req._startTime
                    },
                    ip: req.ip,
                    userAgent: req.headers['user-agent']
                }).catch(err => console.error('[auditMiddleware] audit log error:', err.message));
            }
        }

        return originalSend.call(this, data);
    };

    next();
};

/**
 * Remove known sensitive fields from logged body (never write passwords to DB)
 */
function redactSecrets(body) {
    if (!body || typeof body !== 'object') return body;
    const safe = { ...body };
    for (const key of Object.keys(safe)) {
        if (/password|secret|token|proof/i.test(key)) {
            safe[key] = '[REDACTED]';
        } else if (typeof safe[key] === 'object' && safe[key] !== null && !Array.isArray(safe[key])) {
            safe[key] = redactSecrets(safe[key]);
        }
    }
    return safe;
}

/**
 * Log user login
 */
const logLogin = async (req, user) => {
    await auditLog({
        action: 'user_login',
        userId: user.id,
        userEmail: user.email,
        details: {
            method: 'password',
            ip: req.ip,
            userAgent: req.headers['user-agent']
        },
        ip: req.ip,
        userAgent: req.headers['user-agent']
    });
};

/**
 * Log user logout
 */
const logLogout = async (req, user) => {
    await auditLog({
        action: 'user_logout',
        userId: user.id,
        userEmail: user.email,
        details: {
            ip: req.ip,
            userAgent: req.headers['user-agent']
        },
        ip: req.ip,
        userAgent: req.headers['user-agent']
    });
};

/**
 * Log admin actions
 */
const logAdminAction = async (req, action, details = {}) => {
    await auditLog({
        action: `admin_${action}`,
        userId: req.user?.id,
        userEmail: req.user?.email,
        details: {
            ...details,
            ip: req.ip,
            userAgent: req.headers['user-agent']
        },
        ip: req.ip,
        userAgent: req.headers['user-agent']
    });
};

/**
 * Get audit logs (Admin only)
 */
const getAuditLogs = async (options = {}) => {
    try {
        const {
            userId,
            action,
            startDate,
            endDate,
            limit = 50,
            page = 1
        } = options;

        let query = supabase
            .from('audit_logs')
            .select('*', { count: 'exact' })
            .order('timestamp', { ascending: false });

        if (userId) {
            query = query.eq('user_id', userId);
        }

        if (action) {
            query = query.eq('action', action);
        }

        if (startDate) {
            query = query.gte('timestamp', startDate);
        }

        if (endDate) {
            query = query.lte('timestamp', endDate);
        }

        const offset = (page - 1) * limit;
        const { data, error, count } = await query
            .range(offset, offset + limit - 1);

        if (error) throw error;

        return {
            logs: data,
            pagination: {
                page,
                limit,
                total: count,
                pages: Math.ceil(count / limit)
            }
        };

    } catch (error) {
        console.error('❌ Get audit logs error:', error);
        throw error;
    }
};

module.exports = {
    auditLog,
    auditMiddleware,
    describeRequestForAudit,
    logLogin,
    logLogout,
    logAdminAction,
    getAuditLogs
};