const mongoose = require("mongoose");

const orderItemSchema = new mongoose.Schema({
  productId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "product",
    required: true,
  },
  variationId: mongoose.Schema.Types.ObjectId,
  quantity: {
    type: Number,
    required: true,
  },
  basePrice: {
    //price before gst
    type: Number,
    required: true,
  },
  gstPercent: {
    type: Number,
    default: 0,
  },
  gstAmount: {
    type: Number,
    default: 0,
  },
  priceWithGST: {
    type: Number,
    default: 0,
  },
  subtotal: Number, // quantity * priceWithGST
  petpoojaItemId: { type: String, default: null },
});

const orderSchema = new mongoose.Schema(
  {
    orderId: { type: String },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },
    items: [orderItemSchema],
    returnedItemsDetails: [
      {
        productId: { type: mongoose.Schema.Types.ObjectId, ref: "product" },
        productName: String,
        productImages: String,
        variationId: mongoose.Schema.Types.ObjectId,
        quantity: Number,
        basePrice: Number,
        priceWithGST: Number,
        gstPercent: { type: Number, default: 0 },
        gstAmount: { type: Number, default: 0 },
        subtotal: { type: Number, default: 0 },
        measurmentUnit: { type: String, default: null },
        measurmentValue: { type: Number, default: null },
        petpoojaItemId: { type: String, default: null },
      },
    ],
    deliveryAddress: {
      fullName: String,
      houseFlatOfficeNo: String,
      address: String,
      pincode: String,
      landmark: String,
      phoneNumber: String,
      addressType: String,
      coordinates: {
        type: [Number], // [longitude, latitude]
        required: false,
        default: undefined,
        validate: {
          validator: function (coords) {
            return (
              coords === undefined ||
              (Array.isArray(coords) && coords.length === 2)
            );
          },
          message:
            "Coordinates must be empty or contain exactly two values: [longitude, latitude]",
        },
      },
    },
    appliedCoupon: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "coupons",
    },
    couponCode: String,
    couponDiscount: {
      type: Number,
      default: 0,
    },

    deliveryCharge: {
      type: Number,
      default: 0,
    },
    platformFee: {
      type: Number,
      default: 0,
    },
    freeItem: {
      productId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: "freeItem",
      },
      productName: String,
      productImage: String,
      quantity: Number,
    },
    totalItems: Number, // total quantity of all items
    // totalGST: Number, // total gst amount of all items
    subTotal: Number, // total of all items before discounts
    grandTotal: Number, // subTotal - couponDiscount + deliveryCharge
    paymentMethod: {
      type: String,
      enum: ["Prepaid", "COD"],
      required: true,
    },
    paymentStatus: {
      type: String,
      enum: ["Pending", "Paid", "Failed", "Refunded"],
      default: "Pending",
    },
    stockDeducted: {
      type: Boolean,
      default: false,
    },
    stockDeductedAt: Date,
    razorpayOrderId: String,
    razorpayPaymentId: String,
    razorpaySignature: String,
    status: {
      type: String,
      enum: [
        "PaymentPending",
        "Pending",
        "Confirmed",
        "Packed",
        "Shipped",
        "Delivered",
        "Cancelled",
        "Returned",
      ],
      default: "Pending",
    },
    tracking: {
      isConfirmed: {
        type: Boolean,
        default: false,
      },
      confirmedAt: Date,
      isPacked: {
        type: Boolean,
        default: false,
      },
      packedAt: Date,
      isShipped: {
        type: Boolean,
        default: false,
      },
      shippedAt: Date,
      isDelivered: {
        type: Boolean,
        default: false,
      },
      deliveredAt: Date,
      isCancelled: {
        type: Boolean,
        default: false,
      },
      cancelledAt: Date,
    },
    expectedDeliveryDate: Date,
    deliveryTag: {
      type: String,
      enum: ['SAME_DAY', 'NEXT_DAY']
    },
    deliveryWindow: {
      startTime: String,
      endTime: String
    },
    orderAssignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "driver",
    },
    isAutoAssigned: {
      type: Boolean,
      default: false,
    },
    driverStatus: {
      type: String,
      enum: ["Accepted", "Picked", "Reached"],
    },
    driverAcceptedAt: Date,
    driverReachedAt: Date,
    driverPickedAt: Date,
    cancelReason: {
      type: String,
      enum: [
        "Unreachable customer",
        "Wrong order",
        "Customer refusal",
        "Missing items",
        "Wrong location",
        "Emergencies or mechanical failure"
      ]
    },
    orderRating: {
      type: Number,
      min: 1,
      max: 5,
      default: null,
    },
    orderReview: {
      type: String,
      default: "",
    },
    driverRating: {
      type: Number,
      default: 0,
    },
    deliveryCount: {
      type: Number,
      default: 0,
    },
    codPaymentStatus: {
      type: String,
      enum: ["PaidOnline", "PaidInCash"]
    },
    petpoojaVoucherId: { type: String, default: null },
    petpoojaVoucherNumber: { type: String, default: null },
    // New fields for invoice and credit note tracking
    invoiceId: { type: String, default: null },
    invoiceNumber: { type: String, default: null },
    remainingPetpoojaVoucherId: { type: String, default: null },
    petpoojaCreditNoteId: { type: String, default: null },
    billingPetpoojaAddressId: { type: String, default: null },
    shippingPetpoojaAddressId: { type: String, default: null },
    returnAmount: { type: Number, default: 0 },
    returnedAt: Date,
    returnedItems: [
      {
        productId: { type: mongoose.Schema.Types.ObjectId, ref: "product" },
        variationId: mongoose.Schema.Types.ObjectId,
        quantity: Number,
        basePrice: Number,
      },
    ],
    totalRefundedAmount: { type: Number, default: 0 },
    refundStatus: {
      type: String,
      enum: ["none", "pending", "partial", "completed", "failed"],
      default: "none",
    },
    razorpayRefunds: [
      {
        refundId: String,
        amount: Number,
        currency: String,
        paymentId: String,
        status: String,
        speedProcessed: String,
        speedRequested: String,
        idempotencyKey: String,
        requestedAmountPaise: Number,
        returnItemsSnapshot: [mongoose.Schema.Types.Mixed],
        error: mongoose.Schema.Types.Mixed,
        rawResponse: mongoose.Schema.Types.Mixed,
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },

  { timestamps: true }
);

// Indexes for better query performance
orderSchema.index({ userId: 1 }); // For user order queries
orderSchema.index({ status: 1 }); // For filtering by status
orderSchema.index({ createdAt: -1 }); // For sorting by creation date
orderSchema.index({ orderId: 1 }); // For orderId lookups
orderSchema.index({ orderAssignedTo: 1 }); // For driver order queries
orderSchema.index({ userId: 1, status: 1 }); // Compound index for user orders by status
orderSchema.index({ status: 1, createdAt: -1 }); // Compound index for admin order queries
orderSchema.index({ orderAssignedTo: 1, status: 1 }); // Compound index for driver queries

module.exports = mongoose.model("order", orderSchema);
