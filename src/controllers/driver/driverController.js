const DRIVER = require("../../models/driverModel");
const Product = require("../../models/productModel");
const Coupon = require("../../models/promotionsAndCouponModal");
const Order = require("../../models/orderModel");
const User = require("../../models/userModel");
const { catchAsyncError } = require("../../utils/generateError");
const { generateOtp } = require("../../utils/otpGenerator");
const mongoose = require("mongoose");
const { responseHandler } = require("../../utils/responseHandler");
const { generateDriverToken } = require("../../utils/tokenUtils");
const statusCode = require("../../utils/httpResponseCode");
const Notification = require("../../models/notificationModel");
const NotificationRead = require("../../models/notificationReadModel");
const notificationQueue = require("../../queues/notificationQueue");
const msg91 = require("../../config/msg91");
const FreeItemRule = require("../../models/freeItemRuleModel");
const salesOrderService = require("../../integrations/petpooja/services/salesOrderService");
const {
  processDriverReturnRefund,
  processFullOrderCancelRefund,
} = require("../../services/razorpayRefundService");
const { syncVariationStockFromPetpooja } = require("../../helpers/stockSyncHelper");
const TEST_DRIVER_NUMBERS = ["9999999992"];
const TEST_OTP = "12345";

const removeFreeItemIfBelowRuleMinimum = async (order, subTotal) => {
  if (!order?.freeItem?.productId) return;

  const now = new Date();
  const matchingRule = await FreeItemRule.findOne({
    status: "Active",
    freeItems: order.freeItem.productId,
    validFrom: { $lte: now },
    validUntil: { $gte: now },
  }).lean();

  if (!matchingRule || Number(subTotal || 0) < Number(matchingRule.minOrderValue || 0)) {
    order.freeItem = null;
  }
};

const removeCouponIfBelowMinimumAfterReturn = async (order, subTotal) => {
  if (!order || Number(order.couponDiscount || 0) <= 0) return;

  let appliedCoupon = null;
  if (order.appliedCoupon) {
    appliedCoupon = await Coupon.findById(order.appliedCoupon).lean();
  } else if (order.couponCode) {
    appliedCoupon = await Coupon.findOne({
      couponCode: String(order.couponCode).toUpperCase(),
    }).lean();
  }

  const now = new Date();
  const validFrom = appliedCoupon?.validFrom ? new Date(appliedCoupon.validFrom) : null;
  const validTill = appliedCoupon?.validTill ? new Date(appliedCoupon.validTill) : null;
  const isDateValid =
    (!validFrom || now >= validFrom) && (!validTill || now <= validTill);
  const isStatusValid = appliedCoupon?.status === "Active";
  const meetsMinOrder =
    appliedCoupon && (!appliedCoupon.minOrderValue || Number(subTotal || 0) >= Number(appliedCoupon.minOrderValue));

  if (!appliedCoupon || !isStatusValid || !isDateValid || !meetsMinOrder) {
    order.appliedCoupon = null;
    order.couponCode = null;
    order.couponDiscount = 0;
  }
};

const prorateCouponForRemainingItems = (
  order,
  previousSubTotal,
  remainingSubTotal,
  previousCouponDiscount,
) => {
  if (!order || Number(order.couponDiscount || 0) <= 0) return;

  const baseSubTotal = Number(previousSubTotal || 0);
  const nextSubTotal = Number(remainingSubTotal || 0);
  const baseDiscount = Number(previousCouponDiscount || 0);

  if (baseSubTotal <= 0 || nextSubTotal <= 0 || baseDiscount <= 0) {
    order.couponDiscount = 0;
    return;
  }

  order.couponDiscount = Number(
    Math.min((baseDiscount * nextSubTotal) / baseSubTotal, nextSubTotal).toFixed(2),
  );
};

const calculateCouponDiscountForSubTotal = (coupon, subTotal) => {
  if (!coupon) return 0;

  const amount = Number(subTotal || 0);
  if (amount <= 0) return 0;

  if (coupon.discountType === "Percentage") {
    let discount = (amount * Number(coupon.discountValue || 0)) / 100;
    if (coupon.maxDiscount && discount > Number(coupon.maxDiscount)) {
      discount = Number(coupon.maxDiscount);
    }
    return Number(Math.min(discount, amount).toFixed(2));
  }

  if (coupon.discountType === "FixedAmount") {
    return Number(Math.min(Number(coupon.discountValue || 0), amount).toFixed(2));
  }

  return 0;
};

const appendDeliveryReturnBreakdown = (order) => {
  const deliveredItemsDetails = (order.items || []).map((item) => ({
    ...item,
    deliveredQty: Number(item.quantity) || 0,
    returnedQty: 0,
  }));

  const returnedItemsDetails = (order.returnedItemsDetails || []).map((item) => ({
    ...item,
    returnedQty: Number(item.quantity) || 0,
    deliveredQty: 0,
  }));

  const deliveredItemsCount = deliveredItemsDetails.reduce(
    (sum, item) => sum + (Number(item.deliveredQty) || 0),
    0,
  );
  const returnedItemsCount = returnedItemsDetails.reduce(
    (sum, item) => sum + (Number(item.returnedQty) || 0),
    0,
  );

  return {
    ...order,
    deliveredItemsDetails,
    returnedItemsDetails,
    deliveredItemsCount,
    returnedItemsCount,
  };
};

const buildRefundDetails = (order) => {
  const refunds = order?.razorpayRefunds || [];
  const latestRefund = refunds.length ? refunds[refunds.length - 1] : null;
  return {
    attempted: refunds.length > 0,
    status: order?.refundStatus || "none",
    amount: latestRefund?.amount || 0,
    amountRupees: latestRefund?.amount
      ? Number((Number(latestRefund.amount) / 100).toFixed(2))
      : Number(order?.totalRefundedAmount || 0),
    totalRefundedAmount: Number(order?.totalRefundedAmount || 0),
    razorpayRefundId: latestRefund?.refundId || null,
    paymentId: latestRefund?.paymentId || order?.razorpayPaymentId || null,
    idempotencyKey: latestRefund?.idempotencyKey || null,
    requestedAmountPaise: latestRefund?.requestedAmountPaise || 0,
    currency: latestRefund?.currency || "INR",
    error: latestRefund?.error || null,
    createdAt: latestRefund?.createdAt || null,
  };
};

const buildReturnOrderResponse = (order, returnedItemsDetails, refundSummary = null) => {
  const finalOrder = order.toObject();
  finalOrder.items = order.items.map((item) => {
    const product = item.productId;
    let variation = null;
    let variationImages = [];

    if (product?.productVariations?.length) {
      variation = product.productVariations.find(
        (v) => v._id.toString() === item.variationId.toString(),
      );
      if (variation) {
        variationImages = variation.productImages?.[0] || [];
      }
    }

    return {
      ...item.toObject(),
      productId: {
        _id: product._id,
        productName: product.productName,
        productImage: product.productImage,
        category: product.category,
      },
      priceWithGST: Number(item.priceWithGST ?? 0),
      unitPrice: Number(item.priceWithGST ?? 0),
      subtotal: Number(item.subtotal ?? 0),
      productImages: variationImages,
      measurmentUnit: variation?.measurmentUnit,
      measurmentValue: variation?.measurmentValue,
    };
  });

  finalOrder.returnedItemsDetails = returnedItemsDetails;
  finalOrder.items = applyPendingReturnsToItems(
    finalOrder.items,
    finalOrder.returnedItemsDetails,
  );
  const { subTotal: displaySubTotal, grandTotal: displayGrandTotal } =
    computeDriverDisplayTotals({
      items: finalOrder.items,
      deliveryCharge: Number(finalOrder.deliveryCharge || 0),
      platformFee: Number(finalOrder.platformFee || 0),
      couponDiscount: Number(finalOrder.couponDiscount || 0),
    });
  finalOrder.subTotal = displaySubTotal;
  finalOrder.grandTotal = displayGrandTotal;
  finalOrder.totalAmount = displayGrandTotal;
  finalOrder.netPayable = displayGrandTotal;
  finalOrder.total = displayGrandTotal;
  finalOrder.amount = displayGrandTotal;
  finalOrder.returnedItemsTotal = Number(
    (returnedItemsDetails || [])
      .reduce((sum, item) => sum + Number(item?.subtotal || 0), 0)
      .toFixed(2),
  );

  const orderWithBreakdown = appendDeliveryReturnBreakdown(finalOrder);
  const persistedReturnAmount =
    Number(order.returnAmount) > 0
      ? Number(order.returnAmount)
      : orderWithBreakdown.returnedItemsTotal;
  orderWithBreakdown.returnAmount = persistedReturnAmount;
  orderWithBreakdown.totalRefundedAmount = Number(order.totalRefundedAmount ?? 0);
  orderWithBreakdown.refundStatus = order.refundStatus || "none";
  orderWithBreakdown.refund = refundSummary || buildRefundDetails(order);
  return orderWithBreakdown;
};

const sendDriverOtpViaMsg91IfConfigured = async (phone, otp) => {
  try {
    if (!msg91.isConfigured()) return;
    await msg91.sendOtp(phone, otp);
  } catch (err) {
    console.error("Driver MSG91 OTP send failed:", err?.message || err);
  }
};

const resolveGstPercent = (...values) => {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return 0;
};

// For pre-delivery screens: show deliverable quantities after excluding
// quantities selected for return, without mutating persisted order items.
const applyPendingReturnsToItems = (items = [], returnedItems = []) => {
  const pendingQtyByVariation = new Map();

  (returnedItems || []).forEach((ret) => {
    const key = ret?.variationId?.toString?.();
    if (!key) return;
    pendingQtyByVariation.set(
      key,
      (pendingQtyByVariation.get(key) || 0) + (Number(ret?.quantity) || 0),
    );
  });

  return (items || [])
    .map((item) => {
      const key = item?.variationId?.toString?.();
      const currentQty = Number(item?.quantity || 0);
      const pendingQty = key ? pendingQtyByVariation.get(key) || 0 : 0;
      const displayQty = Math.max(currentQty - pendingQty, 0);
      if (displayQty <= 0) return null;

      const unitPrice = Number(item?.unitPrice ?? item?.priceWithGST ?? 0);
      return {
        ...item,
        quantity: displayQty,
        subtotal: Number((unitPrice * displayQty).toFixed(2)),
      };
    })
    .filter(Boolean);
};

