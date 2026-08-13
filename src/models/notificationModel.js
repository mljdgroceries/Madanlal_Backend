const mongoose = require("mongoose");
const notificationSchema = new mongoose.Schema({
    type: {
        type: String,
        enum: ["push"],
        default: "push"
    },
    category: {
        type: String,
        enum: ["orderUpdates", "promotions", "deliveryAlerts", "general"]
    },
    targetAudience: {
        type: String,
        enum: ["all", "activeLast30Days", "newUsersLast7Days", "userInactive30Days", "specificUser", "specificDriver", "allDrivers", "allAdmins"],
        default: "all"
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "user",
        required: false
    },
    driverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "driver",
        required: false
    },
    title: String,
    message: String,
    scheduleOptions: {
        type: String,
        enum: ["now", "later"],
        default: "now"
    },
    scheduleDate: {
        type: String  // Format: YYYY-MM-DD
    },
    scheduleTime: {
        type: String  // Format: HH:mm or HH:mm:ss
    },
    sentAt: {
        type: Date
    },
    eventAt: {
        type: Date
    },
    deliveryCount: {
        type: Number,
        default: 0
    },
    openedCount: {
        type: Number,
        default: 0
    }
}, { timestamps: true });

// Indexes for better query performance
notificationSchema.index({ scheduleOptions: 1, scheduleDate: 1, scheduleTime: 1 }); // For cron job queries
notificationSchema.index({ sentAt: 1 }); // For filtering sent notifications
notificationSchema.index({ createdAt: -1 }); // For sorting by creation date

module.exports = mongoose.model("notification", notificationSchema);
