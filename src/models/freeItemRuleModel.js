const mongoose = require("mongoose");

const freeItemRuleSchema = new mongoose.Schema(
  {
    ruleName: {
      type: String,
    },
    minOrderValue: {
      type: String,
    },
    usageLimitPerCustomer: {
      type: Number,
      default: 1,
    },
    validFrom: {
      type: Date,
    },
    validUntil: {
      type: Date,
    },
    description: {
      type: String,
    },
    freeItemQuantity:String,
    freeItems: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "freeItem",
    },
    status: {
      type: String,
      enum: ["Active", "Inactive", "Expired", "Deleted"],
      default: "Active",
    },
    isFirstTimeCustomer: { type: Boolean, default: false },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model("FreeItemRule", freeItemRuleSchema);
