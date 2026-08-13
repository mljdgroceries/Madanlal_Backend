const crypto = require("crypto");
const razorpay = require("../../config/razorPay");

// models
const User = require("../../models/userModel");
const Product = require("../../models/productModel");
const Cart = require("../../models/cartModel");
const Coupons = require("../../models/promotionsAndCouponModal");
const CouponUsage = require("../../models/couponUsageModel");
const Zone = require("../../models/deliveryZonesModel");
const Order = require("../../models/orderModel");
const Notification = require("../../models/notificationModel");
const FreeItemRule = require("../../models/freeItemRuleModel");

// queue
const notificationQueue = require("../../queues/notificationQueue");

// utils
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");
const { catchAsyncError } = require("../../utils/generateError");
const ItemService = require("../../integrations/petpooja/services/itemService");
const salesOrderService = require("../../integrations/petpooja/services/salesOrderService");
const invoiceService = require("../../integrations/petpooja/services/invoiceService");
const partyService = require("../../integrations/petpooja/services/partyService");
const { getAutoApplicableCoupon } = require("../../helpers/autoCouponHelper");
const {
    validateCartStockWithPetpooja,
} = require("../../helpers/stockSyncHelper");
const { calculateExpectedDeliveryDate } = require("../../utils/deliveryDateCalculator");
const { reserveOrderItemsStock } = require("../../services/stockReservationService");

const EMPTY_PAYMENT_ID_FILTER = [
    { razorpayPaymentId: { $exists: false } },
    { razorpayPaymentId: null },
    { razorpayPaymentId: "" },
];

// create next custom order id
const generateCustomOrderId = async () => {
    const currentYear = new Date().getFullYear();
    const lastOrder = await Order.findOne(
        { orderId: { $regex: `^ORD-${currentYear}-` } },
        {},
        { sort: { createdAt: -1 } },
    );

    let orderNumber = 1;
    if (lastOrder && lastOrder.orderId) {
        const lastNumber = parseInt(lastOrder.orderId.split("-")[2], 10);
        orderNumber = Number.isNaN(lastNumber) ? 1 : lastNumber + 1;
    }

    return `ORD-${currentYear}-${orderNumber}`;
};