const computeDriverDisplayTotals = ({
  items = [],
  deliveryCharge = 0,
  platformFee = 0,
  couponDiscount = 0,
}) => {
  const subTotal = Number(
    (items || [])
      .reduce((sum, item) => sum + Number(item?.subtotal || 0), 0)
      .toFixed(2),
  );
  const grandTotal = Number(
    Math.max(
      subTotal +
      Number(deliveryCharge || 0) +
      Number(platformFee || 0) -
      Number(couponDiscount || 0),
      0,
    ).toFixed(2),
  );
  return { subTotal, grandTotal };
};

exports.sendOtp = catchAsyncError(async (req, res) => {
  const { mobileNumber } = req.body;
  if (!mobileNumber) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Mobile number is required",
    });
  }

  // Check driver exists in DB
  const isDriverExists = await DRIVER.findOne({ mobileNumber });
  if (!isDriverExists) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "This mobile number is not registered. Contact admin.",
    });
  }

  // Generate OTP
  // const otp = generateOtp();
  const otp = TEST_DRIVER_NUMBERS.includes(mobileNumber)
  ? TEST_OTP
  : generateOtp();

  // Case 1: Active driver
  let activeDriver = await DRIVER.findOne({
    mobileNumber,
    status: "Active",
  }).sort({ createdAt: -1 });

  if (activeDriver) {
    activeDriver.otp = otp;
    await activeDriver.save();

    // await sendDriverOtpViaMsg91IfConfigured(mobileNumber, otp);
    if (!TEST_DRIVER_NUMBERS.includes(mobileNumber)) {
  await sendDriverOtpViaMsg91IfConfigured(mobileNumber, otp);
}

    return responseHandler({
      res,
      code: statusCode.SUCCESS,
      message: "OTP sent successfully",
      data: { mobileNumber },
    });
  }

  // Case 2: Blocked driver
  let blockedDriver = await DRIVER.findOne({ mobileNumber, status: "Blocked" });
  if (blockedDriver) {
    return responseHandler({
      res,
      code: statusCode.FORBIDDEN,
      message: "Your account has been blocked. Please contact admin.",
    });
  }

  // Case 3: Deleted driver → DO NOT CREATE NEW
  let deletedDriver = await DRIVER.findOne({ mobileNumber, status: "Deleted" });
  if (deletedDriver) {
    return responseHandler({
      res,
      code: statusCode.FORBIDDEN,
      message: "Your account is deleted. Contact admin.",
    });
  }

  // Case 4: No driver creation now → Just block OTP
  return responseHandler({
    res,
    code: statusCode.FORBIDDEN,
    message: "Your account is not active. Contact admin.",
  });
});
exports.driverLogin = catchAsyncError(async (req, res) => {
  const { mobileNumber, otp, deviceToken, deviceType } = req.body;

  if (!mobileNumber || !otp || !deviceToken || !deviceType) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message:
        "Mobile number and OTP and deviceToken and deviceType are required",
    });
  }

  // STEP 1: Driver must exist
  const isDriverExists = await DRIVER.findOne({
    mobileNumber,
    status: "Active",
  });
  if (!isDriverExists) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Mobile number is not registered. Contact admin.",
    });
  }

  // STEP 2: Deleted driver → block login
  if (isDriverExists.status === "Deleted") {
    return responseHandler({
      res,
      code: statusCode.FORBIDDEN,
      message: "Your account is deleted. Contact admin.",
    });
  }

  // STEP 3: Blocked driver → block login
  if (isDriverExists.status === "Blocked") {
    return responseHandler({
      res,
      code: statusCode.FORBIDDEN,
      message: "Your account has been blocked. Please contact admin.",
    });
  }

  // STEP 4: Login only allowed if status = Active
  const driver = await DRIVER.findOne({ mobileNumber, status: "Active" });

  if (!driver) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Driver not found. Please request OTP again.",
    });
  }

  // STEP 5: OTP check
  // if (driver.otp !== otp) {
  //   return responseHandler({
  //     res,
  //     code: statusCode.DATAMISSING,
  //     message: "Invalid OTP",
  //   });
  // }
  const isTestDriver = TEST_DRIVER_NUMBERS.includes(mobileNumber);

if (isTestDriver) {
  if (otp !== TEST_OTP) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid OTP",
    });
  }
} else if (driver.otp !== otp) {
  return responseHandler({
    res,
    code: statusCode.DATAMISSING,
    message: "Invalid OTP",
  });
}

  // STEP 6: OTP verified → generate token
  driver.otp = null;
  const token = generateDriverToken(driver);
  driver.accessToken = token;

  // Handle device registration/update
  if (deviceToken && deviceType) {
    if (!driver.devices) driver.devices = [];

    const existingDeviceIndex = driver.devices.findIndex(
      (d) => d.deviceToken === deviceToken,
    );
    if (existingDeviceIndex !== -1) {
      driver.devices[existingDeviceIndex].accessToken = token;
      driver.devices[existingDeviceIndex].deviceType = deviceType;
    } else {
      driver.devices.push({ deviceType, deviceToken, accessToken: token });
    }
  }

  await driver.save();

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Login successful",
    data: driver,
    token: token,
  });
});
exports.getDriverProfile = catchAsyncError(async (req, res) => {
  const driverId = req.driver._id; // token middleware se aata hai

  if (!driverId) {
    return responseHandler({
      res,
      code: statusCode.UNAUTHORIZED,
      message: "Unauthorized access. Token missing or invalid.",
    });
  }

  const driver = await DRIVER.findById(driverId).select("-otp -accessToken");

  if (!driver) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Driver not found",
    });
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Driver profile fetched successfully",
    data: driver,
  });
});
exports.driverLogout = catchAsyncError(async (req, res) => {
  const driverId = req.driver._id;
  const driver = await DRIVER.findById(driverId);

  if (!driver) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Driver not found",
    });
  }

  const authHeader = req.header("Authorization");
  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : authHeader;

  // Remove the specific device from the devices array
  if (driver.devices && driver.devices.length > 0) {
    driver.devices = driver.devices.filter(
      (device) => device.accessToken !== token,
    );
  }

  // Also clear legacy accessToken if it matches
  if (driver.accessToken === token) {
    driver.accessToken = null;
  }

  await driver.save();

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Logout successful",
  });
});
exports.updateDriverProfile = catchAsyncError(async (req, res) => {
  const driverId = req.driver._id;
  const updatedData = req.body;

  const driver = await DRIVER.findByIdAndUpdate(
    driverId,
    { $set: updatedData },
    { new: true },
  );

  if (!driver) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Driver not found.",
    });
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Driver updated successfully.",
    data: driver,
  });
});
exports.deleteDriverAccount = catchAsyncError(async (req, res) => {
  const driverId = req.driver._id;
  const { reason } = req.body;

  if (!reason) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Please select a reason for deleting your account.",
    });
  }

  const driver = await DRIVER.findById(driverId);
  if (!driver) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Driver not found.",
    });
  }

  driver.status = "Deleted";
  driver.deleteReason = reason;
  driver.deletedAt = new Date();
  driver.accessToken = null;
  await driver.save();

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Your account has been deleted successfully.",
  });
});

