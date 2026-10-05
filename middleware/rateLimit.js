// backend/middleware/rateLimit.js
//
// Rate-limiting tiers (each exported individually; mounted only when needed).
// NOTE: The global /api/* rate limiter is defined in server.js and reads
// process.env.GLOBAL_RATE_LIMIT (default 100 req / 15 min). The duplicate
// "globalLimiter" that used to live here (limit = 1000) was removed because
// it was never mounted and created confusion about which limit was active.

const rateLimit = require('express-rate-limit');

// Common configuration for all limiters
const commonConfig = {
    standardHeaders: true,
    legacyHeaders: false,
    // Disable trust proxy validation warning
    // Trust proxy is configured at app level in server.js
    validate: { trustProxy: false }
};

// ============================================
// AUTH RATE LIMIT
// ============================================

const authLimiter = rateLimit({
    ...commonConfig,
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts
    message: {
        error: 'Too many login attempts. Please try again after 15 minutes.'
    },
    keyGenerator: (req) => {
        return req.body.email || req.ip;
    }
});

// ============================================
// REGISTRATION RATE LIMIT
// ============================================

const registrationLimiter = rateLimit({
    ...commonConfig,
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3, // 3 registrations per IP
    message: {
        error: 'Too many registration attempts. Please try again later.'
    }
});

// ============================================
// VOTING RATE LIMIT
// ============================================

const votingLimiter = rateLimit({
    ...commonConfig,
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    max: 5, // 5 votes per day
    message: {
        error: 'Voting limit reached. You can only vote 5 times per day.'
    },
    keyGenerator: (req) => {
        return req.userId || req.ip;
    }
});

// ============================================
// FILE UPLOAD RATE LIMIT
// ============================================

const uploadLimiter = rateLimit({
    ...commonConfig,
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 20, // 20 uploads per hour
    message: {
        error: 'Upload limit reached. Please try again later.'
    }
});

// ============================================
// API RATE LIMIT (stricter, optional per-route)
// ============================================

const apiLimiter = rateLimit({
    ...commonConfig,
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 500, // 500 requests per IP
    message: {
        error: 'API rate limit exceeded. Please slow down your requests.'
    }
});

// ============================================
// DIRECTORY RATE LIMIT (prevent scraping)
// ============================================

const directoryLimiter = rateLimit({
    ...commonConfig,
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 60, // 60 requests per minute per user
    message: {
        error: 'Directory access limit exceeded. Please slow down.'
    },
    keyGenerator: (req) => {
        return req.userId || req.ip;
    }
});

// ============================================
// PROFILE VIEW RATE LIMIT
// ============================================

const profileViewLimiter = rateLimit({
    ...commonConfig,
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 120, // 120 profile views per minute
    message: {
        error: 'Profile view limit exceeded. Please slow down.'
    },
    keyGenerator: (req) => {
        return req.userId || req.ip;
    }
});

// ============================================
// PROFILE UPDATE RATE LIMIT
// ============================================

const profileUpdateLimiter = rateLimit({
    ...commonConfig,
    windowMs: 1 * 60 * 1000, // 1 minute
    max: 10, // 10 profile updates per minute
    message: {
        error: 'Profile update limit exceeded. Please wait before trying again.'
    },
    keyGenerator: (req) => {
        return req.userId || req.ip;
    }
});

module.exports = {
    authLimiter,
    registrationLimiter,
    votingLimiter,
    uploadLimiter,
    apiLimiter,
    directoryLimiter,
    profileViewLimiter,
    profileUpdateLimiter
};