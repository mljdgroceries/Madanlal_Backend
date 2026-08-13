const mongoose = require("mongoose");

const driverSchema = new mongoose.Schema(
  {
    shortId: String,
    fullName: {
      type: String,
    },
    mobileNumber: {
      type: String,
    },
    email: String,
    driverImage: {
      type: String,
    },

    city: {
      type: String,
    },
    currentLocation: {
      type: {
        type: String,
        enum: ["Point"],
        default: "Point",
      },
      coordinates: {
        type: [Number], // [longitude, latitude]
        default: [0, 0],
      },
    },
    dateOfBirth: {
      type: Date,
    },
    assignedGeofenceAreas: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: "Zone",
      },
    ],
    vehicleType: {
      type: String,
      enum: ["Bike", "Scooter", "Car", "Van", "Truck"],
    },
    idProof: {
      type: String,
    },
    status: {
      type: String,
      enum: ["Active", "Inactive", "Deleted", "onDelivery"],
      default: "Active",
    },
    accessToken: {
      type: String,
    },
    deleteReason: {
      type: String,
      enum: [
        "I no longer use the app",
        "I found another platform",
        "Service issues",
        "Privacy concerns",
        "Other"
      ],
      default: null
    },
    deletedAt: { type: Date },


    averageRating: {
      type: Number,
      default: 0,
    },
    ratingCount: {
      type: Number,
      default: 0,
    },
    ratingSum: {
      type: Number,
      default: 0,
    },
    driverRating: {
      type: Number,
      default: 0,
    },

    availability: {
      type: Boolean,
      default: true,
    },

    otp: String,
    devices: [{
      deviceType: {
        type: String,
        enum: ["android", "ios", "web"]
      },
      deviceToken: {
        type: String
      },
      accessToken: {
        type: String,
        required: true
      }
    }]
  },
  { timestamps: true }
);

driverSchema.index({ currentLocation: "2dsphere" });

module.exports = mongoose.model("driver", driverSchema);
