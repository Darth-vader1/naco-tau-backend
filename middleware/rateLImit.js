// backend/middleware/rateLimit.js
const rateLimit = require('express-rate-limit');

// ============================================
// GLOBAL RATE LIMIT
// ============================================

const globalLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 1000,
    message: {
        error: 'Too many requests from this IP. Please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false
});

// ============================================
// AUTH RATE LIMIT
// ============================================

const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 5, // 5 attempts
    message: {
        error: 'Too many login attempts. Please try again after 15 minutes.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        return req.body.email || req.ip;
    }
});

// ============================================
// REGISTRATION RATE LIMIT
// ============================================

const registrationLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 3, // 3 registrations per IP
    message: {
        error: 'Too many registration attempts. Please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false
});

// ============================================
// VOTING RATE LIMIT
// ============================================

const votingLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    max: 5, // 5 votes per day
    message: {
        error: 'Voting limit reached. You can only vote 5 times per day.'
    },
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => {
        return req.userId || req.ip;
    }
});

// ============================================
// FILE UPLOAD RATE LIMIT
// ============================================

const uploadLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 20, // 20 uploads per hour
    message: {
        error: 'Upload limit reached. Please try again later.'
    },
    standardHeaders: true,
    legacyHeaders: false
});

// ============================================
// API RATE LIMIT (Stricter)
// ============================================

const apiLimiter = rateLimit({
    windowMs: 60 * 60 * 1000, // 1 hour
    max: 500, // 500 requests per IP
    message: {
        error: 'API rate limit exceeded. Please slow down your requests.'
    },
    standardHeaders: true,
    legacyHeaders: false
});

module.exports = {
    globalLimiter,
    authLimiter,
    registrationLimiter,
    votingLimiter,
    uploadLimiter,
    apiLimiter
};