// validate checkout + build order draft payload
const buildPrepaidOrderDraft = async ({ userId, addressId, cartData }) => {
    const cart = await Cart.findOne({ userId }).populate("appliedCoupon");
    if (!cart || cart.items.length === 0) {
        throw new Error("Cart is empty.");
    }

    const user = await User.findById(userId);
    if (!user) throw new Error("User not found.");

    const address = user.addresses.id(addressId);
    if (!address) throw new Error("Address not found.");

    const addressPincode = address?.location?.pincode;
    if (!addressPincode) throw new Error("Address pincode is missing.");

    const activeZone = await Zone.findOne({
        "locations.pin": addressPincode,
        status: "Active",
    });
    if (!activeZone) {
        throw new Error(
            `We currently do not service the pincode ${addressPincode}. Please select another address.`,
        );
    }

    // Sync stock from Petpooja and validate cart quantities
    const stockResult = await validateCartStockWithPetpooja(cart.items);
    if (!stockResult.ok) {
        const err = new Error("Some items in your cart have insufficient stock. Please review your cart and try again.");
        err.stockIssues = stockResult.stockIssues;
        err.errorType = "INSUFFICIENT_STOCK";
        throw err;
    }

    const cartProductIds = [
        ...new Set(
            (cart.items || [])
                .map((item) => item.productId?.toString())
                .filter(Boolean),
        ),
    ];
    const productsForOrder = await Product.find({
        _id: { $in: cartProductIds },
    })
        .select("gst productVariations")
        .lean();
    const productGSTMap = new Map(
        productsForOrder.map((product) => [
            product._id.toString(),
            Number(product.gst) || 0,
        ]),
    );

    const orderItems = cart.items.map((item) => {
        const quantity = Number(item.quantity) || 0;
        const priceWithGST = Number(item.price) || 0; // GST-inclusive unit price
        const gstPercent = productGSTMap.get(item.productId.toString()) || 0;
        const unitBasePrice =
            gstPercent > 0 ? (priceWithGST * 100) / (100 + gstPercent) : priceWithGST;
        const unitGSTAmount = priceWithGST - unitBasePrice;
        const subtotal = priceWithGST * quantity;
        const gstAmount = unitGSTAmount * quantity;

        const product = productsForOrder.find(p => p._id.toString() === item.productId.toString());
        const variation = product?.productVariations?.find(v => v._id.toString() === item.variationId.toString());

        return {
            productId: item.productId,
            variationId: item.variationId,
            quantity,
            basePrice: Number(unitBasePrice.toFixed(2)),
            gstPercent,
            gstAmount: Number(gstAmount.toFixed(2)),
            priceWithGST: Number(priceWithGST.toFixed(2)),
            subtotal: Number(subtotal.toFixed(2)),
            petpoojaItemId: variation?.petpoojaItemId || null,
        };
    });

    const orderCreationTime = new Date();
    const { deliveryDate, deliveryTag, deliveryWindow } =
        await calculateExpectedDeliveryDate(orderCreationTime);

    // Compute totals server-side so prepaid orders always persist valid amounts.
    const subTotal = Number(
        orderItems.reduce((sum, item) => sum + Number(item.subtotal || 0), 0).toFixed(2),
    );

    // Keep prepaid free-item eligibility consistent with the regular order flow.
    let freeItemData = null;
    if (cartData?.freeItem?._id) {
        const currentDate = new Date();
        const candidateRules = await FreeItemRule.find({
            status: "Active",
            validFrom: { $lte: currentDate },
            validUntil: { $gte: currentDate },
            freeItems: cartData.freeItem._id,
        }).populate("freeItems");

        const normalizedRules = candidateRules
            .map((rule) => ({
                rule,
                minOrderValue: Number(rule.minOrderValue),
                freeQty: Number(rule.freeItemQuantity) || 1,
                stock: Number(rule.freeItems?.stock ?? 0),
                usageLimit: Number(rule.usageLimitPerCustomer) || 1,
            }))
            .filter(
                (entry) =>
                    Number.isFinite(entry.minOrderValue) &&
                    entry.rule?.freeItems &&
                    entry.stock >= entry.freeQty,
            );

        const rulesWithUsage = await Promise.all(
            normalizedRules.map(async (entry) => {
                const usedCount = await Order.countDocuments({
                    userId,
                    status: { $nin: ["Cancelled", "PaymentPending"] },
                    "freeItem.productId": entry.rule.freeItems._id,
                    createdAt: {
                        $gte: entry.rule.validFrom,
                        $lte: entry.rule.validUntil,
                    },
                });

                return {
                    ...entry,
                    remainingUses: Math.max(entry.usageLimit - usedCount, 0),
                };
            }),
        );

        const selectedRule = rulesWithUsage
            .filter(
                (entry) => entry.remainingUses > 0 && subTotal >= entry.minOrderValue,
            )
            .sort((a, b) => b.minOrderValue - a.minOrderValue)[0];

        if (selectedRule) {
            freeItemData = {
                productId: selectedRule.rule.freeItems._id,
                productName: selectedRule.rule.freeItems.productName,
                productImage: selectedRule.rule.freeItems.productImage,
                quantity: selectedRule.freeQty,
            };
        }
    }
    // Determine coupon discount (auto‑apply if none manually applied)
    let couponDiscount = 0;
    if (cart.appliedCoupon) {
        const coupon = await Coupons.findById(cart.appliedCoupon);
        if (coupon) {
            if (coupon.discountType === "Percentage") {
                couponDiscount = Number(((coupon.discountValue / 100) * subTotal).toFixed(2));
                if (coupon.maxDiscount && couponDiscount > coupon.maxDiscount) couponDiscount = coupon.maxDiscount;
            } else if (coupon.discountType === "FixedAmount") {
                couponDiscount = Number(coupon.discountValue);
            }
        }
    } else {
        const { coupon } = await getAutoApplicableCoupon(userId, cart, subTotal);
        if (coupon) {
            cart.appliedCoupon = coupon._id;
            if (coupon.discountType === "Percentage") {
                couponDiscount = Number(((coupon.discountValue / 100) * subTotal).toFixed(2));
                if (coupon.maxDiscount && couponDiscount > coupon.maxDiscount) couponDiscount = coupon.maxDiscount;
            } else if (coupon.discountType === "FixedAmount") {
                couponDiscount = Number(coupon.discountValue);
            }
        }
    }
    const deliveryCharge = Number(cartData?.deliveryCharge) || 0;
    const platformFee = Number(cartData?.platformFee) || 0;
    const grandTotal = Number(
        Math.max(subTotal + deliveryCharge + platformFee - couponDiscount, 0).toFixed(2),
    );

    if (grandTotal <= 0) {
        throw new Error("Invalid payable amount.");
    }

    return {
        cart,
        user,
        address,
        orderItems,
        paymentAmountInPaise: Math.round(grandTotal * 100),
        orderDocPayload: {
            userId,
            items: orderItems,
            deliveryAddress: {
                fullName: address.fullName,
                area_building: address.area_building,
                houseFlatOfficeNo: address.houseFlatOfficeNo,
                address: address.location.address,
                pincode: address.location.pincode,
                landmark: address.location.landmark,
                phoneNumber: address.phoneNumber,
                addressType: address.addressType,
                coordinates: address.location.coordinates,
            },
            appliedCoupon: cart.appliedCoupon?._id || null,
            couponCode: cart.appliedCoupon?.couponCode || null,
            couponDiscount,
            deliveryCharge,
            platformFee,
            freeItem: freeItemData,
            totalItems: orderItems.reduce((sum, i) => sum + i.quantity, 0),
            subTotal,
            grandTotal,
            paymentMethod: "Prepaid",
            paymentStatus: "Pending",
            expectedDeliveryDate: deliveryDate,
            deliveryTag,
            deliveryWindow,
            status: "PaymentPending",
        },
    };
};

