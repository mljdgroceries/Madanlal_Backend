const mongoose = require("mongoose");
const rangeSchema = new mongoose.Schema({
  distanceFrom: { type: Number, required: true, min: 0 },
  distanceTo: { type: Number, required: true, min: 0 },
  minOrderValue: { type: Number, required: true, min: 0 },
  deliveryChargePerKm: { type: Number, required: true, min: 0 },
  freeDeliveryAbove: { type: Number, required: true, min: 0 },
  minOrderMessage: { type: String, trim: true, default: "" },
}, { _id: false });
const schema = new mongoose.Schema({
  _id: { type: String, default: "global" },
  deliveryChargesEnabled: { type: Boolean, default: true },
  distanceCalculationMode: { type: String, enum: ["actual", "roundUp"], required: true },
  platformFee: { type: Number, required: true, min: 0 },
  distanceRanges: [rangeSchema],
}, { timestamps: true });
module.exports = mongoose.model("DistanceDeliveryConfig", schema);
