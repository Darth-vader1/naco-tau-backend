// backend/middleware/rateLimit.js
//
// Rate-limiting tiers. Each limiter is created via a factory function so that
// server.js can inject the shared Redis store after it has been initialised.
//
// WHY FACTORIES?
// On Vercel (and any other serverless platform) every cold start spins up a
// fresh Node process with a brand-new in-memory store, making the window
// counter reset on every invocation. The limiters are effectively useless.
// Injecting a Redis store (e.g. Upstash via REDIS_URL) persists counters
// across all instances and cold starts, making the limits real.
//
// USAGE in server.js:
//   const { createAuthLimiter, createRegistrationLimiter, ... } = require('./middleware/rateLimit');
//   const authLimiter = createAuthLimiter(redisStore);        // redisStore may be undefined → falls back to memory
//   const registrationLimiter = createRegistrationLimiter(redisStore);
//
// NOTE: The global /api/* rate limiter is defined inline in server.js because
// it needs the Redis store AND the token extractor at the same time.

const rateLimit = require('express-rate-limit');

// Shared non-store config applied to every limiter
const baseConfig = {
  standardHeaders: true,   // Return RateLimit-* headers per RFC 6585
  legacyHeaders: false,     // Disable X-RateLimit-* legacy headers
  validate: { trustProxy: false, unsharedStore: false } // Trust proxy is configured at app level
};

// Helper: get rate-limit key by authenticated user ID if present, else IP.
// Prevents campus Wi-Fi (shared IP) from triggering blanket blocks.
const getUserOrIpKey = (req) =>
  req.userId || (req.user && req.user.id) || req.ip;

// ============================================
// AUTH RATE LIMIT  (login + forgot-password)
// 5 attempts per 15 min, keyed on email or IP
// ============================================
const createAuthLimiter = (store) => rateLimit({
  ...baseConfig,
  ...(store ? { store } : {}),
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { error: 'Too many login attempts. Please try again after 15 minutes.' },
  keyGenerator: (req) => req.body?.email || req.ip
});

// ============================================
// REGISTRATION RATE LIMIT
// 3 new accounts per hour per IP
// ============================================
const createRegistrationLimiter = (store) => rateLimit({
  ...baseConfig,
  ...(store ? { store } : {}),
  windowMs: 60 * 60 * 1000,
  max: 3,
  message: { error: 'Too many registration attempts. Please try again later.' }
});

// ============================================
// VOTING RATE LIMIT
// 5 votes per 24 hours per user/IP
// ============================================
const createVotingLimiter = (store) => rateLimit({
  ...baseConfig,
  ...(store ? { store } : {}),
  windowMs: 24 * 60 * 60 * 1000,
  max: 5,
  message: { error: 'Voting limit reached. You can only vote 5 times per day.' },
  keyGenerator: getUserOrIpKey
});

// ============================================
// FILE UPLOAD RATE LIMIT
// 20 uploads per hour per user/IP
// ============================================
const createUploadLimiter = (store) => rateLimit({
  ...baseConfig,
  ...(store ? { store } : {}),
  windowMs: 60 * 60 * 1000,
  max: 20,
  message: { error: 'Upload limit reached. Please try again later.' },
  keyGenerator: getUserOrIpKey
});

// ============================================
// API RATE LIMIT (optional per-route stricter cap)
// 500 requests per hour per user/IP
// ============================================
const createApiLimiter = (store) => rateLimit({
  ...baseConfig,
  ...(store ? { store } : {}),
  windowMs: 60 * 60 * 1000,
  max: 500,
  message: { error: 'API rate limit exceeded. Please slow down your requests.' },
  keyGenerator: getUserOrIpKey
});

// ============================================
// DIRECTORY RATE LIMIT  (prevent scraping)
// 60 requests per minute per user/IP
// ============================================
const createDirectoryLimiter = (store) => rateLimit({
  ...baseConfig,
  ...(store ? { store } : {}),
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Directory access limit exceeded. Please slow down.' },
  keyGenerator: getUserOrIpKey
});

// ============================================
// PROFILE VIEW RATE LIMIT
// 120 views per minute per user/IP
// ============================================
const createProfileViewLimiter = (store) => rateLimit({
  ...baseConfig,
  ...(store ? { store } : {}),
  windowMs: 60 * 1000,
  max: 120,
  message: { error: 'Profile view limit exceeded. Please slow down.' },
  keyGenerator: getUserOrIpKey
});

// ============================================
// PROFILE UPDATE RATE LIMIT
// 10 updates per minute per user/IP
// ============================================
const createProfileUpdateLimiter = (store) => rateLimit({
  ...baseConfig,
  ...(store ? { store } : {}),
  windowMs: 60 * 1000,
  max: 10,
  message: { error: 'Profile update limit exceeded. Please wait before trying again.' },
  keyGenerator: getUserOrIpKey
});

module.exports = {
  createAuthLimiter,
  createRegistrationLimiter,
  createVotingLimiter,
  createUploadLimiter,
  createApiLimiter,
  createDirectoryLimiter,
  createProfileViewLimiter,
  createProfileUpdateLimiter
};