const deductOrderStockOnce = async (orderDoc) => {
    const lockedOrder = await Order.findOneAndUpdate(
        { _id: orderDoc._id, stockDeducted: { $ne: true } },
        { $set: { stockDeducted: true, stockDeductedAt: new Date() } },
        { new: true },
    );

    if (!lockedOrder) return false;

    try {
        await reserveOrderItemsStock(orderDoc.items);
    } catch (error) {
        await Order.updateOne(
            { _id: orderDoc._id },
            { $set: { stockDeducted: false }, $unset: { stockDeductedAt: 1 } },
        );
        throw error;
    }

    return true;
};

// helper: finalize order after payment is marked Paid
const finalizePaidOrder = async (orderDoc) => {
    await deductOrderStockOnce(orderDoc);

    // clear cart
    await Cart.findOneAndDelete({ userId: orderDoc.userId });

    // coupon usage update
    if (orderDoc.appliedCoupon) {
        await Coupons.findByIdAndUpdate(orderDoc.appliedCoupon, {
            $inc: { usageUsed: 1 },
        });

        await CouponUsage.findOneAndUpdate(
            { userId: orderDoc.userId, couponId: orderDoc.appliedCoupon },
            { $inc: { usedCount: 1 } },
            { upsert: true },
        );
    }

    // push notification
    try {
        const userForNotif = await User.findById(orderDoc.userId).select(
            "notificationPreferences",
        );
        const isOrderUpdateOn = userForNotif?.notificationPreferences?.orderUpdates !== false;

        if (isOrderUpdateOn) {
            const notificationPayload = {
                userId: orderDoc.userId,
                targetAudience: "specificUser",
                title: "Order Update: Placed! 🎉",
                message: `Your order #${orderDoc.orderId} has been successfully placed. We will deliver it soon!`,
                type: "push",
                category: "orderUpdates",
                scheduleOptions: "now",
                sentAt: new Date(),
            };

            const notification = await Notification.create(notificationPayload);

            await notificationQueue.add("send-notification", {
                notificationId: notification._id.toString(),
                targetAudience: "specificUser",
                userId: orderDoc.userId.toString(),
                category: "orderUpdates",
                title: notificationPayload.title,
                message: notificationPayload.message,
                type: "push",
            });
        }
    } catch (err) {
        console.error("Error sending order placement notification:", err);
    }
};

