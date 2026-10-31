// middleware/sessionManager.js
// Session Management and Token Refresh Middleware

const { supabase } = require('../config/supabase');
const { logger } = require('../config/logger');
const { redisClient } = require('../config/redis');

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
 * Session metadata store (in-memory fallback when Redis is unavailable)
 */
const sessionStore = new Map();

/**
 * Session metadata structure
 */
class SessionMetadata {
  constructor(userId, userEmail, data = {}) {
    this.userId = userId;
    this.userEmail = userEmail;
    this.createdAt = data.createdAt || Date.now();
    this.lastActivityAt = data.lastActivityAt || Date.now();
    this.refreshCount = data.refreshCount || 0;
    this.ipAddress = data.ipAddress || null;
    this.userAgent = data.userAgent || null;
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

  toJSON() {
    return {
      userId: this.userId,
      userEmail: this.userEmail,
      createdAt: this.createdAt,
      lastActivityAt: this.lastActivityAt,
      refreshCount: this.refreshCount,
      ipAddress: this.ipAddress,
      userAgent: this.userAgent
    };
  }

  static fromJSON(json) {
    if (!json) return null;
    return new SessionMetadata(json.userId, json.userEmail, json);
  }
}

/**
 * Helper to get session from Redis or in-memory fallback
 */
async function getStoredSession(userId) {
  if (redisClient) {
    try {
      const data = await redisClient.get(`session:${userId}`);
      if (data) {
        return SessionMetadata.fromJSON(JSON.parse(data));
      }
    } catch (err) {
      logger.warn('Redis get session error, falling back to memory:', err.message);
    }
  }
  return sessionStore.get(userId) || null;
}

/**
 * Helper to save session to Redis and memory
 */
async function saveStoredSession(session) {
  sessionStore.set(session.userId, session);
  if (redisClient) {
    try {
      const ttlSec = Math.max(1, Math.floor(SESSION_CONFIG.SESSION_TIMEOUT / 1000));
      await redisClient.setex(`session:${session.userId}`, ttlSec, JSON.stringify(session.toJSON()));
    } catch (err) {
      logger.warn('Redis save session error:', err.message);
    }
  }
}

/**
 * Helper to remove session from Redis and memory
 */
async function removeStoredSession(userId) {
  sessionStore.delete(userId);
  if (redisClient) {
    try {
      await redisClient.del(`session:${userId}`);
    } catch (err) {
      logger.warn('Redis delete session error:', err.message);
    }
  }
}

/**
 * Extract Supabase session from request
 */
const getSessionFromRequest = (req) => {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.substring(7).trim();
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
    let session = await getStoredSession(user.id);
    if (!session) {
      session = new SessionMetadata(user.id, user.email);
      await saveStoredSession(session);
      logger.info('Session created', { userId: user.id, email: user.email });
    }

    // Update activity
    session.updateActivity(req.ip, req.headers['user-agent']);

    // Check if session is expired
    if (session.isExpired()) {
      await removeStoredSession(user.id);
      logger.warn('Session expired', { userId: user.id });
      return res.status(401).json({
        success: false,
        error: 'Session expired. Please login again.',
        code: 'SESSION_EXPIRED',
        timestamp: new Date().toISOString()
      });
    }

    // Save updated activity back to Redis/Memory
    await saveStoredSession(session);

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
      logger.info('Cleaned up expired session from memory', { userId });
    }
  }
  const after = sessionStore.size;
  if (before !== after) {
    logger.info('In-memory session cleanup complete', { removed: before - after, remaining: after });
  }
};

/**
 * Get session statistics (admin only)
 */
const getSessionStats = async () => {
  const now = Date.now();
  let sessions = Array.from(sessionStore.values());
  let storage = 'memory';

  if (redisClient) {
    try {
      const keys = await redisClient.keys('session:*');
      storage = 'redis';
      if (keys.length > 0) {
        const pipeline = redisClient.pipeline();
        keys.forEach(k => pipeline.get(k));
        const results = await pipeline.exec();
        const redisSessions = results
          .map(([err, val]) => {
            if (err || !val) return null;
            try { return SessionMetadata.fromJSON(JSON.parse(val)); } catch (_) { return null; }
          })
          .filter(Boolean);
        if (redisSessions.length > 0) {
          sessions = redisSessions;
        }
      }
    } catch (err) {
      logger.warn('Error reading Redis session stats:', err.message);
    }
  }
  
  return {
    total: sessions.length,
    active: sessions.filter(s => (now - s.lastActivityAt) < 5 * 60 * 1000).length, // Active in last 5 min
    needsRefresh: sessions.filter(s => s.needsRefresh()).length,
    expired: sessions.filter(s => s.isExpired()).length,
    avgRefreshCount: sessions.length > 0 ? (sessions.reduce((sum, s) => sum + s.refreshCount, 0) / sessions.length) : 0,
    storage
  };
};

/**
 * Invalidate specific user session (for logout/security)
 */
const invalidateSession = async (userId) => {
  await removeStoredSession(userId);
  logger.info('Session invalidated', { userId });
  return true;
};

/**
 * Initialize session manager
 * Sets up periodic cleanup
 */
const initializeSessionManager = () => {
  // In Vercel serverless functions, avoid long-running interval timers
  if (process.env.VERCEL) {
    return;
  }

  // Clean up expired sessions every 15 minutes
  const interval = setInterval(cleanupExpiredSessions, 15 * 60 * 1000);
  if (interval && interval.unref) {
    interval.unref();
  }
  
  logger.info('✅ Session Manager initialized', {
    sessionTimeout: `${SESSION_CONFIG.SESSION_TIMEOUT / (60 * 60 * 1000)}h`,
    refreshThreshold: `${SESSION_CONFIG.REFRESH_THRESHOLD / (60 * 60 * 1000)}h`,
    maxLifetime: `${SESSION_CONFIG.MAX_SESSION_LIFETIME / (24 * 60 * 60 * 1000)}d`,
    storage: redisClient ? 'Redis (Upstash/Distributed)' : 'In-Memory Map'
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