exports.getDriverOrdersByStatus = catchAsyncError(async (req, res) => {
  const driverId = req?.driver?._id;
  console.log("req.driver =>", req.driver);

  const { status } = req.query;

  if (!driverId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Driver ID is required.",
    });
  }

  // 🔍 Build Query
  let query = { orderAssignedTo: driverId };

  if (status === "assigned") {
    query.status = "Packed";
    query.driverStatus = { $nin: ["Accepted", "Picked", "Reached"] };

  } else if (status === "accepted") {
    query.driverStatus = "Accepted";
    query.status = "Packed";

  } else if (status === "pickedUp") {
    query.driverStatus = { $in: ["Picked", "Reached"] };
    query.status = "Shipped";

  } else if (status === "delivered") {
    query.status = "Delivered";

  } else if (status === "returned" || status === "return") {
    // Return tab: show only delivered orders that have at least one returned item.
    query.status = "Delivered";
    query["tracking.isDelivered"] = true;
    query["returnedItemsDetails.0"] = { $exists: true };

  } else if (status === "cancelled") {
    query.status = "Cancelled";
  }

  // 📦 Fetch Orders
  const orders = await Order.find(query)
    .populate("userId", "_id")
    .populate({
      path: "items.productId",
      select:
        "productName gst productImage category productVariations._id productVariations.productImages productVariations.measurmentUnit productVariations.measurmentValue",
    })
    .sort({ createdAt: -1 });

  // 🔄 Transform Orders
  const updatedOrders = orders.map((order) => {

    // 🛒 ITEMS SAFE
    const newItems = (order.items || []).map((item) => {
      const product = item?.productId;

      // ✅ HANDLE NULL PRODUCT
      if (!product || !product?._id) {
        return {
          ...item.toObject(),
          productId: {
            _id: null,
            productName: "Product not available",
            productImage: "",
            category: "",
          },
          productImages: [],
          measurmentUnit: null,
          measurmentValue: null,
          isProductDeleted: true,
        };
      }

      let variation = null;
      let variationImages = [];

      if (product.productVariations?.length && item?.variationId) {
        variation = product.productVariations.find((v) => {
          if (!v?._id || !item?.variationId) return false;

          return v._id.toString() === item.variationId.toString();
        });

        variationImages = variation?.productImages?.[0] || [];
      }
      const unitBasePrice = Number(item.basePrice ?? 0);
      const gstPercent = resolveGstPercent(
        item.gstPercent,
        variation?.gst,
        product?.gst,
      );
      const rawPriceWithGST = Number(item.priceWithGST ?? 0);
      const quantity = Number(item.quantity || 0);
      const subtotal = Number(item.subtotal || 0);
      const computedUnitPriceWithGST = Number(
        (unitBasePrice + (unitBasePrice * gstPercent) / 100).toFixed(2),
      );
      const fromSubtotal = quantity > 0 && subtotal > 0 ? Number((subtotal / quantity).toFixed(2)) : 0;
      const unitPriceWithGST =
        rawPriceWithGST > 0 && (gstPercent <= 0 || rawPriceWithGST > unitBasePrice)
          ? rawPriceWithGST
          : fromSubtotal > 0 && (gstPercent <= 0 || fromSubtotal > unitBasePrice)
            ? fromSubtotal
            : gstPercent > 0
              ? computedUnitPriceWithGST
              : rawPriceWithGST > 0
                ? rawPriceWithGST
                : unitBasePrice;

      return {
        ...item.toObject(),
        productId: {
          _id: product._id,
          productName: product.productName || "",
          productImage: product.productImage || "",
          category: product.category || "",
        },
        basePrice: unitBasePrice,
        priceWithGST: unitPriceWithGST,
        unitPrice: unitPriceWithGST,
        gstPercent,
        gstAmount: Number(item.gstAmount ?? 0),
        productImages: variationImages,
        measurmentUnit: variation?.measurmentUnit || null,
        measurmentValue: variation?.measurmentValue || null,
        isProductDeleted: false,
      };
    });

    // 🔁 RETURNED ITEMS SAFE
    const newReturnedItems = (order.returnedItemsDetails || []).map((rItem) => {
      const rObj = rItem?.toObject ? rItem.toObject() : rItem;
      const returnedQty = Number(rObj?.quantity || 0);
      const returnedRawUnitPriceWithGST = Number(rObj?.priceWithGST || 0);
      const returnedBasePrice = Number(rObj?.basePrice || 0);
      const parentItem = (order.items || []).find((i) => {
        if (!i?.variationId || !rObj?.variationId) return false;
        return i.variationId.toString() === rObj.variationId.toString();
      });
      const returnedGstPercent = resolveGstPercent(
        rObj?.gstPercent,
        parentItem?.productId?.gst,
      );
      const returnedSubtotal = Number(rObj?.subtotal || 0);
      const returnedComputedUnitPriceWithGST = Number(
        (returnedBasePrice + (returnedBasePrice * returnedGstPercent) / 100).toFixed(2),
      );
      const returnedFromSubtotal =
        returnedQty > 0 && returnedSubtotal > 0
          ? Number((returnedSubtotal / returnedQty).toFixed(2))
          : 0;
      const returnedUnitPrice =
        returnedRawUnitPriceWithGST > 0 &&
          (returnedGstPercent <= 0 || returnedRawUnitPriceWithGST > returnedBasePrice)
          ? returnedRawUnitPriceWithGST
          : returnedFromSubtotal > 0 &&
            (returnedGstPercent <= 0 || returnedFromSubtotal > returnedBasePrice)
            ? returnedFromSubtotal
            : returnedGstPercent > 0
              ? returnedComputedUnitPriceWithGST
              : returnedRawUnitPriceWithGST > 0
                ? returnedRawUnitPriceWithGST
                : returnedBasePrice;

      if (!rObj?.variationId) {
        return {
          ...rObj,
          unitPrice: returnedUnitPrice,
          subtotal: Number((returnedUnitPrice * returnedQty).toFixed(2)),
          measurmentUnit: null,
          measurmentValue: null,
        };
      }

      if (!parentItem || !parentItem?.productId) {
        return {
          ...rObj,
          priceWithGST: returnedUnitPrice,
          unitPrice: returnedUnitPrice,
          subtotal: Number((returnedUnitPrice * returnedQty).toFixed(2)),
          measurmentUnit: null,
          measurmentValue: null,
        };
      }

      const variation = (parentItem.productId.productVariations || []).find((v) => {
        if (!v?._id || !rObj?.variationId) return false;

        return v._id.toString() === rObj.variationId.toString();
      });

      return {
        ...rObj,
        priceWithGST: returnedUnitPrice,
        unitPrice: returnedUnitPrice,
        subtotal: Number((returnedUnitPrice * returnedQty).toFixed(2)),
        measurmentUnit: variation?.measurmentUnit || null,
        measurmentValue: variation?.measurmentValue || null,
      };
    });

    const shouldApplyPendingReturns =
      order.status !== "Delivered" && !order.tracking?.isDelivered;
    const deliverableItems = shouldApplyPendingReturns
      ? applyPendingReturnsToItems(newItems, newReturnedItems)
      : newItems;

    const deliveryCharge = Number(order.deliveryCharge || 0);
    const platformFee = Number(order.platformFee || 0);
    const { subTotal: displaySubTotal, grandTotal: displayGrandTotal } =
      computeDriverDisplayTotals({
        items: deliverableItems,
        deliveryCharge,
        platformFee,
        couponDiscount: Number(order.couponDiscount || 0),
      });

    return {
      ...order.toObject(),
      items: deliverableItems,
      returnedItemsDetails: newReturnedItems,
      // Explicit field for UI: show return-selected items before delivery
      // in active tabs like pickedUp/assigned.
      preDeliveryReturnedItemsDetails:
        order.status !== "Delivered" ? newReturnedItems : [],
      hasPreDeliveryReturnSelection:
        order.status !== "Delivered" && newReturnedItems.length > 0,
      subTotal: displaySubTotal,
      grandTotal: displayGrandTotal,
      totalAmount: displayGrandTotal,
      netPayable: displayGrandTotal,
      total: displayGrandTotal,
      amount: displayGrandTotal,
      totalRefundedAmount: Number(order.totalRefundedAmount || 0),
      refundStatus: order.refundStatus || "none",
      refund: buildRefundDetails(order),
    };
  }).map((order) => appendDeliveryReturnBreakdown(order));

  // ✅ Response
  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Orders fetched successfully.",
    data: {
      total: updatedOrders.length,
      orders: updatedOrders,
    },
  });
});