const syncPaidOrderToPetpooja = async (orderDoc) => {
    if (!orderDoc || orderDoc.petpoojaVoucherId) return orderDoc;
    if (["PaymentPending", "Pending", "Cancelled"].includes(orderDoc.status)) {
        console.log(`[PETPOOJA-PREPAID] Skipping sync for order ${orderDoc.orderId} while status is ${orderDoc.status}.`);
        return orderDoc;
    }

    try {
        const user = await User.findById(orderDoc.userId);
        if (!user) {
            console.warn(`[PETPOOJA-PREPAID] Cannot sync order ${orderDoc.orderId}: user not found.`);
            return orderDoc;
        }

        try {
            const partySync = await partyService.syncUserParty(user);

            if (!orderDoc.billingPetpoojaAddressId && partySync.billingAddressId) {
                orderDoc.billingPetpoojaAddressId = partySync.billingAddressId;
            }
            if (!orderDoc.shippingPetpoojaAddressId && partySync.shippingAddressId) {
                orderDoc.shippingPetpoojaAddressId = partySync.shippingAddressId;
            }
        } catch (syncError) {
            console.error("[PETPOOJA-PREPAID] Failed to sync customer:", syncError.message);
        }

        if (!user.petpoojaCustomerId) {
            console.warn(`[PETPOOJA-PREPAID] Cannot sync Sales Order: User ${orderDoc.userId} is not synced to Petpooja.`);
            await orderDoc.save();
            return orderDoc;
        }

        const result = await salesOrderService.createSalesOrder(orderDoc, user);
        if (!result?.voucherId) {
            console.warn(`[PETPOOJA-PREPAID] Sales Order response missing voucherId for order ${orderDoc.orderId}:`, JSON.stringify(result));
            await orderDoc.save();
            return orderDoc;
        }

        orderDoc.petpoojaVoucherId = String(result.voucherId);
        orderDoc.petpoojaVoucherNumber = result.voucherNumber ? String(result.voucherNumber) : null;
        await orderDoc.save();

        console.log("[PETPOOJA-PREPAID] Skipping immediate stock pull after sales order to preserve locally deducted admin stock.");

        try {
            const voucherSeriesObj = await invoiceService.initVoucher();
            const templateObj = await invoiceService.initTemplate();
            const customChargeObj = await salesOrderService.getCustomCharge();

            const invoiceResult = await invoiceService.createInvoice(
                orderDoc.petpoojaVoucherId,
                orderDoc,
                user,
                templateObj ? templateObj.id : null,
                customChargeObj ? customChargeObj.id : null,
                voucherSeriesObj ? voucherSeriesObj.id : null,
                "sent",
            );

            if (invoiceResult?.voucherId) {
                orderDoc.invoiceId = String(invoiceResult.voucherId);
                orderDoc.invoiceNumber = invoiceResult.voucherNumber ? String(invoiceResult.voucherNumber) : null;
                await orderDoc.save();
            }
        } catch (invErr) {
            console.error("[PETPOOJA-PREPAID] Invoice Creation Error:", invErr.message);
        }
    } catch (petpoojaError) {
        console.error("[PETPOOJA-PREPAID] Sales Order Creation Error:", petpoojaError.message);
    }

    return orderDoc;
};

//  createOrder (Razorpay order create + internal pending order)
exports.createOrder = catchAsyncError(async (req, res) => {
    const userId = req.user?._id || req.user._id;
    const { addressId, cartData } = req.body;

    if (!addressId || !cartData) {
        return responseHandler({ res, code: statusCode.DATAMISSING, message: "addressId and cartData are required.", });
    }

    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
        return responseHandler({ res, code: statusCode.DATAMISSING, message: "Razorpay keys are not configured.", });
    }

    try {
        const draft = await buildPrepaidOrderDraft({ userId, addressId, cartData });
        const customOrderId = await generateCustomOrderId();

        // Razorpay order
        const rzOrder = await razorpay.orders.create({
            amount: draft.paymentAmountInPaise,
            currency: "INR",
            receipt: customOrderId,
            notes: {
                appOrderId: customOrderId,
                userId: userId.toString(),
            },
        });

        // internal order
        const order = await Order.create({
            ...draft.orderDocPayload,
            orderId: customOrderId,
            razorpayOrderId: rzOrder.id,
        });

        return responseHandler({
            res, code: statusCode.SUCCESS, message: "Razorpay order created successfully.",
            data: {
                orderId: order._id,
                appOrderId: order.orderId,
                razorpayOrderId: rzOrder.id,
                amount: rzOrder.amount,
                currency: rzOrder.currency,
                key: process.env.RAZORPAY_KEY_ID,
            },
        });
    } catch (err) {
        if (err.stockIssues) {
            return responseHandler({
                res,
                code: statusCode.DATAMISSING,
                message: err.message,
                data: { stockIssues: err.stockIssues, errorType: err.errorType || "INSUFFICIENT_STOCK" },
            });
        }

        return responseHandler({ res, code: statusCode.DATAMISSING, message: err.message || "Unable to create payment order.", });
    }
});



