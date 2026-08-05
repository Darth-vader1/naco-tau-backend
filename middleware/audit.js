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

        // Only log if status is 2xx-4xx (skip 5xx noise logged separately,
        // and skip very early responses like static files)
        if (statusCode >= 200 && statusCode < 500) {
            const userId = req.user?.id || req.userId || null;
            const userEmail = req.user?.email || null;

            // Determine route (if matched) or fallback path
            const route = req.route?.path || req.path;
            const method = req.method;

            // Skip paths that are very noisy or handled by explicit auditLog()
            const skipPrefixes = ['/api/health', '/assets', '/frontend', '/vendor'];
            const skipActions = new Set([
                'student_registration', 'admin_login', 'logout',
                'student_approve', 'student_reject', 'student_deleted',
                'profile_picture_update', 'resource_created', 'resource_updated', 'resource_deleted',
                'timetable_created', 'timetable_updated', 'timetable_deleted',
                'career_path_created', 'career_path_updated', 'career_path_deleted',
                'payment_submitted', 'payment_verified', 'payment_rejected'
            ]);

            const shouldSkip =
                skipPrefixes.some(p => req.originalUrl.startsWith(p)) ||
                // Skip successful verify calls (very chatty on every SPA route)
                (method === 'GET' && /\/auth\/verify$/.test(route)) ||
                // Skip pure-GET reads for non-admin endpoints to keep logs focused
                (method === 'GET' && statusCode < 400 && !route.includes('/admin'));

            if (!shouldSkip) {
                // Generate cleaner action name
                let autoAction = `auto_${method}_${route.replace(/\//g, '_').replace(/[:?]/g, '') || 'root'}`;
                
                // Clean up common patterns to make action names more readable
                autoAction = autoAction
                    .replace('auto_POST__api_auth_register', 'student_registration')
                    .replace('auto_POST__api_storage_ensure-buckets', 'storage_bucket_check')
                    .replace('auto_PUT__api_students_me', 'profile_update')
                    .replace('auto_GET__api_students_directory', 'view_student_directory')
                    .replace('auto_GET__api_events_upcoming', 'view_upcoming_events')
                    .replace('auto_GET__api_events_past', 'view_past_events')
                    .replace('auto_GET__api_resources', 'view_resources')
                    .replace('auto_GET__api_timetables', 'view_timetables')
                    .replace('auto_GET__api_career', 'view_career_paths')
                    .replace('auto_POST__api_events_id_register', 'event_registration')
                    .replace('auto_GET__api_payments', 'view_payments')
                    .replace('auto_POST__api_payments', 'payment_submission')
                    .replace(/_api_/g, '_')
                    .replace(/__/g, '_')
                    .slice(0, 80);
                
                const alreadyAudited =
                    (typeof autoAction === 'string') &&
                    [...skipActions].some(a => autoAction.includes(a));

                if (!alreadyAudited) {
                    auditLog({
                        action: autoAction,
                        userId: userId,
                        userEmail: userEmail,
                        details: {
                            method,
                            path: req.originalUrl,
                            query: Object.keys(req.query || {}).length ? req.query : undefined,
                            body: (method === 'GET' || req.method === 'DELETE') ? undefined :
                                Object.keys(req.body || {}).length
                                    ? redactSecrets(req.body)
                                    : undefined,
                            statusCode: statusCode,
                            responseTime: Date.now() - req._startTime
                        },
                        ip: req.ip,
                        userAgent: req.headers['user-agent']
                    }).catch(err => console.error('[auditMiddleware] audit log error:', err.message));
                }
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
    logLogin,
    logLogout,
    logAdminAction,
    getAuditLogs
};