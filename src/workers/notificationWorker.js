const { Worker } = require('bullmq');
const { redisConnection } = require('../config/redis');
const sendNotification = require('../utils/sendNotification');
const Notification = require('../models/notificationModel');
const User = require('../models/userModel');
const Driver = require('../models/driverModel');
const { Admin } = require('../models/adminModel');
const Order = require('../models/orderModel');

// Function to get users based on target audience
const getUsersByTargetAudience = async (targetAudience, userId = null, driverId = null) => {
    const now = new Date();
    let userQuery = { status: "Active" };
    let driverQuery = { status: { $in: ["Active", "onDelivery"] } }; // Include all statuses except Deleted

    switch (targetAudience) {
        case "specificUser":
            if (!userId) return [];
            return await User.find({ ...userQuery, _id: userId }).select('_id devices notificationPreferences');

        case "specificDriver":
            if (!driverId) return [];
            return await Driver.find({ ...driverQuery, _id: driverId }).select('_id devices');

        case "all":
            return await User.find(userQuery).select('_id devices notificationPreferences');

        case "allDrivers":
            return await Driver.find(driverQuery).select('_id devices');

        case "allAdmins":
            return await Admin.find({}).select('_id devices deviceToken deviceType');

        case "activeLast30Days":
            const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            const activeUserIds = await Order.distinct("userId", {
                createdAt: { $gte: thirtyDaysAgo },
                status: { $ne: "Cancelled" }
            });
            return await User.find({
                ...userQuery,
                _id: { $in: activeUserIds }
            }).select('_id devices notificationPreferences');

        case "newUsersLast7Days":
            const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
            return await User.find({
                ...userQuery,
                createdAt: { $gte: sevenDaysAgo }
            }).select('_id devices notificationPreferences');

        case "userInactive30Days":
            const thirtyDaysAgoInactive = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
            const inactiveUserIds = await Order.distinct("userId", {
                createdAt: { $gte: thirtyDaysAgoInactive }
            });
            return await User.find({
                ...userQuery,
                _id: { $nin: inactiveUserIds }
            }).select('_id devices notificationPreferences');

        default:
            return await User.find(userQuery).select('_id devices notificationPreferences');
    }
};

// Create notification worker
const notificationWorker = new Worker(
    'notification-queue',
    async (job) => {
        const { notificationId, targetAudience, userId, driverId, category, title, message, type } = job.data;

        // console.log(`📨 Worker ${process.pid} Processing notification job for notificationId: ${notificationId} (Target: ${targetAudience}, Category: ${category || 'none'})`);

        // Get users based on target audience
        const users = await getUsersByTargetAudience(targetAudience, userId, driverId);

        // delivered/failed counts are tracked per recipient (user/driver/admin), not per device
        let sentCount = 0;
        let failedCount = 0;
        const batchSize = 100; // Process in batches to avoid overwhelming FCM

        // Process users in batches
        for (let i = 0; i < users.length; i += batchSize) {
            const batch = users.slice(i, i + batchSize);

            // Process batch in parallel - send to all devices for each user
            const promises = batch.map(async (user) => {
                // 🛑 Check Notification Preferences only for toggleable categories
                const toggleableCategories = ["orderUpdates", "promotions", "deliveryAlerts"];
                if (category && toggleableCategories.includes(category)) {
                    if (user.notificationPreferences && user.notificationPreferences[category] === false) {
                        return {
                            recipientId: user._id,
                            delivered: false,
                            reason: `User disabled ${category} notifications`
                        };
                    }
                }

                // Get all devices for this user and deduplicate by token
                let devices = user.devices || [];

                // Deduplicate tokens for this user
                const uniqueDevices = [];
                const seenTokens = new Set();

                // Add legacy token if exists and not already in devices array logic...
                // But easier: collect all potential tokens and then filter.
                let potentialDevices = [...devices];
                if (potentialDevices.length === 0 && user.deviceToken) {
                    potentialDevices.push({ deviceToken: user.deviceToken, deviceType: user.deviceType });
                }

                potentialDevices.forEach(d => {
                    if (d.deviceToken && !seenTokens.has(d.deviceToken)) {
                        seenTokens.add(d.deviceToken);
                        uniqueDevices.push(d);
                    }
                });

                // console.log('+++++++++++++++++++++++++++potentialDevices',potentialDevices)
                // console.log('==========================uniqueDevices',uniqueDevices)

                if (uniqueDevices.length === 0) {
                    return {
                        recipientId: user._id,
                        delivered: false,
                        reason: 'No valid devices found'
                    };
                }

                // Send notification to all unique devices for this user
                const devicePromises = uniqueDevices.map(async (device) => {
                    const deviceToken = device.deviceToken;

                    if (deviceToken && deviceToken.trim() !== "" && (type === "push")) {
                        // console.log("📤 Sending notification to token:", deviceToken, "device:", device.deviceType);
                        try {
                            await sendNotification({
                                deviceToken: deviceToken,
                                title: title,
                                body: message
                            });
                            return { success: true, userId: user._id, deviceType: device.deviceType };
                        } catch (error) {
                            console.error(`Error sending notification to user ${user._id}, device ${device.deviceType}:`, error.message);
                            return { success: false, userId: user._id, deviceType: device.deviceType, error: error.message };
                        }
                    }
                    return { success: false, userId: user._id, deviceType: device.deviceType, reason: 'No device token or invalid type' };
                });

                const deviceResults = await Promise.all(devicePromises);
                return {
                    recipientId: user._id,
                    delivered: deviceResults.some((result) => result.success),
                    deviceResults
                };
            });

            const results = await Promise.allSettled(promises);

            // Count successes/failures per recipient
            results.forEach((result) => {
                if (result.status === 'fulfilled') {
                    if (result.value?.delivered) {
                        sentCount++;
                    } else {
                        failedCount++;
                    }
                } else {
                    failedCount++;
                }
            });

            // Update progress (Bull Board / UI ke liye useful hota hai)
            await job.updateProgress({
                processed: Math.min(i + batchSize, users.length),
                total: users.length,
                sent: sentCount,
                failed: failedCount
            });
        }

        // Update notification delivery count
        if (notificationId) {
            try {
                const notification = await Notification.findById(notificationId);
                if (notification) {
                    notification.deliveryCount = sentCount;
                    await notification.save();
                }
            } catch (error) {
                console.error('Error updating notification delivery count:', error);
            }
        }

        console.log(`✅ Notification sent to ${sentCount} users, failed: ${failedCount} (targetAudience: ${targetAudience})`);

        return {
            success: true,
            sentCount,
            failedCount,
            totalUsers: users.length
        };
    },
    {
        connection: redisConnection,
        concurrency: 5, // Process 5 jobs concurrently
        limiter: {
            max: 100, // Max 100 jobs
            duration: 1000, // Per second
        },
    }
);

// Worker event listeners
notificationWorker.on('completed', (job) => {
    console.log(`✅ Worker completed job ${job.id}`);
});

notificationWorker.on('failed', (job, err) => {
    console.error(`❌ Worker failed job ${job.id}:`, err.message);
});

notificationWorker.on('error', (err) => {
    console.error('❌ Worker error:', err);
});

// Graceful shutdown
process.on('SIGTERM', async () => {
    console.log('🛑 Closing notification worker...');
    await notificationWorker.close();
    process.exit(0);
});

module.exports = notificationWorker;