// 2) verifyOrder (client callback after successful payment)
// exports.verifyOrder = catchAsyncError(async (req, res) => {
//     const userId = req.user._id;
//     const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

//     if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
//         return responseHandler({ res, code: statusCode.DATAMISSING, message: "razorpayOrderId, razorpayPaymentId and razorpaySignature are required.", });
//     }

//     if (!process.env.RAZORPAY_KEY_SECRET) {
//         return responseHandler({ res, code: statusCode.DATAMISSING, message: "Razorpay secret is not configured.", });
//     }
    
//     const baseOrder = await Order.findOne({
//         userId,
//         razorpayOrderId,
//         paymentMethod: "Prepaid",
//     });

//     if (!baseOrder) {
//         return responseHandler({ res, code: statusCode.RESULTNOTFOUND, message: "Order not found for this payment.", });
//     }

//     if (baseOrder.paymentStatus === "Paid") {
//         return responseHandler({ res, code: statusCode.SUCCESS, message: "Payment already verified.", data: baseOrder, });
//     }

//     const body = `${razorpayOrderId}|${razorpayPaymentId}`;
//     const expectedSignature = crypto
//         .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
//         .update(body)
//         .digest("hex");

//     if (expectedSignature !== razorpaySignature) {
//         await Order.findOneAndUpdate(
//             { userId, razorpayOrderId },
//             { $set: { paymentStatus: "Failed" } },
//         );
//         return responseHandler({ res, code: statusCode.FORBIDDEN, message: "Invalid payment signature.", });
//     }

//     // Acquire lock once for this prepaid order by storing payment id/signature only once.
//     const lockedOrder = await Order.findOneAndUpdate(
//         {
//             userId,
//             razorpayOrderId,
//             paymentMethod: "Prepaid",
//             paymentStatus: "Pending",
//             $or: EMPTY_PAYMENT_ID_FILTER,
//         },
//         {
//             $set: {
//                 razorpayPaymentId,
//                 razorpaySignature,
//             },
//         },
//         { new: true },
//     );

//     if (!lockedOrder) {
//         const existing = await Order.findOne({ userId, razorpayOrderId });

//         if (existing && existing.paymentStatus === "Paid") {
//             return responseHandler({
//                 res,
//                 code: statusCode.SUCCESS,
//                 message: "Payment already verified.",
//                 data: existing,
//             });
//         }

//         if (
//             existing &&
//             existing.paymentStatus === "Pending" &&
//             existing.razorpayPaymentId === razorpayPaymentId
//         ) {
//             await finalizePaidOrder(existing);
//             const paidOrder = await Order.findOneAndUpdate(
//                 { _id: existing._id, paymentStatus: "Pending" },
//                 { $set: { paymentStatus: "Paid" } },
//                 { new: true },
//             );

//             return responseHandler({
//                 res,
//                 code: statusCode.SUCCESS,
//                 message: "Payment verified and order finalized successfully.",
//                 data: paidOrder || existing,
//             });
//         }

//         return responseHandler({ res, code: statusCode.RESULTNOTFOUND, message: "Payment is already being processed. Please retry after a moment.", });
//     }

//     await finalizePaidOrder(lockedOrder);

//     const paidOrder = await Order.findOneAndUpdate(
//         { _id: lockedOrder._id, paymentStatus: "Pending" },
//         { $set: { paymentStatus: "Paid" } },
//         { new: true },
//     );

//     return responseHandler({ res, code: statusCode.SUCCESS, message: "Payment verified and order finalized successfully.", data: paidOrder || lockedOrder, });
// });


