const mongoose = require("mongoose");

const zoneSchema = new mongoose.Schema(
  {
    zoneName: {
      type: String,
    },
    zoneCode: {
      type: String,
    },
    description: {
      type: String,
    },
    locations: [
      {
        pin: {
          type: String,
        },
        lat: {
          type: Number,
        },
        lng: {
          type: Number,
        },
      },
    ],
    // deliveryCharge: {
    //   type: Number,
    // },
    // freeDeliveryAbove: {
    //   type: Number,
    // },
    // deliveryTime: {
    //   type: String,
    //   //   enum: [
    //   //     "SameDay(Before3PM)",
    //   //     "NextDayDelivery",
    //   //     "Standard(2-3Days)",
    //   //     "Express(Within2Hours)",
    //   //   ],
    //   //   default: "SameDay(Before3PM)",
    // },
    priorityLevel: {
      type: String,
      enum: ["Low", "Medium", "High"],
      default: "Medium",
    },

    status: {
      type: String,
      enum: ["Active", "Inactive"],
      default: "Active",
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Zone", zoneSchema);
