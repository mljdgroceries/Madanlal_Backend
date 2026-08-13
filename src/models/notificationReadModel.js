const mongoose = require("mongoose");

// Tracks which user/driver has read which notification
// Used for cross-device "viewed" status — if opened on device 1, shows as read on device 2 too
const notificationReadSchema = new mongoose.Schema({
    notificationId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "notification",
        required: true
    },
    adminId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "admin",
        default: null
    },
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "user",
        default: null
    },
    driverId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "driver",
        default: null
    }
}, { timestamps: true });

// Unique index: one user can only have one read record per notification
notificationReadSchema.index({ notificationId: 1, adminId: 1 }, { unique: true, sparse: true });
notificationReadSchema.index({ notificationId: 1, userId: 1 }, { unique: true, sparse: true });
notificationReadSchema.index({ notificationId: 1, driverId: 1 }, { unique: true, sparse: true });
notificationReadSchema.index({ adminId: 1 });  // Fast lookup for admin's read notifications
notificationReadSchema.index({ userId: 1 });   // Fast lookup for user's read notifications
notificationReadSchema.index({ driverId: 1 }); // Fast lookup for driver's read notifications

module.exports = mongoose.model("notificationRead", notificationReadSchema);