exports.verifyOrder = catchAsyncError(async (req, res) => {
    const userId = req.user._id;
    const { razorpayOrderId, razorpayPaymentId, razorpaySignature } = req.body;

    if (!razorpayOrderId || !razorpayPaymentId || !razorpaySignature) {
        return responseHandler({
            res,
            code: statusCode.DATAMISSING,
            message: "razorpayOrderId, razorpayPaymentId and razorpaySignature are required.",
        });
    }

    if (!process.env.RAZORPAY_KEY_SECRET) {
        return responseHandler({
            res,
            code: statusCode.DATAMISSING,
            message: "Razorpay secret is not configured.",
        });
    }

    const baseOrder = await Order.findOne({
        userId,
        razorpayOrderId,
        paymentMethod: "Prepaid",
    });

    if (!baseOrder) {
        return responseHandler({
            res,
            code: statusCode.RESULTNOTFOUND,
            message: "Order not found for this payment.",
        });
    }

    if (baseOrder.paymentStatus === "Paid") {
        await deductOrderStockOnce(baseOrder);
        await syncPaidOrderToPetpooja(baseOrder);

        return responseHandler({
            res,
            code: statusCode.SUCCESS,
            message: "Payment already verified.",
            data: baseOrder,
        });
    }

    const body = `${razorpayOrderId}|${razorpayPaymentId}`;
    const expectedSignature = crypto
        .createHmac("sha256", process.env.RAZORPAY_KEY_SECRET)
        .update(body)
        .digest("hex");

    if (expectedSignature !== razorpaySignature) {
        return responseHandler({
            res,
            code: statusCode.FORBIDDEN,
            message: "Invalid payment signature.",
        });
    }

    let payment;
    try {
        payment = await razorpay.payments.fetch(razorpayPaymentId);
    } catch (err) {
        console.error("Razorpay payment fetch failed:", err?.error || err);
        return responseHandler({
            res,
            code: statusCode.DATAMISSING,
            message: "Unable to fetch payment details from Razorpay.",
        });
    }

    const paidOrderId = payment?.order_id;
    const paidAmount = Number(payment?.amount) || 0;
    const expectedAmount = Math.round((Number(baseOrder.grandTotal) || 0) * 100);

    if (!paidOrderId || paidOrderId !== razorpayOrderId) {
        return responseHandler({
            res,
            code: statusCode.DATAMISSING,
            message: "Payment order mismatch.",
        });
    }

    if (payment?.status !== "captured") {
        if (payment?.status === "failed") {
            await Order.findOneAndUpdate(
                { _id: baseOrder._id, paymentStatus: { $ne: "Paid" } },
                {
                    $set: {
                        paymentStatus: "Failed",
                        status: "Cancelled",
                        "tracking.isCancelled": true,
                        "tracking.cancelledAt": new Date(),
                    },
                },
            );
        }

        return responseHandler({
            res,
            code: statusCode.DATAMISSING,
            message: "Payment is not captured yet.",
        });
    }

    if (expectedAmount <= 0 || paidAmount < expectedAmount) {
        await Order.findOneAndUpdate(
            { _id: baseOrder._id, paymentStatus: { $ne: "Paid" } },
            {
                $set: {
                    paymentStatus: "Failed",
                    status: "Cancelled",
                    "tracking.isCancelled": true,
                    "tracking.cancelledAt": new Date(),
                },
            },
        );

        return responseHandler({
            res,
            code: statusCode.DATAMISSING,
            message: "Payment amount mismatch.",
        });
    }

    const lockedOrder = await Order.findOneAndUpdate(
        {
            userId,
            razorpayOrderId,
            paymentMethod: "Prepaid",
            paymentStatus: "Pending",
            $or: EMPTY_PAYMENT_ID_FILTER,
        },
        {
            $set: {
                razorpayPaymentId,
                razorpaySignature,
            },
        },
        { new: true },
    );

    if (!lockedOrder) {
        const existing = await Order.findOne({ userId, razorpayOrderId });

        if (existing && existing.paymentStatus === "Paid") {
            await syncPaidOrderToPetpooja(existing);

            return responseHandler({
                res,
                code: statusCode.SUCCESS,
                message: "Payment already verified.",
                data: existing,
            });
        }

        if (
            existing &&
            existing.paymentStatus === "Pending" &&
            existing.razorpayPaymentId === razorpayPaymentId
        ) {
            await finalizePaidOrder(existing);

            const paidOrder = await Order.findOneAndUpdate(
                { _id: existing._id, paymentStatus: "Pending" },
                {
                    $set: {
                        paymentStatus: "Paid",
                        status: "Pending",
                    },
                },
                { new: true },
            );

            await syncPaidOrderToPetpooja(paidOrder || existing);

            return responseHandler({
                res,
                code: statusCode.SUCCESS,
                message: "Payment verified and order finalized successfully.",
                data: paidOrder || existing,
            });
        }

        return responseHandler({
            res,
            code: statusCode.RESULTNOTFOUND,
            message: "Payment is already being processed. Please retry after a moment.",
        });
    }

    await finalizePaidOrder(lockedOrder);

    const paidOrder = await Order.findOneAndUpdate(
        { _id: lockedOrder._id, paymentStatus: "Pending" },
        {
            $set: {
                paymentStatus: "Paid",
                status: "Pending",
            },
        },
        { new: true },
    );

    await syncPaidOrderToPetpooja(paidOrder || lockedOrder);

    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Payment verified and order finalized successfully.",
        data: paidOrder || lockedOrder,
    });
});



