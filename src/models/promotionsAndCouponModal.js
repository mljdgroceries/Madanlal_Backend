const mongoose = require("mongoose");
const Schema = mongoose.Schema;
const couponsSchema = new Schema({
    categoryId: [
        {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'category',
        }
    ],
    couponCode: {
        type: String,
        unique: true
    },
    title: {
        type: String
    },
    description: {
        type: String
    },
    discountType: {
        type: String,
        enum: ["Percentage", "FixedAmount", "FreeDelivery"]
    },
    discountValue: {
        type: Number
    },
    maxDiscount: {
        type: Number
    },
    minOrderValue: {
        type: Number
    },
    usageLimit: {
        type: Number
    },
    usageUsed: {
      type: Number,
      default: 0,
    },
    validFrom: {
        type: String
    },
    validTill: {
        type: String
    },
    userType: {
        type: String,
        enum: ["new", "existing", "all"]
    },
    usagePerUser: {
        type: Number
    },
    status: {
        type: String,
        enum: ["Active", "Inactive"],
        default: "Active"
    },
    autoApplyForEligibleOrders: {
        type: Boolean,
        default: false
    },
    isNotifyUsers: {
        type: Boolean,
        default: false
    }
}, { timestamps: true });

module.exports = mongoose.model("coupons", couponsSchema);