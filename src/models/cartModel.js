const mongoose = require("mongoose");

const cartItemSchema = new mongoose.Schema({
    productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "product",
        required: true,
    },
    variationId: {
        type: mongoose.Schema.Types.ObjectId,
    },
    quantity: Number,
    price: Number,//price including gst
    totalPrice: Number,//price*quantity for particular item
});
const cartSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "user",
        required: true,
    },
    items: [cartItemSchema],
    appliedCoupon: {
        type: mongoose.Schema.Types.ObjectId, ref: "coupons"
    },
}, { timestamps: true });

// Indexes for better query performance
cartSchema.index({ userId: 1 }, { unique: true }); // One cart per user, frequently queried

module.exports = mongoose.model("cart", cartSchema);