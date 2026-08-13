const mongoose = require("mongoose");

const bannerSchema = new mongoose.Schema(
  {
    title: String,
    festivalPromotionId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "festival"
    },
    description: String,
    status: {
      type: String,
      enum: ["Active", "Deleted", "Inactive"],
      default: "Active",
    },
    products: [{ type: mongoose.Schema.Types.ObjectId, ref: "product" }],
    // Store specific product variant selections for the banner
    selectedVariations: [
      {
        productId: { type: mongoose.Schema.Types.ObjectId, ref: "product" },
        variationId: { type: mongoose.Schema.Types.ObjectId },
      },
    ],
    
    startDate: Date,
    endDate: Date,
    bannerImage: String
  },
  { timestamps: true }
);

module.exports = mongoose.model("banner", bannerSchema);
