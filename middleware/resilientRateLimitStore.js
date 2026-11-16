// middleware/resilientRateLimitStore.js
//
// A rate-limit store that uses Redis (shared across serverless instances)
// when Redis is ready, and falls back to an in-memory count when it isn't,
// so a slow or unavailable Redis can never turn a request into a 500.
//
// Why: on a cold start the Upstash connection is still being established.
// The previous wrapper answered Redis commands with a fake `0` while not
// ready or on a timeout. rate-limit-redis then threw ("Expected result to be
// array of values"), express-rate-limit passed that to Express, and the first
// request(s) after every deploy/idle period got a 500. rate-limit-redis also
// loads its Lua scripts eagerly in its constructor; when that failed the
// rejected promise was never handled and could crash the instance.
//
// Behaviour:
// - Redis ready  -> count in Redis (real replies/errors, never fake values).
// - Not ready, or a Redis command fails -> count in memory for this
//   instance (limits stay roughly enforced) and log a warning.
// - The Redis-backed store is (re)built lazily, so failed script loads are
//   retried on a later request instead of poisoning the store.

const { MemoryStore } = require('express-rate-limit');

class ResilientRateLimitStore {
  /**
   * @param {object} opts
   * @param {object} opts.redisClient  ioredis client (lazy-connected)
   * @param {Function} opts.RedisStore rate-limit-redis store class
   * @param {string} opts.prefix       key namespace, e.g. "global"
   * @param {object} [opts.logger]     anything with .warn()
   */
  constructor({ redisClient, RedisStore, prefix, logger = console }) {
    this.redisClient = redisClient;
    this.RedisStore = RedisStore;
    this.prefix = `rl:${prefix}:`;
    this.logger = logger;
    this.memory = new MemoryStore();
    this.redisStore = null;
    this.options = null;
    this.lastWarnAt = 0;
  }

  init(options) {
    this.options = options;
    this.memory.init(options);
  }

  redisReady() {
    return !!(this.redisClient && this.redisClient.status === 'ready');
  }

  getRedisStore() {
    if (this.redisStore) return this.redisStore;
    const client = this.redisClient;
    const store = new this.RedisStore({
      prefix: this.prefix,
      // Real replies and real errors only: never a fake value.
      sendCommand: (...args) => client.call(...args)
    });
    // The library starts loading its scripts immediately; if that fails before
    // anyone awaits it, the rejection must not go unhandled.
    for (const p of [store.incrementScriptSha, store.getScriptSha]) {
      if (p && typeof p.catch === 'function') p.catch(() => {});
    }
    if (this.options) store.init(this.options);
    this.redisStore = store;
    return store;
  }

  warn(operation, err) {
    // At most one warning per 30s per store, to keep logs readable under load.
    const now = Date.now();
    if (now - this.lastWarnAt < 30000) return;
    this.lastWarnAt = now;
    this.logger.warn(`[rate-limit] Redis ${operation} failed for ${this.prefix}; using in-memory count. ${err && err.message ? err.message : err}`);
  }

  async withFallback(operation, redisFn, memoryFn) {
    if (this.redisReady()) {
      try {
        return await redisFn(this.getRedisStore());
      } catch (err) {
        this.warn(operation, err);
        this.redisStore = null; // rebuild (and reload scripts) on a later request
      }
    }
    return memoryFn(this.memory);
  }

  increment(key) {
    return this.withFallback('increment', s => s.increment(key), m => m.increment(key));
  }

  decrement(key) {
    return this.withFallback('decrement', s => s.decrement(key), m => m.decrement(key));
  }

  resetKey(key) {
    return this.withFallback('resetKey', s => s.resetKey(key), m => m.resetKey(key));
  }

  get(key) {
    return this.withFallback('get', s => s.get(key), m => (typeof m.get === 'function' ? m.get(key) : undefined));
  }
}

/** Factory used by server.js for every limiter. */
function createResilientStore({ redisClient, RedisStore, prefix, logger }) {
  if (!redisClient || !RedisStore) return undefined; // express-rate-limit uses its own memory store
  return new ResilientRateLimitStore({ redisClient, RedisStore, prefix, logger });
}

module.exports = { ResilientRateLimitStore, createResilientStore };
