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
//   Phase 2 (server.js, after Redis is ready) — call initRateLimiters(storeOrFactory)
//     to replace every instance with a Redis-backed version. Because the
//     exported object is mutated in place, all routes automatically use the
//     upgraded limiters with zero re-import needed.
//
// USAGE in server.js:
//   const { initRateLimiters } = require('./middleware/rateLimitInstances');
//   initRateLimiters(createRedisStore);

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
 *
 * @param {Function|object|undefined} storeOrFactory - Store instance or (prefix) => Store
 */
function initRateLimiters(storeOrFactory) {
  if (!storeOrFactory) {
    console.log('ℹ️  Rate limiting: Redis store not configured — using in-memory store (not suitable for multi-instance/serverless deployments)');
    return;
  }
  const getStore = typeof storeOrFactory === 'function' ? storeOrFactory : () => storeOrFactory;

  instances.authLimiter          = createAuthLimiter(getStore('auth'));
  instances.registrationLimiter  = createRegistrationLimiter(getStore('reg'));
  instances.votingLimiter        = createVotingLimiter(getStore('vote'));
  instances.uploadLimiter        = createUploadLimiter(getStore('upload'));
  instances.apiLimiter           = createApiLimiter(getStore('api'));
  instances.directoryLimiter     = createDirectoryLimiter(getStore('dir'));
  instances.profileViewLimiter   = createProfileViewLimiter(getStore('pview'));
  instances.profileUpdateLimiter = createProfileUpdateLimiter(getStore('pupdate'));
  console.log('✅ Rate limiting: all limiters upgraded to Redis-backed store');
}

module.exports = { instances, initRateLimiters };