exports.updateOrderStatusByDriver = catchAsyncError(async (req, res) => {
  const driverId = req.driver._id;
  const { orderId, action, codPaymentStatus } = req.body;

  if (!driverId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Driver ID is required.",
    });
  }

  if (!orderId || !action) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Order ID and action are required.",
    });
  }

  const order = await Order.findOne({
    _id: orderId,
    orderAssignedTo: driverId,
  }).populate({
    path: "items.productId",
    select:
      "productName gst productImage category productVariations._id productVariations.productImages productVariations.measurmentUnit productVariations.measurmentValue",
  });

  if (!order) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Order not found or not assigned to this driver.",
    });
  }

  const allowedActions = ["Accepted", "Picked", "Reached", "Delivered"];

  if (!allowedActions.includes(action)) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid action.",
    });
  }

  // Idempotency check: prevent duplicate requests from firing duplicate notifications
  if (
    (action === "Accepted" && order.driverStatus === "Accepted") ||
    (action === "Picked" && order.driverStatus === "Picked") ||
    (action === "Reached" && order.driverStatus === "Reached") ||
    (action === "Delivered" && order.status === "Delivered")
  ) {
    return responseHandler({
      res,
      code: statusCode.SUCCESS,
      message: `Order is already marked as ${action}.`,
      data: order,
    });
  }

  if (action === "Accepted") {
    order.driverStatus = "Accepted";
    order.driverAcceptedAt = new Date();
  } else if (action === "Picked") {
    order.driverStatus = "Picked";
    order.driverPickedAt = new Date();
    order.status = "Shipped";
    order.tracking.isShipped = true;
    order.tracking.shippedAt = new Date();
  } else if (action === "Reached") {
    order.driverStatus = "Reached";
    order.driverReachedAt = new Date();
  }
  // else if (action === "Cancelled") {
  //   order.status = "Cancelled";
  //   order.driverStatus = "Reached";
  //   order.tracking.isCancelled = true;
  //   order.tracking.cancelledAt = new Date();

  //   return responseHandler({
  //     res,
  //     code: statusCode.SUCCESS,
  //     message: "Order cancelled successfully.",
  //     data: order,
  //   });
  // }
  else if (action === "Delivered") {
    if (order.paymentMethod === "COD") {
      if (!codPaymentStatus) {
        return responseHandler({
          res,
          code: statusCode.DATAMISSING,
          message: "codPaymentStatus is required for COD orders.",
        });
      }
      if (!["PaidOnline", "PaidInCash"].includes(codPaymentStatus)) {
        return responseHandler({
          res,
          code: statusCode.DATAMISSING,
          message: "Invalid codPaymentStatus.",
        });
      }
      order.codPaymentStatus = codPaymentStatus;
    }
    order.status = "Delivered";
    order.tracking.isDelivered = true;
    order.tracking.deliveredAt = new Date();
    order.paymentStatus = "Paid";

    // ── Restock pre-delivery returns & adjust order.items ──
    if (order.returnedItems && order.returnedItems.length > 0) {
      const Product = require("../../models/productModel");
      let modifiedItems = false;
      const subTotalBeforeDeliveryReturn = Number(order.subTotal || 0);
      const couponDiscountBeforeDeliveryReturn = Number(order.couponDiscount || 0);

      for (const retItem of order.returnedItems) {
        const qty = Number(retItem.quantity || 0);
        if (qty <= 0) continue;

        // 1. Restock in local DB
        try {
          const product = await Product.findById(retItem.productId);
          if (product) {
            const variation = product.productVariations.find(
              (v) => v._id.toString() === retItem.variationId.toString()
            );
            if (variation) {
              variation.stockQuantity = (variation.stockQuantity || 0) + qty;
              if (variation.stockQuantity <= 0) variation.stockStatus = "outOfStock";
              else if (variation.stockQuantity <= variation.minStock) variation.stockStatus = "lowStock";
              else variation.stockStatus = "inStock";
              variation.lastRestockedAt = new Date();
              console.log(`[DELIVERY-STOCK] Restocked variation ${variation.sku}: +${qty} (New: ${variation.stockQuantity})`);
            }
            await product.save();
          }
        } catch (stockErr) {
          console.error(`[DELIVERY-STOCK] Failed to restock product ${retItem.productId}:`, stockErr.message);
        }

        // 2. Adjust order.items
        const cartItem = order.items.find(
          (i) => i.productId?._id?.toString() === retItem.productId.toString() &&
                 i.variationId?.toString() === retItem.variationId.toString()
        );
        if (cartItem) {
          const remainingQty = cartItem.quantity - qty;
          if (remainingQty > 0) {
            cartItem.quantity = remainingQty;
          } else {
            order.items = order.items.filter(
              (i) => !(i.productId?._id?.toString() === retItem.productId.toString() &&
                       i.variationId?.toString() === retItem.variationId.toString())
            );
          }
          modifiedItems = true;
        }
      }

      // Recalculate totals if items were modified
      if (modifiedItems) {
        let newSubTotal = 0;
        order.items.forEach((i) => {
          const itemBasePrice = Number(i.basePrice || 0);
          const itemGstPercent = resolveGstPercent(i.gstPercent, i?.productId?.gst);
          const itemRawPriceWithGST = Number(i.priceWithGST ?? 0);
          const itemQty = Number(i.quantity || 0);
          const itemComputedUnitPriceWithGST = Number(
            (itemBasePrice + (itemBasePrice * itemGstPercent) / 100).toFixed(2)
          );
          const itemFromSubtotal =
            itemQty > 0 && Number(i.subtotal || 0) > 0
              ? Number((Number(i.subtotal) / itemQty).toFixed(2))
              : 0;
          const itemUnitPriceWithGST =
            itemRawPriceWithGST > 0 &&
              (itemGstPercent <= 0 || itemRawPriceWithGST > itemBasePrice)
              ? itemRawPriceWithGST
              : itemFromSubtotal > 0 &&
                (itemGstPercent <= 0 || itemFromSubtotal > itemBasePrice)
                ? itemFromSubtotal
                : itemGstPercent > 0
                  ? itemComputedUnitPriceWithGST
                  : itemRawPriceWithGST > 0
                    ? itemRawPriceWithGST
                    : itemBasePrice;

          i.priceWithGST = itemUnitPriceWithGST;
          i.subtotal = Number((itemUnitPriceWithGST * itemQty).toFixed(2));
          newSubTotal += i.subtotal;
        });

        order.subTotal = Number(newSubTotal.toFixed(2));

        let appliedCouponForDeliveryReturn = null;
        if (order.appliedCoupon) {
          try {
            const appliedCoupon = await Coupon.findById(order.appliedCoupon).lean();
            appliedCouponForDeliveryReturn = appliedCoupon;
            const now = new Date();
            const validFrom = appliedCoupon?.validFrom ? new Date(appliedCoupon.validFrom) : null;
            const validTill = appliedCoupon?.validTill ? new Date(appliedCoupon.validTill) : null;
            const isDateValid =
              (!validFrom || now >= validFrom) && (!validTill || now <= validTill);
            const isStatusValid = appliedCoupon?.status === "Active";
            const meetsMinOrder =
              !appliedCoupon?.minOrderValue || newSubTotal >= Number(appliedCoupon.minOrderValue);

            if (!appliedCoupon || !isStatusValid || !isDateValid || !meetsMinOrder) {
              order.appliedCoupon = null;
              order.couponCode = null;
              order.couponDiscount = 0;
            }
          } catch (err) {
            console.error("Coupon revalidation failed during delivery stock adjustment:", err);
            order.appliedCoupon = null;
            order.couponCode = null;
            order.couponDiscount = 0;
          }
        }

        await removeCouponIfBelowMinimumAfterReturn(order, newSubTotal);
        const baseCouponDiscountForDeliveryReturn =
          appliedCouponForDeliveryReturn && Number(order.couponDiscount || 0) > 0
            ? calculateCouponDiscountForSubTotal(
                appliedCouponForDeliveryReturn,
                subTotalBeforeDeliveryReturn,
              )
            : couponDiscountBeforeDeliveryReturn;
        prorateCouponForRemainingItems(
          order,
          subTotalBeforeDeliveryReturn,
          newSubTotal,
          baseCouponDiscountForDeliveryReturn,
        );
        await removeFreeItemIfBelowRuleMinimum(order, newSubTotal);

        let newGrandTotal =
          newSubTotal +
          (order.deliveryCharge || 0) +
          (order.platformFee || 0) -
          (order.couponDiscount || 0);

        const finalGrandTotal = Number(Math.max(newGrandTotal, 0).toFixed(2));
        order.grandTotal = finalGrandTotal;
        order.totalAmount = finalGrandTotal;
        order.netPayable = finalGrandTotal;
        order.total = finalGrandTotal;
        order.amount = finalGrandTotal;
      }
    }
  }

  await order.save();

  // --- SYNC TO PETPOOJA (CONVERT SALES ORDER TO INVOICE ON DELIVERY) ---
  if (action === "Delivered") {
    if (order.petpoojaVoucherId || order.remainingPetpoojaVoucherId) {
      try {
        const partyService = require('../../integrations/petpooja/services/partyService');
        const invoiceService = require('../../integrations/petpooja/services/invoiceService');

        const customerUser = await User.findById(order.userId);
        if (customerUser) {
          // Sync party to get stable address IDs
          const partySync = await partyService.syncUserParty(customerUser);

          if (!order.billingPetpoojaAddressId) {
            order.billingPetpoojaAddressId = partySync.billingAddressId;
          }
          if (!order.shippingPetpoojaAddressId) {
            order.shippingPetpoojaAddressId = partySync.shippingAddressId;
          }

          // Fetch fresh config IDs
          const voucherSeriesObj = await salesOrderService.initVoucher();
          const voucherAutoSeriesId = voucherSeriesObj ? voucherSeriesObj.id : null;
          const templateObj = await salesOrderService.initTemplate();
          const templateId = templateObj ? templateObj.id : null;
          const customChargeObj = await salesOrderService.getCustomCharge();
          const customChargeId = customChargeObj ? customChargeObj.id : null;

          // Case: Invoicing original sales order if missing (fallback)
          if (order.petpoojaVoucherId && !order.invoiceId) {
            console.log(`[PETPOOJA] Creating Invoice for original sales order: ${order.petpoojaVoucherId}`);
            const invoiceResult = await invoiceService.createInvoice(
              order.petpoojaVoucherId,
              order,
              customerUser,
              templateId,
              customChargeId,
              voucherAutoSeriesId,
            );
            console.log(`[PETPOOJA] Original Sales Order Invoiced:`, invoiceResult);
            order.invoiceId = invoiceResult.voucherId;
            await order.save();
          }

          // Hitting receipt API on Petpooja to confirm payment
          if (order.invoiceId) {
            try {
              const receiptService = require('../../integrations/petpooja/services/receiptService');
              const receiptResult = await receiptService.createReceiptForOrder(order, customerUser);
              console.log('[PETPOOJA] Receipt created for order:', order.orderId, receiptResult);
            } catch (receiptErr) {
              console.error('[PETPOOJA] Failed to create receipt for order:', order.orderId, receiptErr.message);
            }
          }
        }
      } catch (petpoojaError) {
        console.error("[PETPOOJA] Error converting Sales Order to Invoice on Delivery:", petpoojaError.message);
      }
    }
  }

  // 🔔 Send Notification to User based on Driver Action
  try {
    const actionMessages = {
      Accepted: "📦 Your order has been accepted by the rider for delivery.",
      Picked:
        "🚚 Your order has been picked up by the rider and is on the way!",
      Reached: "📍 The rider has arrived near your location.",
      Delivered:
        "✅ Delivered! Your order has been successfully delivered. Please rate us!",
    };

    if (actionMessages[action]) {
      const userForNotif = await User.findById(order.userId).select(
        "notificationPreferences",
      );
      const isPrefOn =
        userForNotif?.notificationPreferences?.deliveryAlerts !== false;

      if (isPrefOn) {
        const notificationPayload = {
          userId: order.userId,
          targetAudience: "specificUser",
          title: `Order Update: ${action}`,
          message: actionMessages[action],
          type: "push",
          category: "deliveryAlerts",
          scheduleOptions: "now",
          sentAt: new Date(),
        };

        const notification = await Notification.create(notificationPayload);

        await notificationQueue.add("send-notification", {
          notificationId: notification._id.toString(),
          targetAudience: "specificUser",
          userId: order.userId.toString(),
          category: "deliveryAlerts",
          title: notificationPayload.title,
          message: notificationPayload.message,
          type: "push",
        });
      }
    }

    // 🔔 Notify Admins about the driver's update
    if (actionMessages[action]) {
      const eventAt =
        action === "Accepted"
          ? order.driverAcceptedAt
          : action === "Picked"
            ? order.driverPickedAt
            : action === "Reached"
              ? order.driverReachedAt
              : order.tracking?.deliveredAt;
      const adminNotifPayload = {
        targetAudience: "allAdmins",
        title: `Order Update: ${action} (#${order.orderId})`,
        message: `The driver updated order #${order.orderId} status to: ${action}.`,
        type: "push",
        category: "orderUpdates",
        scheduleOptions: "now",
        sentAt: new Date(),
        eventAt,
      };

      const adminNotif = await Notification.create(adminNotifPayload);
      await notificationQueue.add("send-notification", {
        notificationId: adminNotif._id.toString(),
        targetAudience: "allAdmins",
        category: "orderUpdates",
        title: adminNotifPayload.title,
        message: adminNotifPayload.message,
        type: "push",
      });
    }
  } catch (err) {
    console.error(`❌ Error sending ${action} notification:`, err);
  }

  const cleanItems = order.items.map((item) => {
    const product = item.productId;
    let variation = null;
    let variationImages = [];

    if (product?.productVariations?.length) {
      variation = product.productVariations.find(
        (v) => v._id.toString() === item.variationId.toString(),
      );
      if (variation) {
        variationImages = variation.productImages[0] || [];
      }
    }

    const cleanProduct = {
      _id: product._id,
      productName: product.productName,
      productImage: product.productImage,
      category: product.category,
    };

    return {
      ...item.toObject(),
      productId: cleanProduct,
      productImages: variationImages,
      measurmentUnit: variation?.measurmentUnit,
      measurmentValue: variation?.measurmentValue,
    };
  });

  const cleanReturnedItems = (order.returnedItemsDetails || []).map((rItem) => {
    const rObj = rItem.toObject ? rItem.toObject() : rItem;
    const returnedQty = Number(rObj?.quantity || 0);
    const returnedRawUnitPriceWithGST = Number(rObj?.priceWithGST || 0);
    const returnedBasePrice = Number(rObj?.basePrice || 0);
    const returnedUnitPrice =
      returnedRawUnitPriceWithGST > 0
        ? returnedRawUnitPriceWithGST
        : returnedQty > 0 && Number(rObj?.subtotal || 0) > 0
          ? Number((Number(rObj.subtotal) / returnedQty).toFixed(2))
          : returnedBasePrice;

    const parentItem = order.items.find(
      (i) => i.variationId.toString() === rObj.variationId.toString(),
    );

    let variation = null;

    if (parentItem?.productId?.productVariations?.length) {
      variation = parentItem.productId.productVariations.find(
        (v) => v._id.toString() === rObj.variationId.toString(),
      );
    }

    return {
      ...rObj,
      priceWithGST: returnedUnitPrice,
      unitPrice: returnedUnitPrice,
      subtotal: Number((returnedUnitPrice * returnedQty).toFixed(2)),
      measurmentUnit: variation?.measurmentUnit,
      measurmentValue: variation?.measurmentValue,
    };
  });

  const finalOrder = {
    ...order.toObject(),
    items: applyPendingReturnsToItems(cleanItems, cleanReturnedItems),
    returnedItemsDetails: cleanReturnedItems,
  };
  const deliveryCharge = Number(order.deliveryCharge || 0);
  const platformFee = Number(order.platformFee || 0);
  const { subTotal: displaySubTotal, grandTotal: displayGrandTotal } =
    computeDriverDisplayTotals({
      items: finalOrder.items,
      deliveryCharge,
      platformFee,
      couponDiscount: Number(finalOrder.couponDiscount || 0),
    });
  finalOrder.subTotal = displaySubTotal;
  finalOrder.grandTotal = displayGrandTotal;
  finalOrder.totalAmount = displayGrandTotal;
  finalOrder.netPayable = displayGrandTotal;
  finalOrder.total = displayGrandTotal;
  finalOrder.amount = displayGrandTotal;
  const orderWithBreakdown = appendDeliveryReturnBreakdown(finalOrder);

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: `Order ${action} successfully.`,
    data: orderWithBreakdown,
  });
});
exports.updateDriverLocation = catchAsyncError(async (req, res) => {
  const driverId = req.driver._id;
  const { latitude, longitude } = req.body;

  if (latitude == null || longitude == null) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Latitude and Longitude are required.",
    });
  }

  const parsedLatitude = Number(latitude);
  const parsedLongitude = Number(longitude);

  if (
    Number.isNaN(parsedLatitude) ||
    Number.isNaN(parsedLongitude) ||
    parsedLatitude < -90 ||
    parsedLatitude > 90 ||
    parsedLongitude < -180 ||
    parsedLongitude > 180
  ) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid latitude or longitude.",
    });
  }

  await DRIVER.findByIdAndUpdate(driverId, {
    currentLocation: {
      type: "Point",
      coordinates: [parsedLongitude, parsedLatitude],
    },
  });
  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Driver location updated.",
  });
});
exports.getHomeOverview = catchAsyncError(async (req, res) => {
  const { filter } = req.query;
  const normalizedFilter = String(filter || "all")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
  const now = new Date();
  const driverId = req.driver._id;

  let startDate = new Date();
  let endDate = new Date();
  if (!normalizedFilter || normalizedFilter === "all") {
    startDate = null;
    endDate = null;
  }

  if (normalizedFilter === "today") {
    startDate.setHours(0, 0, 0, 0);
    endDate.setHours(23, 59, 59, 999);
  } else if (normalizedFilter === "yesterday") {
    startDate = new Date(now);
    startDate.setDate(now.getDate() - 1);
    startDate.setHours(0, 0, 0, 0);

    endDate = new Date(startDate);
    endDate.setHours(23, 59, 59, 999);
  } else if (normalizedFilter === "thisweek") {
    const currentDay = now.getDay(); // 0=sun,1=mon...
    const diffToMonday = currentDay === 0 ? 6 : currentDay - 1;

    startDate = new Date(now);
    startDate.setDate(now.getDate() - diffToMonday);
    startDate.setHours(0, 0, 0, 0);

    endDate = new Date(startDate);
    endDate.setDate(startDate.getDate() + 6);
    endDate.setHours(23, 59, 59, 999);
  }

  //  THIS MONTH
  else if (normalizedFilter === "thismonth") {
    startDate = new Date(now.getFullYear(), now.getMonth(), 1);
    endDate = new Date(
      now.getFullYear(),
      now.getMonth() + 1,
      0,
      23,
      59,
      59,
      999,
    );
  }

  //  THIS YEAR (FULL FIX)
  else if (normalizedFilter === "thisyear") {
    startDate = new Date(now.getFullYear(), 0, 1); // Jan 1
    startDate.setHours(0, 0, 0, 0);

    endDate = new Date(now.getFullYear(), 11, 31, 23, 59, 59, 999); // Dec 31
  }

  // FINAL FILTER WITH DRIVER
  // Count all orders assigned to driver, including newly assigned ones.
  let dateFilter = {
    orderAssignedTo: driverId,
  };

  if (startDate && endDate) {
    // Use order creation time for period filtering.
    dateFilter.createdAt = { $gte: startDate, $lte: endDate };
  }

  const totalOrders = await Order.countDocuments(dateFilter);

  const completedOrders = await Order.countDocuments({
    ...dateFilter,
    status: "Delivered",
  });

  const inProgressOrders = await Order.countDocuments({
    ...dateFilter,
    status: { $nin: ["Delivered", "Cancelled", "Returned"] },
  });

  const totalKmsData = await Order.aggregate([
    { $match: dateFilter },
    { $group: { _id: null, totalKms: { $sum: "$distance" } } },
  ]);

  const totalKms = totalKmsData[0]?.totalKms || 0;

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: `Home overview fetched successfully for ${normalizedFilter}.`,
    data: {
      totalOrders,
      totalKmsRide: totalKms,
      completedOrders,
      inProgressOrders,
    },
  });
});
exports.cancelOrderByDriver = catchAsyncError(async (req, res) => {
  const driverId = req.driver._id;
  const { orderId, cancelReason } = req.body;

  if (!driverId)
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Driver ID required.",
    });

  if (!orderId || !cancelReason)
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "orderId & cancelReason required.",
    });

  const order = await Order.findOne({
    _id: orderId,
    orderAssignedTo: driverId,
  });
  if (!order)
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Order not found.",
    });

  if (order.status === "Delivered") {
    return responseHandler({
      res,
      code: statusCode.FORBIDDEN,
      message: "Delivered order cannot be cancelled.",
    });
  }

  order.status = "Cancelled";
  order.driverStatus = "Reached";
  order.cancelReason = cancelReason;
  order.tracking.isCancelled = true;
  order.tracking.cancelledAt = new Date();

  // ── Restock locally ──
  const Product = require("../../models/productModel");
  
  // Combine items to restock
  const itemsToRestock = [];
  if (order.items && order.items.length > 0) {
    for (const item of order.items) {
      itemsToRestock.push({
        productId: item.productId?._id || item.productId,
        variationId: item.variationId,
        quantity: Number(item.quantity || 0)
      });
    }
  }
  if (order.returnedItems && order.returnedItems.length > 0) {
    for (const item of order.returnedItems) {
      itemsToRestock.push({
        productId: item.productId,
        variationId: item.variationId,
        quantity: Number(item.quantity || 0)
      });
    }
  }

  // Perform local DB restocking
  for (const item of itemsToRestock) {
    if (item.quantity <= 0) continue;
    try {
      const product = await Product.findById(item.productId);
      if (product) {
        const variation = product.productVariations.find(
          (v) => v._id.toString() === item.variationId.toString()
        );
        if (variation) {
          variation.stockQuantity = (variation.stockQuantity || 0) + item.quantity;
          if (variation.stockQuantity <= 0) variation.stockStatus = "outOfStock";
          else if (variation.stockQuantity <= variation.minStock) variation.stockStatus = "lowStock";
          else variation.stockStatus = "inStock";
          variation.lastRestockedAt = new Date();
          console.log(`[DRIVER-CANCEL-STOCK] Restocked variation ${variation.sku}: +${item.quantity} (New: ${variation.stockQuantity})`);
        }
        await product.save();
      }
    } catch (stockErr) {
      console.error(`[DRIVER-CANCEL-STOCK] Failed to restock product ${item.productId}:`, stockErr.message);
    }
  }

  // ── Sync to Petpooja: Create Credit Note of full amount and mark Invoice closed ──
  if (order.petpoojaVoucherId && order.invoiceId) {
    try {
      const customerUser = await User.findById(order.userId);
      if (customerUser) {
        const invoiceService = require('../../integrations/petpooja/services/invoiceService');
        const creditNoteService = require('../../integrations/petpooja/services/creditNoteService');
        const partyService = require('../../integrations/petpooja/services/partyService');

        // Sync user party
        const partySync = await partyService.syncUserParty(customerUser);
        order.billingPetpoojaAddressId = partySync.billingAddressId;
        order.shippingPetpoojaAddressId = partySync.shippingAddressId;

        // Fetch credit note voucher series and template
        const voucherSeriesObj = await creditNoteService.initVoucher();
        const voucherAutoSeriesId = voucherSeriesObj ? voucherSeriesObj.id : null;
        const templateObj = await creditNoteService.initTemplate();
        const templateId = templateObj ? templateObj.id : null;

        // Build original items for credit note
        const cnItems = itemsToRestock.map(item => {
          const original = order.items.find(
            oi => {
              const oiProdId = oi.productId?._id?.toString() || oi.productId?.toString();
              return oiProdId === item.productId.toString() &&
                     oi.variationId?.toString() === item.variationId.toString();
            }
          );
          return {
            productId: item.productId,
            variationId: item.variationId,
            quantity: item.quantity,
            rate: original ? (original.priceWithGST || original.rate) : 0,
            priceWithGST: original ? (original.priceWithGST || original.rate) : 0,
            basePrice: original ? original.basePrice : 0,
            gstPercent: original ? original.gstPercent : 0,
            petpoojaItemId: original ? original.petpoojaItemId : null
          };
        });

        const activeInvoiceId = order.invoiceId;
        console.log(`[PETPOOJA-DRIVER-CANCEL] Creating Full Credit Note against Invoice: ${activeInvoiceId}`);
        
        const creditNoteResult = await creditNoteService.createCreditNote(
          activeInvoiceId, cnItems, order, customerUser, voucherAutoSeriesId, templateId,
          { includeOrderAdjustments: true }
        );
        console.log('[PETPOOJA-DRIVER-CANCEL] Credit note result:', creditNoteResult);
        
        if (creditNoteResult && creditNoteResult.creditNoteId) {
          order.petpoojaCreditNoteId = creditNoteResult.creditNoteId;
        }

        // Mark invoice closed
        await invoiceService.markInvoiceClosed(activeInvoiceId);
        console.log('[PETPOOJA-DRIVER-CANCEL] Invoice marked closed:', activeInvoiceId);
      }
    } catch (err) {
      console.error('Error syncing Petpooja full cancellation credit note in driver controller:', err);
    }
  }

  await order.save();

  try {
    await processFullOrderCancelRefund({
      order,
      cancelledBy: "driver",
      actorId: driverId,
    });
  } catch (refundError) {
    console.error("[DRIVER-CANCEL-REFUND] Failed to process refund:", refundError.message);
  }

  // 🔔 Send Notification to User & Admins
  try {
    // Notify User
    const userForNotif = await User.findById(order.userId).select(
      "notificationPreferences",
    );
    const isPrefOn =
      userForNotif?.notificationPreferences?.orderUpdates !== false;

    if (isPrefOn) {
      const userNotifPayload = {
        userId: order.userId,
        targetAudience: "specificUser",
        title: "Order Update: Cancelled ❌",
        message: `Your order #${order.orderId} has been cancelled. Reason: ${cancelReason}`,
        type: "push",
        category: "orderUpdates",
        scheduleOptions: "now",
        sentAt: new Date(),
      };
      const userNotif = await Notification.create(userNotifPayload);
      await notificationQueue.add("send-notification", {
        notificationId: userNotif._id.toString(),
        targetAudience: "specificUser",
        userId: order.userId.toString(),
        category: "orderUpdates",
        title: userNotifPayload.title,
        message: userNotifPayload.message,
        type: "push",
      });
    }

    // Notify Admins
    const adminNotifPayload = {
      targetAudience: "allAdmins",
      title: `Order Update: Cancelled by Driver (#${order.orderId}) ❌`,
      message: `Order #${order.orderId} was cancelled by the driver. Reason: ${cancelReason}`,
      type: "push",
      category: "orderUpdates",
      scheduleOptions: "now",
      sentAt: new Date(),
      eventAt: order.tracking.cancelledAt,
    };
    const adminNotif = await Notification.create(adminNotifPayload);
    await notificationQueue.add("send-notification", {
      notificationId: adminNotif._id.toString(),
      targetAudience: "allAdmins",
      category: "orderUpdates",
      title: adminNotifPayload.title,
      message: adminNotifPayload.message,
      type: "push",
    });
  } catch (err) {
    console.error("❌ Error sending cancellation notifications:", err);
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Order cancelled successfully.",
    data: order,
  });
});

