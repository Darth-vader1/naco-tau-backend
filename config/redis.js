// config/redis.js
// Shared Redis client configuration with graceful degradation

let Redis;
try {
  Redis = require('ioredis');
} catch (e) {
  // ioredis is not installed or available
}

let redisClient = null;

if (process.env.REDIS_URL && Redis) {
  try {
    redisClient = new Redis(process.env.REDIS_URL, {
      maxRetriesPerRequest: 3,
      enableReadyCheck: true,
      lazyConnect: false,
      connectTimeout: 5000,
      retryStrategy(times) {
        if (times > 5) {
          console.warn('⚠️ Redis retry limit reached; disabling Redis client.');
          return null; // Stop retrying
        }
        return Math.min(times * 100, 2000);
      }
    });

    redisClient.on('error', (err) => {
      console.warn('⚠️ Redis error:', err.message);
    });

    redisClient.on('connect', () => {
      console.log('✅ Connected to Redis');
    });
  } catch (err) {
    console.warn('⚠️ Could not initialize Redis client:', err.message);
    redisClient = null;
  }
}

module.exports = {
  Redis,
  redisClient
};
