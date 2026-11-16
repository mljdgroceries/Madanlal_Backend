const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const AddressSchema = new Schema({
    fullName: String,
    area_building: String,
    houseFlatOfficeNo: String,
    location: {
        type: {
            type: String,
            enum: ['Point'],
            default: 'Point',
        },
        coordinates: {
            type: [Number], // [longitude, latitude]
            required: false,
            default: undefined,
            validate: {
                validator: function (coords) {
                    return coords === undefined || require('../helpers/distanceDeliveryHelper').validCoordinates(coords);
                },
                message: "Coordinates must contain valid [longitude, latitude] values",
            },
        },
        address: String,
        pincode: String,
        landmark: String,
    },
    callingCode: String,
    countryCode: String,
    phoneNumber: String,
    isDefault: { type: Boolean, default: false },
    isSelected: { type: Boolean, default: false },
    deliveryInstructions: String,
    addressType: {
        type: String,
        enum: ["Home", "Office", "Other"],
        default: "Home",
    }
});
const DeviceSchema = new Schema({
    deviceType: {
        type: String,
        enum: ["android", "ios", "web"],
        // required: true
    },
    deviceToken: {
        type: String,
        // required: true
    },
    accessToken: {
        type: String,   // JWT per device
        required: true
    }
});
const UserSchema = new Schema({
    shortId: String,
    phone: String,
    notes: String,
    profileImage: String,
    addresses: [AddressSchema],
    role: {
        type: String,
        enum: ["user"],
        default: "user"
    },
    otp: String,
    // accessToken: String,
    status: {
        type: String,
        enum: ["Active", "Blocked", "Deleted"],
        default: "Active"
    },
    petpoojaCustomerId: { type: String, default: null },
    devices: [DeviceSchema],
    notificationPreferences: {
        orderUpdates: { type: Boolean, default: true },
        promotions: { type: Boolean, default: true },
        deliveryAlerts: { type: Boolean, default: true }
    },
}, { timestamps: true });

// Indexes for better query performance
UserSchema.index({ phone: 1 }); // For login and search queries
UserSchema.index({ status: 1 }); // For filtering by status
UserSchema.index({ createdAt: -1 }); // For sorting by creation date
UserSchema.index({ shortId: 1 }); // For shortId lookups
UserSchema.index({ status: 1, createdAt: -1 }); // Compound index for admin queries

module.exports = mongoose.model("user", UserSchema);