exports.getOrderDetails = catchAsyncError(async (req, res) => {
  const driverId = req.driver._id;
  const { orderId } = req.query;

  if (!orderId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Order ID is required.",
    });
  }

  const order = await Order.findOne({
    _id: orderId,
    orderAssignedTo: driverId,
  })
    .populate("items.productId", "productName productImages productVariations gst")
    .populate(
      "returnedItemsDetails.productId",
      "productName productImages productVariations gst",
    )
    .populate("userId", "profileImage")
    .lean();

  if (!order) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Order not found or not assigned to this driver.",
    });
  }

  let totalItems = 0;

  const formattedItems = order.items.map((item) => {
    const product = item.productId;
    let variationData = null;

    if (product && product.productVariations) {
      variationData = product.productVariations.find(
        (v) =>
          v._id.toString() === item.variationId.toString() &&
          !v.isDeleted,
      );
    }

    totalItems += item.quantity;

    const unitBasePrice = Number(item.basePrice ?? 0);
    const gstPercent = resolveGstPercent(
      item.gstPercent,
      variationData?.gst,
      product?.gst,
    );
    const rawPriceWithGST = Number(item.priceWithGST ?? 0);
    const quantity = Number(item.quantity || 0);
    const subtotal = Number(item.subtotal || 0);
    const computedUnitPriceWithGST = Number(
      (unitBasePrice + (unitBasePrice * gstPercent) / 100).toFixed(2),
    );
    const fromSubtotal = quantity > 0 && subtotal > 0 ? Number((subtotal / quantity).toFixed(2)) : 0;
    const unitPriceWithGST =
      rawPriceWithGST > 0 && (gstPercent <= 0 || rawPriceWithGST > unitBasePrice)
        ? rawPriceWithGST
        : fromSubtotal > 0 && (gstPercent <= 0 || fromSubtotal > unitBasePrice)
          ? fromSubtotal
          : gstPercent > 0
            ? computedUnitPriceWithGST
            : rawPriceWithGST > 0
              ? rawPriceWithGST
              : unitBasePrice;

    return {
      _id: item._id,
      productId: product?._id,
      productName: product?.productName,
      productImages: variationData?.productImages[0],
      variationId: item.variationId,
      quantity: item.quantity,
      basePrice: unitBasePrice,
      priceWithGST: unitPriceWithGST,
      unitPrice: unitPriceWithGST,
      subtotal: Number((unitPriceWithGST * quantity).toFixed(2)),
      gstPercent,
      gstAmount: Number(item.gstAmount ?? 0),
      variationImages: variationData?.productImages || [],
      measurmentUnit: variationData?.measurmentUnit,
      measurmentValue: variationData?.measurmentValue,
    };
  });

  // ⭐ Add measurement unit & value to returned items
  const formattedReturned =
    order.returnedItemsDetails?.map((ret) => {
      const returnedQty = Number(ret?.quantity || 0);
      const returnedRawUnitPriceWithGST = Number(ret?.priceWithGST || 0);
      const returnedBasePrice = Number(ret?.basePrice || 0);
      const returnedProductId =
        ret?.productId?._id?.toString?.() || ret?.productId?.toString?.();
      const originalItem = order.items.find(
        (i) =>
          i.productId?._id?.toString?.() === returnedProductId &&
          i.variationId.toString() === ret.variationId.toString(),
      );
      const returnedGstPercent = resolveGstPercent(
        ret?.gstPercent,
        originalItem?.productId?.gst,
        ret?.productId?.gst,
      );
      const returnedSubtotal = Number(ret?.subtotal || 0);
      const returnedComputedUnitPriceWithGST = Number(
        (returnedBasePrice + (returnedBasePrice * returnedGstPercent) / 100).toFixed(2),
      );
      const returnedFromSubtotal =
        returnedQty > 0 && returnedSubtotal > 0
          ? Number((returnedSubtotal / returnedQty).toFixed(2))
          : 0;
      const returnedUnitPrice =
        returnedRawUnitPriceWithGST > 0 &&
          (returnedGstPercent <= 0 || returnedRawUnitPriceWithGST > returnedBasePrice)
          ? returnedRawUnitPriceWithGST
          : returnedFromSubtotal > 0 &&
            (returnedGstPercent <= 0 || returnedFromSubtotal > returnedBasePrice)
            ? returnedFromSubtotal
            : returnedGstPercent > 0
              ? returnedComputedUnitPriceWithGST
              : returnedRawUnitPriceWithGST > 0
                ? returnedRawUnitPriceWithGST
                : returnedBasePrice;

      let variation = null;

      if (originalItem?.productId?.productVariations) {
        variation = originalItem.productId.productVariations.find(
          (v) => v._id.toString() === ret.variationId.toString(),
        );
      } else if (ret?.productId?.productVariations) {
        variation = ret.productId.productVariations.find(
          (v) => v._id.toString() === ret.variationId.toString(),
        );
      }

      return {
        ...ret,
        gstPercent: returnedGstPercent,
        gstAmount: Number(
          ((returnedUnitPrice - returnedBasePrice) * returnedQty).toFixed(2),
        ),
        priceWithGST: returnedUnitPrice,
        unitPrice: returnedUnitPrice,
        subtotal: Number((returnedUnitPrice * returnedQty).toFixed(2)),
        measurmentUnit: variation?.measurmentUnit || null,
        measurmentValue: variation?.measurmentValue || null,
      };
    }) || [];

  const shouldApplyPendingReturns =
    order.status !== "Delivered" && !order.tracking?.isDelivered;
  const deliverableItems = shouldApplyPendingReturns
    ? applyPendingReturnsToItems(formattedItems, formattedReturned)
    : formattedItems;

  const deliveryCharge = Number(order.deliveryCharge || 0);
  const platformFee = Number(order.platformFee || 0);
  const { subTotal: displaySubTotal, grandTotal: displayGrandTotal } =
    computeDriverDisplayTotals({
      items: deliverableItems,
      deliveryCharge,
      platformFee,
      couponDiscount: Number(order.couponDiscount || 0),
    });

  const formattedOrder = {
    ...order,
    userId: order.userId?._id,
    deliveryAddress: {
      ...order.deliveryAddress,
      profileImage: order.userId?.profileImage || "",
    },
    items: deliverableItems,
    returnedItemsDetails: formattedReturned, // ⬅️ updated
    totalItems,
    subTotal: displaySubTotal,
    platformFee: order.platformFee || 0,
    grandTotal: displayGrandTotal,
    totalAmount: displayGrandTotal,
    netPayable: displayGrandTotal,
    total: displayGrandTotal,
    amount: displayGrandTotal,
    totalRefundedAmount: Number(order.totalRefundedAmount || 0),
    refundStatus: order.refundStatus || "none",
    refund: buildRefundDetails(order),
  };
  const orderWithBreakdown = appendDeliveryReturnBreakdown(formattedOrder);

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Order details fetched successfully.",
    data: orderWithBreakdown,
  });
});
exports.returnSelectedItemsByDriver = catchAsyncError(async (req, res) => {
  const driverId = req.driver._id;
  const { orderId, returnItems } = req.body;
  // The driver object is used as the user context for Petpooja service calls
  const user = req.driver;

  console.log('returnSelectedItemsByDriver payload:', { orderId, returnItems });

  if (!orderId || !returnItems?.length) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "orderId & returnItems required",
    });
  }

  const order = await Order.findOne({
    _id: orderId,
    orderAssignedTo: driverId,
  }).populate({
    path: "items.productId",
    select:
      "productName gst productImage category productVariations._id productVariations.productImages productVariations.measurmentUnit productVariations.measurmentValue productVariations.petpoojaItemId",
  });
  // .populate("items.productId", "productName productImages ");

  if (!order) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Order not found",
    });
  }

  // Use status as the source of truth. Some orders may have status=Delivered
  // but tracking.isDelivered may not be set consistently.
  const isDeliveredOrder =
    order.status === "Delivered" || Boolean(order.tracking?.isDelivered);

  const payableBeforeReturn = Number(order.grandTotal || 0);
  const returnAmountBeforeRequest = Number(order.returnAmount || 0);
  const subTotalBeforeReturn = Number(order.subTotal || 0);
  const couponDiscountBeforeReturn = Number(order.couponDiscount || 0);
  let totalReturnAmountBase = 0;
  let thisRequestRefundRupees = 0;

  const buildReturnKey = (productId, variationId) =>
    `${productId.toString()}::${variationId.toString()}`;

  const returnedItemsMap = new Map();
  const returnedItemsDetailsMap = new Map();

  // Delivered flow keeps historical merge behavior.
  // Pre-delivery flow works as latest snapshot to avoid repeated app reopen
  // inflating selected return quantities.
  if (isDeliveredOrder) {
    (order.returnedItems || []).forEach((item) => {
      const key = buildReturnKey(item.productId, item.variationId);
      returnedItemsMap.set(key, {
        productId: item.productId,
        variationId: item.variationId,
        quantity: Number(item.quantity) || 0,
        basePrice: Number(item.basePrice) || 0,
      });
    });

    (order.returnedItemsDetails || []).forEach((item) => {
      const key = buildReturnKey(item.productId, item.variationId);
      const detailQty = Number(item.quantity) || 0;
      const detailBasePrice = Number(item.basePrice) || 0;
      const detailGstPercent = resolveGstPercent(item.gstPercent);
      const detailRawPriceWithGST = Number(item.priceWithGST ?? 0);
      const detailComputedUnitPriceWithGST = Number(
        (detailBasePrice + (detailBasePrice * detailGstPercent) / 100).toFixed(2),
      );
      const detailFromSubtotal =
        detailQty > 0 && Number(item.subtotal || 0) > 0
          ? Number((Number(item.subtotal) / detailQty).toFixed(2))
          : 0;
      const detailUnitPriceWithGST =
        detailRawPriceWithGST > 0 &&
          (detailGstPercent <= 0 || detailRawPriceWithGST > detailBasePrice)
          ? detailRawPriceWithGST
          : detailFromSubtotal > 0 &&
            (detailGstPercent <= 0 || detailFromSubtotal > detailBasePrice)
            ? detailFromSubtotal
            : detailGstPercent > 0
              ? detailComputedUnitPriceWithGST
              : detailRawPriceWithGST > 0
                ? detailRawPriceWithGST
                : detailBasePrice;
      returnedItemsDetailsMap.set(key, {
        productId: item.productId,
        productName: item.productName,
        productImages: item.productImages,
        variationId: item.variationId,
        quantity: detailQty,
        basePrice: detailBasePrice,
        gstPercent: detailGstPercent,
        priceWithGST: detailUnitPriceWithGST,
        unitPrice: detailUnitPriceWithGST,
        subtotal: Number((detailUnitPriceWithGST * detailQty).toFixed(2)),
        gstAmount: Number(
          ((detailUnitPriceWithGST - detailBasePrice) * detailQty).toFixed(2),
        ),
        measurmentUnit: item.measurmentUnit,
        measurmentValue: item.measurmentValue,
        petpoojaItemId: item.petpoojaItemId || null,
      });
    });
  }

  // -------------------------------
  // PROCESS EACH RETURN ITEM
  // -------------------------------
  for (const item of returnItems) {
    const cartItem = order.items.find(
      (i) =>
        i.productId._id.toString() === item.productId &&
        i.variationId.toString() === item.variationId,
    );

    if (!cartItem) continue;

    const returnQty = Number(item.returnQty);
    const existingQty = Number(cartItem.quantity);

    if (returnQty <= 0) continue;

    const effectiveReturnQty = Math.min(returnQty, existingQty);
    if (effectiveReturnQty <= 0) continue;

    const base = Number(cartItem.basePrice) || 0;

    let product = null;
    let variation = (cartItem.productId?.productVariations || []).find(
      (v) => v?._id?.toString() === cartItem.variationId.toString(),
    );

    if (isDeliveredOrder) {
      // -------------------------------
      // STOCK UPDATE (only after delivery)
      // -------------------------------
      product = await Product.findById(cartItem.productId._id);
      if (product) {
        variation = product.productVariations.find(
          (v) => v._id.toString() === cartItem.variationId.toString(),
        );

        if (variation) {
          const newStockQuantity = (Number(variation.stockQuantity) || 0) + effectiveReturnQty;

          let newStockStatus = "inStock";
          if (newStockQuantity <= 0) newStockStatus = "outOfStock";
          else if (newStockQuantity <= variation.minStock) newStockStatus = "lowStock";

          await Product.updateOne(
            {
              _id: product._id,
              "productVariations._id": variation._id,
            },
            {
              $set: {
                "productVariations.$.stockQuantity": newStockQuantity,
                "productVariations.$.stockStatus": newStockStatus,
                "productVariations.$.lastRestockedAt": new Date(),
              },
            },
          );

          variation.stockQuantity = newStockQuantity;
          variation.stockStatus = newStockStatus;
        }
      }
    }

    const gstPercent = resolveGstPercent(
      cartItem.gstPercent,
      variation?.gst,
      product?.gst,
    );
    const cartRawPriceWithGST = Number(cartItem.priceWithGST ?? 0);
    const cartSubtotal = Number(cartItem.subtotal || 0);
    const computedUnitPriceWithGST = Number(
      (base + (base * gstPercent) / 100).toFixed(2),
    );
    const fromSubtotal =
      existingQty > 0 && cartSubtotal > 0
        ? Number((cartSubtotal / existingQty).toFixed(2))
        : 0;
    const unitPriceWithGST =
      cartRawPriceWithGST > 0 &&
        (gstPercent <= 0 || cartRawPriceWithGST > base)
        ? cartRawPriceWithGST
        : fromSubtotal > 0 && (gstPercent <= 0 || fromSubtotal > base)
          ? fromSubtotal
          : gstPercent > 0
            ? computedUnitPriceWithGST
            : cartRawPriceWithGST > 0
              ? cartRawPriceWithGST
              : base;

    totalReturnAmountBase += effectiveReturnQty * base;
    thisRequestRefundRupees += effectiveReturnQty * unitPriceWithGST;

    const returnKey = buildReturnKey(cartItem.productId._id, cartItem.variationId);

    const existingReturned = returnedItemsMap.get(returnKey);
    returnedItemsMap.set(returnKey, {
      productId: cartItem.productId._id,
      variationId: cartItem.variationId,
      quantity: isDeliveredOrder
        ? (existingReturned?.quantity || 0) + effectiveReturnQty
        : effectiveReturnQty,
      basePrice: base,
    });

    // const variationData = product.productVariations.find(
    //   (v) => v._id.toString() === cartItem.variationId.toString()
    // );
    // console.log("variationdata", variationData);

    // if (variationData?.productImages?.length) {
    //   image = variationData.productImages;
    // }
    // console.log("image",image)

    const existingReturnedDetail = returnedItemsDetailsMap.get(returnKey);
    const mergedReturnedQty = isDeliveredOrder
      ? (existingReturnedDetail?.quantity || 0) + effectiveReturnQty
      : effectiveReturnQty;
    returnedItemsDetailsMap.set(returnKey, {
      productId: cartItem.productId._id,
      productName: cartItem.productId.productName,
      productImages: variation?.productImages?.[0],
      variationId: cartItem.variationId,
      quantity: mergedReturnedQty,
      basePrice: base,
      gstPercent,
      priceWithGST: unitPriceWithGST,
      unitPrice: unitPriceWithGST,
      subtotal: Number((unitPriceWithGST * mergedReturnedQty).toFixed(2)),
      gstAmount: Number(
        ((unitPriceWithGST - base) * mergedReturnedQty).toFixed(2),
      ),
      measurmentUnit: variation?.measurmentUnit,
      measurmentValue: variation?.measurmentValue,
      petpoojaItemId: cartItem.petpoojaItemId || variation?.petpoojaItemId || null,
    });

    if (isDeliveredOrder) {
      // -------------------------------
      // PARTIAL RETURN (UPDATE QTY)
      // -------------------------------
      const remainingQty = existingQty - effectiveReturnQty;
      if (remainingQty > 0) {
        cartItem.quantity = remainingQty;
      } else {
        order.items = order.items.filter(i => !(i.productId._id.toString() === item.productId && i.variationId.toString() === item.variationId));
      }
    }

  }


  // -------------------------------
  // APPLY RETURN DETAILS
  // -------------------------------
  const finalReturnedItems = Array.from(returnedItemsMap.values());
  const returnedItemsDetails = Array.from(returnedItemsDetailsMap.values());
  order.returnedItems = finalReturnedItems;
  order.returnedItemsDetails = returnedItemsDetails;

  const returnedValueRupees = Number(
    returnedItemsDetails
      .reduce((sum, item) => sum + Number(item?.subtotal || 0), 0)
      .toFixed(2),
  );

  if (isDeliveredOrder) {
    // -------------------------------
    // RECALCULATE TOTALS
    // -------------------------------
    let newSubTotal = 0;

    order.items.forEach((i) => {
      const itemBasePrice = Number(i.basePrice || 0);
      const itemGstPercent = resolveGstPercent(i.gstPercent, i?.productId?.gst);
      const itemRawPriceWithGST = Number(i.priceWithGST ?? 0);
      const itemQty = Number(i.quantity || 0);
      const itemComputedUnitPriceWithGST = Number(
        (itemBasePrice + (itemBasePrice * itemGstPercent) / 100).toFixed(2),
      );
      const itemFromSubtotal =
        itemQty > 0 && Number(i.subtotal || 0) > 0
          ? Number((Number(i.subtotal) / itemQty).toFixed(2))
          : 0;
      const itemUnitPriceWithGST =
        itemRawPriceWithGST > 0 &&
          (itemGstPercent <= 0 || itemRawPriceWithGST > itemBasePrice)
          ? itemRawPriceWithGST
          : itemFromSubtotal > 0 &&
            (itemGstPercent <= 0 || itemFromSubtotal > itemBasePrice)
            ? itemFromSubtotal
            : itemGstPercent > 0
              ? itemComputedUnitPriceWithGST
              : itemRawPriceWithGST > 0
                ? itemRawPriceWithGST
                : itemBasePrice;

      i.priceWithGST = itemUnitPriceWithGST;
      i.subtotal = Number((itemUnitPriceWithGST * itemQty).toFixed(2));
      newSubTotal += i.subtotal;
    });

    order.subTotal = Number(newSubTotal.toFixed(2));

    // Re-validate applied coupon after returns. If minimum order condition is no longer
    // satisfied, remove coupon benefit from this order.
    if (order.appliedCoupon) {
      try {
        const appliedCoupon = await Coupon.findById(order.appliedCoupon).lean();
        const now = new Date();
        const validFrom = appliedCoupon?.validFrom ? new Date(appliedCoupon.validFrom) : null;
        const validTill = appliedCoupon?.validTill ? new Date(appliedCoupon.validTill) : null;
        const isDateValid =
          (!validFrom || now >= validFrom) && (!validTill || now <= validTill);
        const isStatusValid = appliedCoupon?.status === "Active";
        const meetsMinOrder =
          !appliedCoupon?.minOrderValue || newSubTotal >= Number(appliedCoupon.minOrderValue);

        if (!appliedCoupon || !isStatusValid || !isDateValid || !meetsMinOrder) {
          order.appliedCoupon = null;
          order.couponCode = null;
          order.couponDiscount = 0;
        }
      } catch (err) {
        console.error("Coupon revalidation failed during return flow:", err);
        order.appliedCoupon = null;
        order.couponCode = null;
        order.couponDiscount = 0;
      }
    }

    await removeCouponIfBelowMinimumAfterReturn(order, newSubTotal);
    prorateCouponForRemainingItems(
      order,
      subTotalBeforeReturn,
      newSubTotal,
      couponDiscountBeforeReturn,
    );
    await removeFreeItemIfBelowRuleMinimum(order, newSubTotal);

    let newGrandTotal =
      newSubTotal +
      (order.deliveryCharge || 0) +
      (order.platformFee || 0) -
      (order.couponDiscount || 0);

    function customRound(amount) {
      const integer = Math.floor(amount);
      const decimal = amount - integer;
      return decimal > 0.5 ? integer + 1 : integer;
    }

    const finalGrandTotal = customRound(Math.max(newGrandTotal, 0));
    thisRequestRefundRupees = Number(
      Math.max(payableBeforeReturn - finalGrandTotal, 0).toFixed(2),
    );
    order.returnAmount = Number(
      (returnAmountBeforeRequest + thisRequestRefundRupees).toFixed(2),
    );
    order.grandTotal = finalGrandTotal;
    order.returnedAt = new Date();
  } else if (returnedValueRupees > 0) {
    const remainingSubTotal = Number(
      Math.max(Number(order.subTotal || 0) - returnedValueRupees, 0).toFixed(2),
    );
    await removeCouponIfBelowMinimumAfterReturn(order, remainingSubTotal);
    prorateCouponForRemainingItems(
      order,
      subTotalBeforeReturn,
      remainingSubTotal,
      couponDiscountBeforeReturn,
    );
    await removeFreeItemIfBelowRuleMinimum(order, remainingSubTotal);
    const remainingGrandTotal = Number(
      Math.max(
        remainingSubTotal +
        Number(order.deliveryCharge || 0) +
        Number(order.platformFee || 0) -
        Number(order.couponDiscount || 0),
        0,
      ).toFixed(2),
    );
    thisRequestRefundRupees = Number(
      Math.max(payableBeforeReturn - remainingGrandTotal, 0).toFixed(2),
    );
    order.returnAmount = thisRequestRefundRupees;
  }

  if (
    order.paymentMethod === "Prepaid" &&
    order.paymentStatus === "Paid" &&
    (order.razorpayPaymentId || "").trim() &&
    thisRequestRefundRupees > 0 &&
    order.refundStatus === "none"
  ) {
    order.refundStatus = "pending";
  }

  const invoiceService = require('../../integrations/petpooja/services/invoiceService');
  const creditNoteService = require('../../integrations/petpooja/services/creditNoteService');
  const partyService = require('../../integrations/petpooja/services/partyService');

  // After order.save(), create invoice and credit note, then new sales order for remaining items
  await order.save();

  const refundSummary = await processDriverReturnRefund({
    order,
    isDeliveredOrder,
    returnItems,
    driverId,
    refundAmountRupees: Number(thisRequestRefundRupees.toFixed(2)),
  });

  // Debug: log petpooja voucher ID before attempting sync
  console.log('Petpooja voucher ID on order:', order.petpoojaVoucherId);

  if (!order.petpoojaVoucherId) {
    console.warn('Petpooja voucher ID missing; skipping invoice/credit note sync');
    const orderWithBreakdown = buildReturnOrderResponse(
      order,
      returnedItemsDetails,
      refundSummary,
    );
    return responseHandler({
      res,
      code: statusCode.SUCCESS,
      message: isDeliveredOrder
        ? "Items returned successfully & stock updated! (Petpooja sync skipped)"
        : "Return selection saved successfully. (Petpooja sync skipped)",
      data: orderWithBreakdown,
    });
  }

  if (order.petpoojaVoucherId) {
    try {
      // ── Fetch the actual customer (User), NOT the driver ──
      const customerUser = await User.findById(order.userId);
      if (!customerUser) {
        console.error('[PETPOOJA] Customer user not found for order:', order._id);
        throw new Error('Customer user not found');
      }

      // ── Sync user party → get petpoojaCustomerId + address IDs ──
      const partySync = await partyService.syncUserParty(customerUser);
      console.log('[PETPOOJA] Party sync result:', partySync);

      // Stamp IDs onto the order so payload builders can read them
      order.billingPetpoojaAddressId = partySync.billingAddressId;
      order.shippingPetpoojaAddressId = partySync.shippingAddressId;

      // ── Fetch credit note specific voucher series and template ──
      console.log('[PETPOOJA] Preparing to fetch credit note voucher series and template IDs');
      const voucherSeriesObj = await creditNoteService.initVoucher();
      const voucherAutoSeriesId = voucherSeriesObj ? voucherSeriesObj.id : null;
      console.log('[PETPOOJA] creditNote voucherAutoSeriesId:', voucherAutoSeriesId);
      const templateObj = await creditNoteService.initTemplate();
      const templateId = templateObj ? templateObj.id : null;
      console.log('[PETPOOJA] creditNote templateId:', templateId);
      console.log('[PETPOOJA] All IDs fetched: templateId', templateId, 'voucherAutoSeriesId', voucherAutoSeriesId);

      // Use existing invoice — NO new invoice or sales order creation on return
      const activeInvoiceId = order.invoiceId;
      if (!activeInvoiceId) {
        console.warn('[PETPOOJA] No existing invoiceId found on order, skipping credit note & close.');
      } else {
        console.log(`[PETPOOJA] Using existing Invoice ID: ${activeInvoiceId}, Invoice Number: ${order.invoiceNumber || 'N/A'}`);

        // 1. Create Credit Note for returned items against the existing invoice
        const creditNoteResult = await creditNoteService.createCreditNote(
          activeInvoiceId, order.returnedItemsDetails, order, customerUser, voucherAutoSeriesId, templateId
        );
        console.log('[PETPOOJA] Credit note creation result:', creditNoteResult);
        order.petpoojaCreditNoteId = creditNoteResult.creditNoteId;
        console.log('[PETPOOJA] Saved credit note ID to order:', order.petpoojaCreditNoteId);
        await order.save();

        // 2. Mark the existing invoice as closed
        await invoiceService.markInvoiceClosed(activeInvoiceId);
        console.log('[PETPOOJA] Invoice marked closed:', activeInvoiceId);
      }
    } catch (err) {
      console.error('Error syncing Petpooja after return:', err);
    }
  }


  const orderWithBreakdown = buildReturnOrderResponse(
    order,
    returnedItemsDetails,
    refundSummary,
  );

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: isDeliveredOrder
      ? "Items returned successfully & stock updated!"
      : "Return selection saved successfully.",
    data: orderWithBreakdown,
  });
});

