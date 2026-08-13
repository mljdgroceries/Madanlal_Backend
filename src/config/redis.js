const { Redis } = require('ioredis');
require('dotenv').config({ quiet: true });

// Redis connection configuration
const redisConfig = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    // password: process.env.REDIS_PASSWORD,
    maxRetriesPerRequest: null,
    retryStrategy: (times) => {
        const delay = Math.min(times * 50, 2000);
        return delay;
    },
};

// Create Redis connection
const redisConnection = new Redis(redisConfig);

redisConnection.on('connect', () => {
    console.log('✅ Connected to Redis');
});

redisConnection.on('error', (error) => {
    console.error('❌ Redis connection error:', error);
});

redisConnection.on('close', () => {
    console.log('⚠️ Redis connection closed');
});

module.exports = { redisConnection, redisConfig };

