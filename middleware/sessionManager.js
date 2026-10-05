// middleware/sessionManager.js
// Session Management and Token Refresh Middleware

const { supabase } = require('../config/supabase');
const { logger } = require('../config/logger');

/**
 * Session configuration
 */
const SESSION_CONFIG = {
  // Session expires after 24 hours of inactivity
  SESSION_TIMEOUT: 24 * 60 * 60 * 1000, // 24 hours in ms
  
  // Refresh token if less than this time remains
  REFRESH_THRESHOLD: 60 * 60 * 1000, // 1 hour in ms
  
  // Maximum session lifetime (7 days)
  MAX_SESSION_LIFETIME: 7 * 24 * 60 * 60 * 1000, // 7 days in ms
};

/**
 * Session metadata store (in-memory)
 * In production, use Redis for distributed sessions
 */
const sessionStore = new Map();

/**
 * Session metadata structure
 */
class SessionMetadata {
  constructor(userId, userEmail) {
    this.userId = userId;
    this.userEmail = userEmail;
    this.createdAt = Date.now();
    this.lastActivityAt = Date.now();
    this.refreshCount = 0;
    this.ipAddress = null;
    this.userAgent = null;
  }

  updateActivity(ip, userAgent) {
    this.lastActivityAt = Date.now();
    this.ipAddress = ip;
    this.userAgent = userAgent;
  }

  isExpired() {
    const now = Date.now();
    const inactiveDuration = now - this.lastActivityAt;
    const totalDuration = now - this.createdAt;

    return (
      inactiveDuration > SESSION_CONFIG.SESSION_TIMEOUT ||
      totalDuration > SESSION_CONFIG.MAX_SESSION_LIFETIME
    );
  }

  needsRefresh() {
    const now = Date.now();
    const inactiveDuration = now - this.lastActivityAt;
    return inactiveDuration > SESSION_CONFIG.REFRESH_THRESHOLD;
  }

  incrementRefresh() {
    this.refreshCount++;
  }
}

/**
 * Extract Supabase session from request
 */
const getSessionFromRequest = (req) => {
  // Try to get from Authorization header
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7);
  }

  // Try to get from cookies (if using cookie-based auth)
  if (req.cookies && req.cookies['sb-access-token']) {
    return req.cookies['sb-access-token'];
  }

  return null;
};

/**
 * Middleware: Check session validity and update activity
 */
const trackSession = async (req, res, next) => {
  try {
    const accessToken = getSessionFromRequest(req);
    
    if (!accessToken) {
      return next(); // No token, continue (will be handled by authenticate middleware)
    }

    // Verify token with Supabase
    const { data: { user }, error } = await supabase.auth.getUser(accessToken);
    
    if (error || !user) {
      return next(); // Invalid token, continue
    }

    // Get or create session metadata
    let session = sessionStore.get(user.id);
    if (!session) {
      session = new SessionMetadata(user.id, user.email);
      sessionStore.set(user.id, session);
      logger.info('Session created', { userId: user.id, email: user.email });
    }

    // Update activity
    session.updateActivity(req.ip, req.headers['user-agent']);

    // Check if session is expired
    if (session.isExpired()) {
      sessionStore.delete(user.id);
      logger.warn('Session expired', { userId: user.id });
      return res.status(401).json({
        success: false,
        error: 'Session expired. Please login again.',
        code: 'SESSION_EXPIRED',
        timestamp: new Date().toISOString()
      });
    }

    // Attach session info to request
    req.sessionMetadata = session;
    req.needsRefresh = session.needsRefresh();

    // Log session activity (only for important endpoints)
    if (req.method !== 'GET' && req.method !== 'OPTIONS') {
      logger.debug('Session activity', {
        userId: user.id,
        method: req.method,
        path: req.path,
        ip: req.ip
      });
    }

    next();
  } catch (error) {
    logger.error('Session tracking error:', error);
    next(); // Continue on error
  }
};

/**
 * Middleware: Require fresh session (force refresh if needed)
 */
const requireFreshSession = (req, res, next) => {
  if (req.needsRefresh) {
    return res.status(401).json({
      success: false,
      error: 'Session needs refresh. Please refresh your token.',
      code: 'SESSION_NEEDS_REFRESH',
      timestamp: new Date().toISOString()
    });
  }
  next();
};

/**
 * Clean up expired sessions (run periodically)
 */
const cleanupExpiredSessions = () => {
  const before = sessionStore.size;
  for (const [userId, session] of sessionStore.entries()) {
    if (session.isExpired()) {
      sessionStore.delete(userId);
      logger.info('Cleaned up expired session', { userId });
    }
  }
  const after = sessionStore.size;
  if (before !== after) {
    logger.info('Session cleanup complete', { removed: before - after, remaining: after });
  }
};

/**
 * Get session statistics (admin only)
 */
const getSessionStats = () => {
  const now = Date.now();
  const sessions = Array.from(sessionStore.values());
  
  return {
    total: sessions.length,
    active: sessions.filter(s => (now - s.lastActivityAt) < 5 * 60 * 1000).length, // Active in last 5 min
    needsRefresh: sessions.filter(s => s.needsRefresh()).length,
    expired: sessions.filter(s => s.isExpired()).length,
    avgRefreshCount: sessions.reduce((sum, s) => sum + s.refreshCount, 0) / sessions.length || 0
  };
};

/**
 * Invalidate specific user session (for logout/security)
 */
const invalidateSession = (userId) => {
  const deleted = sessionStore.delete(userId);
  if (deleted) {
    logger.info('Session invalidated', { userId });
  }
  return deleted;
};

/**
 * Initialize session manager
 * Sets up periodic cleanup
 */
const initializeSessionManager = () => {
  // Clean up expired sessions every 15 minutes
  setInterval(cleanupExpiredSessions, 15 * 60 * 1000);
  
  logger.info('✅ Session Manager initialized', {
    sessionTimeout: `${SESSION_CONFIG.SESSION_TIMEOUT / (60 * 60 * 1000)}h`,
    refreshThreshold: `${SESSION_CONFIG.REFRESH_THRESHOLD / (60 * 60 * 1000)}h`,
    maxLifetime: `${SESSION_CONFIG.MAX_SESSION_LIFETIME / (24 * 60 * 60 * 1000)}d`
  });
};

module.exports = {
  SESSION_CONFIG,
  trackSession,
  requireFreshSession,
  cleanupExpiredSessions,
  getSessionStats,
  invalidateSession,
  initializeSessionManager
};