exports.getNotificationHistory = catchAsyncError(async (req, res) => {
  const driverId = req.driver._id;
  const driverCreatedAt = req.driver.createdAt;

  // Find notifications where:
  // 1. driverId matches current driver
  // 2. targetAudience is "allDrivers" and it was sent after registration
  const notifications = await Notification.find({
    $or: [
      { driverId: driverId },
      {
        targetAudience: "allDrivers",
        sentAt: { $gte: driverCreatedAt },
      },
    ],
    sentAt: { $exists: true },
  }).sort({ sentAt: -1 });

  // Mark as opened once per driver-notification pair
  if (notifications.length > 0) {
    const notificationIds = notifications.map((n) => n._id);
    const existingReads = await NotificationRead.find({
      driverId,
      notificationId: { $in: notificationIds },
    }).select("notificationId");

    const existingReadIds = new Set(
      existingReads.map((read) => read.notificationId.toString()),
    );
    const unreadIds = notificationIds.filter(
      (id) => !existingReadIds.has(id.toString()),
    );

    if (unreadIds.length > 0) {
      try {
        await NotificationRead.insertMany(
          unreadIds.map((notificationId) => ({ notificationId, driverId })),
          { ordered: false },
        );
      } catch (err) {
        // Ignore duplicate key errors for races; log other insert errors
        if (err?.code !== 11000) {
          console.error(
            "Error inserting driver notification read records:",
            err,
          );
        }
      }

      Notification.updateMany(
        { _id: { $in: unreadIds } },
        { $inc: { openedCount: 1 } },
      ).catch((err) =>
        console.error(
          "Error updating notification openedCount for drivers:",
          err,
        ),
      );
    }
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Notification history fetched successfully",
    data: notifications,
  });
});

exports.getDriverUnreadNotificationCount = catchAsyncError(async (req, res) => {
  const driverId = req.driver._id;
  const driverCreatedAt = req.driver.createdAt;

  const readCollection = NotificationRead.collection.name;

  const result = await Notification.aggregate([
    {
      $match: {
        sentAt: { $exists: true },
        $or: [
          { driverId: driverId },
          {
            targetAudience: "allDrivers",
            sentAt: { $gte: driverCreatedAt },
          },
        ],
      },
    },
    {
      $lookup: {
        from: readCollection,
        let: { notificationId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$notificationId", "$$notificationId"] },
                  { $eq: ["$driverId", driverId] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: "reads",
      },
    },
    { $match: { reads: { $size: 0 } } },
    { $count: "unreadCount" },
  ]);

  const unreadCount = result[0]?.unreadCount || 0;

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Driver unread notifications count fetched successfully",
    data: { unreadCount },
  });
});
