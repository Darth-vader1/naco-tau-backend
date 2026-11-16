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
//     to replace every instance with a Redis-backed version.
//
// Routes destructure these at require time (before Phase 2), so what they
// get must never change identity. Each exported limiter is a small stable
// wrapper that calls whichever real limiter is current on every request.
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
const current = {
  authLimiter:          createAuthLimiter(),
  registrationLimiter:  createRegistrationLimiter(),
  votingLimiter:        createVotingLimiter(),
  uploadLimiter:        createUploadLimiter(),
  apiLimiter:           createApiLimiter(),
  directoryLimiter:     createDirectoryLimiter(),
  profileViewLimiter:   createProfileViewLimiter(),
  profileUpdateLimiter: createProfileUpdateLimiter(),
};

// Stable middleware that routes hold on to; always uses the live limiter.
const instances = {};
for (const name of Object.keys(current)) {
  instances[name] = function delegatingLimiter(req, res, next) {
    return current[name](req, res, next);
  };
}

// Route-defined limiters: name -> (store|undefined) => middleware.
const extraFactories = new Map();
let storeFactory = null; // set by initRateLimiters

/**
 * For limiters a route defines itself. `makeLimiter(store)` must build the
 * limiter with that store (undefined = memory). Returns stable middleware
 * that switches to the Redis-backed version once initRateLimiters runs.
 */
function registerLimiter(name, makeLimiter) {
  if (current[name]) throw new Error(`Rate limiter "${name}" already registered`);
  extraFactories.set(name, makeLimiter);
  current[name] = makeLimiter(storeFactory ? storeFactory(name) : undefined);
  instances[name] = function delegatingLimiter(req, res, next) {
    return current[name](req, res, next);
  };
  return instances[name];
}

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

  current.authLimiter          = createAuthLimiter(getStore('auth'));
  current.registrationLimiter  = createRegistrationLimiter(getStore('reg'));
  current.votingLimiter        = createVotingLimiter(getStore('vote'));
  current.uploadLimiter        = createUploadLimiter(getStore('upload'));
  current.apiLimiter           = createApiLimiter(getStore('api'));
  current.directoryLimiter     = createDirectoryLimiter(getStore('dir'));
  current.profileViewLimiter   = createProfileViewLimiter(getStore('pview'));
  current.profileUpdateLimiter = createProfileUpdateLimiter(getStore('pupdate'));
  for (const [name, make] of extraFactories) current[name] = make(getStore(name));
  storeFactory = getStore;
  console.log('✅ Rate limiting: all limiters upgraded to Redis-backed store');
}

module.exports = { instances, initRateLimiters, registerLimiter, _current: current };