// webhook (Razorpay server callback)
// exports.razorpayWebhook = async (req, res) => {
//     try {
//         const signature = req.headers["x-razorpay-signature"];
//         const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

//         if (!signature || !webhookSecret || !req.body) {
//             return responseHandler({ res, code: statusCode.DATAMISSING, message: "Missing signature, webhook secret, or request body.", });
//         }

//         const expected = crypto
//             .createHmac("sha256", webhookSecret)
//             .update(req.body)
//             .digest("hex");

//         if (expected !== signature) {
//             return responseHandler({
//                 res, code: statusCode.FORBIDDEN, message: "Invalid signature",
//             });
//         }

//         const event = JSON.parse(req.body.toString("utf8"));

//         if (event.event === "payment.captured") {
//             const entity = event.payload.payment.entity;
//             const razorpayOrderId = entity.order_id;
//             const razorpayPaymentId = entity.id;
//             const paidAmount = Number(entity.amount) || 0;

//             const orderForAmountValidation = await Order.findOne({
//                 razorpayOrderId,
//                 paymentMethod: "Prepaid",
//             });

//             if (!orderForAmountValidation) {
//                 return responseHandler({ res, code: statusCode.RESULTNOTFOUND, message: "Order not found.", });
//             }

//             const expectedAmount = Math.round(
//                 (Number(orderForAmountValidation.grandTotal) || 0) * 100,
//             );

//             if (expectedAmount <= 0 || paidAmount !== expectedAmount) {
//                 await Order.findOneAndUpdate(
//                     { _id: orderForAmountValidation._id, paymentStatus: { $ne: "Paid" } },
//                     { $set: { paymentStatus: "Failed" } },
//                 );

//                 return responseHandler({ res, code: statusCode.BADREQUEST, message: "Payment amount mismatch", });
//             }

//             const lockedOrder = await Order.findOneAndUpdate(
//                 {
//                     razorpayOrderId,
//                     paymentMethod: "Prepaid",
//                     paymentStatus: "Pending",
//                     $or: EMPTY_PAYMENT_ID_FILTER,
//                 },
//                 {
//                     $set: {
//                         razorpayPaymentId,
//                     },
//                 },
//                 { new: true },
//             );

//             if (!lockedOrder) {
//                 const existing = await Order.findOne({ razorpayOrderId });
//                 if (
//                     existing &&
//                     existing.paymentStatus === "Pending" &&
//                     existing.razorpayPaymentId === razorpayPaymentId
//                 ) {
//                     await finalizePaidOrder(existing);
//                     await Order.findOneAndUpdate(
//                         { _id: existing._id, paymentStatus: "Pending" },
//                         { $set: { paymentStatus: "Paid" } },
//                     );
//                 }
//             } else {
//                 await finalizePaidOrder(lockedOrder);
//                 await Order.findOneAndUpdate(
//                     { _id: lockedOrder._id, paymentStatus: "Pending" },
//                     { $set: { paymentStatus: "Paid" } },
//                 );
//             }
//         }

//         if (event.event === "payment.failed") {
//             const entity = event.payload.payment.entity;
//             const razorpayOrderId = entity.order_id;

//             await Order.findOneAndUpdate(
//                 { razorpayOrderId, paymentStatus: { $ne: "Paid" } },
//                 { $set: { paymentStatus: "Failed" } },
//             );
//         }

