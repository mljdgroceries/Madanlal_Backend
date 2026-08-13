const { Queue } = require('bullmq');
const { redisConnection } = require('../config/redis');

// Create notification queue
const notificationQueue = new Queue('notification-queue', {
    connection: redisConnection,
    defaultJobOptions: {
        attempts: 3,
        backoff: {
            type: 'exponential',
            delay: 2000, // 2 seconds, 4 seconds, 8 seconds
        },
        removeOnComplete: {
            age: 24 * 3600, // Keep completed jobs for 24 hours
            count: 1000, // Keep max 1000 completed jobs
        },
        removeOnFail: {
            age: 7 * 24 * 3600, // Keep failed jobs for 7 days
        },
    },
});

// Queue event listeners
notificationQueue.on('error', (error) => {
    console.error('❌ Notification queue error:', error);
});

notificationQueue.on('waiting', (job) => {
    console.log(`⏳ Job ${job.id} is waiting`);
});

notificationQueue.on('active', (job) => {
    console.log(`🔄 Job ${job.id} is now active`);
});

notificationQueue.on('completed', (job) => {
    console.log(`✅ Job ${job.id} completed`);
});

notificationQueue.on('failed', (job, err) => {
    console.error(`❌ Job ${job.id} failed:`, err.message);
});

module.exports = notificationQueue;

