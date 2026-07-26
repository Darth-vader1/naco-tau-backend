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
 */
const auditMiddleware = (req, res, next) => {
    // Store original send function
    const originalSend = res.send;
    
    // Override send to log after response
    res.send = function(data) {
        // Log only if status is 200-299 (success) or 400-499 (client error)
        const statusCode = res.statusCode;
        if (statusCode >= 200 && statusCode < 500) {
            const userId = req.user?.id || null;
            const userEmail = req.user?.email || null;
            
            // Log based on route
            const route = req.route?.path || req.path;
            const method = req.method;
            
            // Skip logging for health checks and static files
            const skipPaths = ['/api/health', '/api/test'];
            if (!skipPaths.includes(route)) {
                auditLog({
                    action: `${method}_${route.replace(/\//g, '_')}`,
                    userId: userId,
                    userEmail: userEmail,
                    details: {
                        method,
                        path: req.path,
                        query: req.query,
                        body: req.method === 'GET' ? undefined : req.body,
                        statusCode: statusCode,
                        responseTime: Date.now() - req._startTime
                    },
                    ip: req.ip,
                    userAgent: req.headers['user-agent']
                }).catch(err => console.error('Audit middleware error:', err));
            }
        }
        return originalSend.call(this, data);
    };
    
    // Track request start time
    req._startTime = Date.now();
    next();
};

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