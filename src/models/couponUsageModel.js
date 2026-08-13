const mongoose = require("mongoose");
const couponUsageSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: "user", required: true },
  couponId: { type: mongoose.Schema.Types.ObjectId, ref: "coupons", required: true },
  usedCount: { type: Number, default: 0 },
}, { timestamps: true });

// Indexes for better query performance
couponUsageSchema.index({ userId: 1 }); // For user coupon usage queries
couponUsageSchema.index({ couponId: 1 }); // For coupon usage queries
couponUsageSchema.index({ userId: 1, couponId: 1 }, { unique: true }); // Compound unique index - Ek particular user ke liye, ek particular coupon ka sirf EK document allowed hoga

module.exports = mongoose.model("coupon_usage", couponUsageSchema);
