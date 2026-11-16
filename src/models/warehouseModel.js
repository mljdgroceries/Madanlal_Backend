const mongoose = require("mongoose");

const warehouseSchema = new mongoose.Schema(
  {
    warehouseName: { type: String, trim: true, default: "" },
    coordinates: {
      type: [Number],
      default: undefined,
      validate: {
        validator: (value) => value === undefined || require("../helpers/distanceDeliveryHelper").validCoordinates(value),
        message: "coordinates must be [longitude, latitude] within valid bounds.",
      },
    },
    address: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
    },
    phone: {
      type: String,
      trim: true,
    },
    isDefault: {
      type: Boolean,
      default: false,
    },
    isActive: {
      type: Boolean,
      default: true,
    },
  },
  { timestamps: true, toJSON: { virtuals: true }, toObject: { virtuals: true } }
);

warehouseSchema.virtual("latitude").get(function () { return this.coordinates?.[1] ?? null; });
warehouseSchema.virtual("longitude").get(function () { return this.coordinates?.[0] ?? null; });

module.exports = mongoose.model("warehouse", warehouseSchema);
