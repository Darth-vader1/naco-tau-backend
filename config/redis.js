// config/redis.js
// Shared Redis client configuration with graceful degradation and non-blocking lazy connection

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
      maxRetriesPerRequest: 1,
      enableReadyCheck: false,
      lazyConnect: true,
      connectTimeout: 3000,
      commandTimeout: 3000,
      retryStrategy(times) {
        if (times > 2) {
          return null; // Stop retrying on serverless cold starts
        }
        return Math.min(times * 100, 1000);
      }
    });

    redisClient.on('error', (err) => {
      console.warn('⚠️ Redis connection error:', err.message);
    });

    // Initiate non-blocking connection attempt in the background
    redisClient.connect().catch((err) => {
      console.warn('⚠️ Redis background connect failed, falling back:', err.message);
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
