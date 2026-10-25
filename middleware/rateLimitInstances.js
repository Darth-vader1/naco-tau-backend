// backend/middleware/rateLimitInstances.js
//
// Shared singleton instances of every rate limiter.
//
// WHY THIS FILE EXISTS:
// Routes (auth.js, students.js, etc.) are require()'d at startup before
// server.js has had the chance to build the Redis store. If routes imported
// the limiter factories directly and called them immediately, the store would
// always be undefined and every limiter would silently fall back to memory —
// making them useless on Vercel and other serverless platforms.
//
// This module solves the bootstrapping problem with a two-phase init:
//   Phase 1 (module load) — create in-memory fallback instances so routes
//     can import real middleware references immediately.
//   Phase 2 (server.js, after Redis is ready) — call initRateLimiters(store)
//     to replace every instance with a Redis-backed version. Because the
//     exported object is mutated in place, all routes automatically use the
//     upgraded limiters with zero re-import needed.
//
// USAGE in server.js:
//   const { initRateLimiters } = require('./middleware/rateLimitInstances');
//   // ... build redisStore ...
//   initRateLimiters(redisStore);   // call BEFORE app.use() mounts routes

const {
  createAuthLimiter,
  createRegistrationLimiter,
  createVotingLimiter,
  createUploadLimiter,
  createApiLimiter,
  createDirectoryLimiter,
  createProfileViewLimiter,
  createProfileUpdateLimiter,
} = require('./rateLimit');

// Phase 1: in-memory fallback instances (store = undefined)
const instances = {
  authLimiter:          createAuthLimiter(),
  registrationLimiter:  createRegistrationLimiter(),
  votingLimiter:        createVotingLimiter(),
  uploadLimiter:        createUploadLimiter(),
  apiLimiter:           createApiLimiter(),
  directoryLimiter:     createDirectoryLimiter(),
  profileViewLimiter:   createProfileViewLimiter(),
  profileUpdateLimiter: createProfileUpdateLimiter(),
};

/**
 * Phase 2 — called by server.js once the Redis store is ready.
 * Replaces every in-memory instance with a Redis-backed equivalent.
 * All existing references (route files) point at the same `instances`
 * object, so they pick up the new middleware automatically.
 *
 * @param {object|undefined} store - A rate-limit-redis store, or undefined to keep memory store.
 */
function initRateLimiters(store) {
  if (!store) {
    console.log('ℹ️  Rate limiting: Redis store not configured — using in-memory store (not suitable for multi-instance/serverless deployments)');
    return;
  }
  instances.authLimiter          = createAuthLimiter(store);
  instances.registrationLimiter  = createRegistrationLimiter(store);
  instances.votingLimiter        = createVotingLimiter(store);
  instances.uploadLimiter        = createUploadLimiter(store);
  instances.apiLimiter           = createApiLimiter(store);
  instances.directoryLimiter     = createDirectoryLimiter(store);
  instances.profileViewLimiter   = createProfileViewLimiter(store);
  instances.profileUpdateLimiter = createProfileUpdateLimiter(store);
  console.log('✅ Rate limiting: all limiters upgraded to Redis-backed store');
}

module.exports = { instances, initRateLimiters };