//         return responseHandler({ res, code: statusCode.SUCCESS, message: "Webhook processed successfully." });
//     } catch (err) {
//         console.error("Razorpay webhook error:", err);
//         return responseHandler({ res, code: statusCode.ERROR, message: "Webhook error" });
//     }
// };


exports.razorpayWebhook = async (req, res) => {
    try {
        const signature = req.headers["x-razorpay-signature"];
        const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

        if (!signature || !webhookSecret || !req.body) {
            return responseHandler({ res, code: statusCode.DATAMISSING, message: "Missing signature, webhook secret, or request body.", });
        }

        const expected = crypto
            .createHmac("sha256", webhookSecret)
            .update(req.body)
            .digest("hex");

        if (expected !== signature) {
            return responseHandler({
                res, code: statusCode.FORBIDDEN, message: "Invalid signature",
            });
        }

        const event = JSON.parse(req.body.toString("utf8"));

        if (event.event === "payment.captured") {
            const entity = event.payload.payment.entity;
            const razorpayOrderId = entity.order_id;
            const razorpayPaymentId = entity.id;
            const paidAmount = Number(entity.amount) || 0;

            const orderForAmountValidation = await Order.findOne({
                razorpayOrderId,
                paymentMethod: "Prepaid",
            });

            if (!orderForAmountValidation) {
                return responseHandler({ res, code: statusCode.RESULTNOTFOUND, message: "Order not found.", });
            }

            const expectedAmount = Math.round(
                (Number(orderForAmountValidation.grandTotal) || 0) * 100,
            );

            if (expectedAmount <= 0 || paidAmount < expectedAmount) {
                await Order.findOneAndUpdate(
                    { _id: orderForAmountValidation._id, paymentStatus: { $ne: "Paid" } },
                    {
                        $set: {
                            paymentStatus: "Failed",
                            status: "Cancelled",
                            "tracking.isCancelled": true,
                            "tracking.cancelledAt": new Date(),
                        },
                    },
                );

                return responseHandler({ res, code: statusCode.DATAMISSING, message: "Payment amount mismatch", });
            }

            const lockedOrder = await Order.findOneAndUpdate(
                {
                    razorpayOrderId,
                    paymentMethod: "Prepaid",
                    paymentStatus: "Pending",
                    $or: EMPTY_PAYMENT_ID_FILTER,
                },
                {
                    $set: {
                        razorpayPaymentId,
                    },
                },
                { new: true },
            );

            if (!lockedOrder) {
                const existing = await Order.findOne({ razorpayOrderId });
                if (
                    existing &&
                    existing.paymentStatus === "Pending" &&
                    existing.razorpayPaymentId === razorpayPaymentId
                ) {
                    await finalizePaidOrder(existing);
                    const paidOrder = await Order.findOneAndUpdate(
                        { _id: existing._id, paymentStatus: "Pending" },
                        {
                            $set: {
                                paymentStatus: "Paid",
                                status: "Pending",
                            },
                        },
                        { new: true },
                    );
                    await syncPaidOrderToPetpooja(paidOrder || existing);
                }
            } else {
                await finalizePaidOrder(lockedOrder);
                const paidOrder = await Order.findOneAndUpdate(
                    { _id: lockedOrder._id, paymentStatus: "Pending" },
                    {
                        $set: {
                            paymentStatus: "Paid",
                            status: "Pending",
                        },
                    },
                    { new: true },
                );
                await syncPaidOrderToPetpooja(paidOrder || lockedOrder);
            }
        }

        if (event.event === "payment.failed") {
            const entity = event.payload.payment.entity;
            const razorpayOrderId = entity.order_id;

            await Order.findOneAndUpdate(
                { razorpayOrderId, paymentStatus: { $ne: "Paid" } },
                {
                    $set: {
                        paymentStatus: "Failed",
                        status: "Cancelled",
                        "tracking.isCancelled": true,
                        "tracking.cancelledAt": new Date(),
                    },
                },
            );
        }

        return responseHandler({ res, code: statusCode.SUCCESS, message: "Webhook processed successfully." });
    } catch (err) {
        console.error("Razorpay webhook error:", err);
        return responseHandler({ res, code: statusCode.ERROR, message: "Webhook error" });
    }
};
