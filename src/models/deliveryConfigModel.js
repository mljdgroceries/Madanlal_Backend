const mongoose = require("mongoose");

const deliveryRangeSchema = new mongoose.Schema({
  minAmount: { type: Number},
  maxAmount: { type: Number }, 
  deliveryCharge: { type: Number},
});

const deliveryOrderConfigSchema = new mongoose.Schema(
  {
    zoneId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Zone",
    },

    deliveryChargesEnabled: { type: Boolean, default: true },
    deliveryRanges: [deliveryRangeSchema],
 
    minOrderEnabled: { type: Boolean, default: true },
    minOrderValue: { type: Number },
    minOrderMessage: { type: String },

    platformFee: { type: Number },
  },
  { timestamps: true }
);

module.exports = mongoose.model("DeliveryOrderConfig", deliveryOrderConfigSchema);
