const crypto = require("crypto");
const axios = require("axios");
const razorpay = require("../config/razorPay");

const resolveGstPercent = (...values) => {
  for (const value of values) {
    const num = Number(value);
    if (Number.isFinite(num) && num > 0) return num;
  }
  return 0;
};

const getUnitPriceWithGST = (cartItem, variation, product) => {
  const base = Number(cartItem.basePrice) || 0;
  const existingQty = Number(cartItem.quantity) || 0;
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

  if (
    cartRawPriceWithGST > 0 &&
    (gstPercent <= 0 || cartRawPriceWithGST > base)
  ) {
    return cartRawPriceWithGST;
  }
  if (fromSubtotal > 0 && (gstPercent <= 0 || fromSubtotal > base)) {
    return fromSubtotal;
  }
  if (gstPercent > 0) {
    return computedUnitPriceWithGST;
  }
  if (cartRawPriceWithGST > 0) {
    return cartRawPriceWithGST;
  }
  return base;
};

const isRefundEligible = (order) => {
  if (!order) return false;
  if (order.paymentMethod !== "Prepaid") return false;
  if (order.paymentStatus !== "Paid") return false;
  const paymentId = (order.razorpayPaymentId || "").trim();
  if (!paymentId) return false;
  if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {
    return false;
  }
  return true;
};

const computeRefundForReturnItems = (order, returnItems) => {
  if (!returnItems?.length) {
    return {
      refundAmountRupees: 0,
      refundAmountPaise: 0,
      lineBreakdown: [],
    };
  }

  let refundAmountRupees = 0;
  const lineBreakdown = [];

  for (const item of returnItems) {
    const cartItem = order.items.find(
      (i) =>
        i.productId?._id?.toString?.() === item.productId &&
        i.variationId?.toString?.() === item.variationId,
    );

    if (!cartItem) continue;

    const returnQty = Number(item.returnQty);
    const existingQty = Number(cartItem.quantity) || 0;
    if (returnQty <= 0) continue;

    const effectiveReturnQty = Math.min(returnQty, existingQty);
    if (effectiveReturnQty <= 0) continue;

    const variation = (cartItem.productId?.productVariations || []).find(
      (v) => v?._id?.toString() === cartItem.variationId?.toString(),
    );
    const unitPriceWithGST = getUnitPriceWithGST(cartItem, variation, null);
    const lineAmount = Number((effectiveReturnQty * unitPriceWithGST).toFixed(2));

    refundAmountRupees += lineAmount;
    lineBreakdown.push({
      productId: item.productId,
      variationId: item.variationId,
      returnQty: effectiveReturnQty,
      unitPriceWithGST,
      lineAmount,
    });
  }

  refundAmountRupees = Number(refundAmountRupees.toFixed(2));

  return {
    refundAmountRupees,
    refundAmountPaise: Math.round(refundAmountRupees * 100),
    lineBreakdown,
  };
};

const buildIdempotencyKey = (orderId, driverId, returnItems) => {
  const payload = JSON.stringify(
    returnItems.map((i) => ({
      productId: i.productId,
      variationId: i.variationId,
      returnQty: Number(i.returnQty),
    })),
  );
  const hash = crypto.createHash("sha256").update(payload).digest("hex").slice(0, 16);
  return `refund_${orderId}_${driverId}_${hash}`;
};

const buildCancelRefundIdempotencyKey = (orderId) => `cancel_refund_${orderId}`;

const getTotalRefundedPaise = (order) =>
  (order.razorpayRefunds || [])
    .filter((r) => r.refundId && ["processed", "pending"].includes(r.status))
    .reduce((sum, r) => sum + (Number(r.amount) || 0), 0);

const getOriginalPaidPaise = async (order) => {
  try {
    const payment = await razorpay.payments.fetch(order.razorpayPaymentId);
    if (payment?.amount) {
      return Number(payment.amount);
    }
  } catch (err) {
    console.error("Razorpay payment fetch for refund cap failed:", err?.error || err);
  }

  const grandTotal = Number(order.grandTotal) || 0;
  const totalRefundedRupees = Number(order.totalRefundedAmount) || 0;
  return Math.round((grandTotal + totalRefundedRupees) * 100);
};

const createRefund = async ({ paymentId, amountPaise, idempotencyKey, notes }) => {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;

  const response = await axios.post(
    `https://api.razorpay.com/v1/payments/${paymentId}/refund`,
    {
      amount: amountPaise,
      notes: notes || {},
    },
    {
      auth: {
        username: keyId,
        password: keySecret,
      },
      headers: {
        "Content-Type": "application/json",
        "X-Refund-Idempotency": idempotencyKey,
      },
    },
  );

  return response.data;
};

const mapRazorpayRefundToDoc = ({
  data,
  idempotencyKey,
  requestedAmountPaise,
  returnItemsSnapshot,
}) => ({
  refundId: data.id,
  amount: data.amount,
  currency: data.currency,
  paymentId: data.payment_id,
  status: data.status,
  speedProcessed: data.speed_processed,
  speedRequested: data.speed_requested,
  idempotencyKey,
  requestedAmountPaise,
  returnItemsSnapshot,
  rawResponse: data,
  createdAt: new Date(),
});

const updateOrderRefundTotals = (order, originalPaidPaise) => {
  const successfulRefunds = (order.razorpayRefunds || []).filter((r) => r.refundId);
  const totalRefundedPaise = successfulRefunds.reduce(
    (sum, r) => sum + (Number(r.amount) || 0),
    0,
  );
  order.totalRefundedAmount = Number((totalRefundedPaise / 100).toFixed(2));

  const lastEntry = order.razorpayRefunds[order.razorpayRefunds.length - 1];
  if (lastEntry?.status === "failed" || (!lastEntry?.refundId && lastEntry?.error)) {
    order.refundStatus = "failed";
    return;
  }

  if (totalRefundedPaise <= 0) {
    order.refundStatus = order.refundStatus === "failed" ? "failed" : "none";
    return;
  }

  const paidCap = Number(originalPaidPaise) || 0;
  if (paidCap > 0 && totalRefundedPaise >= paidCap) {
    order.refundStatus = "completed";
    order.paymentStatus = "Refunded";
  } else {
    order.refundStatus = "partial";
  }
};

/**
 * Process Razorpay refund after driver return (prepaid, post-delivery only).
 * Return is already saved; failures are recorded on the order.
 */
const processDriverReturnRefund = async ({
  order,
  isDeliveredOrder,
  returnItems,
  driverId,
  refundAmountRupees: precomputedRupees,
}) => {
  const skipped = { attempted: false, status: "skipped", reason: "not_eligible" };

  if (!isRefundEligible(order)) {
    return skipped;
  }

  const computed = computeRefundForReturnItems(order, returnItems);
  const refundAmountRupees =
    precomputedRupees > 0 ? Number(precomputedRupees) : computed.refundAmountRupees;
  let refundAmountPaise = Math.round(refundAmountRupees * 100);

  if (refundAmountPaise <= 0) {
    return { attempted: false, status: "skipped", reason: "zero_amount" };
  }

  const idempotencyKey = buildIdempotencyKey(
    order._id.toString(),
    driverId.toString(),
    returnItems,
  );

  const existingAttempt = (order.razorpayRefunds || []).find(
    (r) => r.idempotencyKey === idempotencyKey && r.refundId,
  );
  if (existingAttempt) {
    return {
      attempted: true,
      status: existingAttempt.status,
      razorpayRefundId: existingAttempt.refundId,
      amount: existingAttempt.amount,
      amountRupees: Number((existingAttempt.amount / 100).toFixed(2)),
      idempotencyKey,
      duplicate: true,
    };
  }

  let originalPaidPaise = await getOriginalPaidPaise(order);
  const alreadyRefundedPaise = getTotalRefundedPaise(order);
  const remainingPaise = Math.max(originalPaidPaise - alreadyRefundedPaise, 0);

  if (remainingPaise <= 0) {
    return { attempted: false, status: "skipped", reason: "already_fully_refunded" };
  }

  if (refundAmountPaise > remainingPaise) {
    refundAmountPaise = remainingPaise;
  }

  if (!order.razorpayRefunds) {
    order.razorpayRefunds = [];
  }

  order.refundStatus = "pending";

  try {
    const refundData = await createRefund({
      paymentId: order.razorpayPaymentId,
      amountPaise: refundAmountPaise,
      idempotencyKey,
      notes: {
        orderId: order._id?.toString(),
        appOrderId: order.orderId || "",
      },
    });

    order.razorpayRefunds.push(
      mapRazorpayRefundToDoc({
        data: refundData,
        idempotencyKey,
        requestedAmountPaise: refundAmountPaise,
        returnItemsSnapshot: returnItems,
      }),
    );
    updateOrderRefundTotals(order, originalPaidPaise);
    await order.save();

    return {
      attempted: true,
      status: refundData.status,
      razorpayRefundId: refundData.id,
      amount: refundData.amount,
      amountRupees: Number((refundData.amount / 100).toFixed(2)),
      idempotencyKey,
      currency: refundData.currency,
    };
  } catch (err) {
    const rzError = err?.response?.data?.error || err?.error || err;
    console.error("Razorpay refund failed:", rzError);

    order.razorpayRefunds.push({
      paymentId: order.razorpayPaymentId,
      status: "failed",
      idempotencyKey,
      requestedAmountPaise: refundAmountPaise,
      returnItemsSnapshot: returnItems,
      error: {
        message: rzError?.description || rzError?.message || err.message,
        code: rzError?.code,
        reason: rzError?.reason,
        source: rzError?.source,
      },
      createdAt: new Date(),
    });
    order.refundStatus = "failed";
    await order.save();

    return {
      attempted: true,
      status: "failed",
      idempotencyKey,
      amount: refundAmountPaise,
      amountRupees: Number((refundAmountPaise / 100).toFixed(2)),
      error: rzError?.description || rzError?.message || err.message,
    };
  }
};

const processFullOrderCancelRefund = async ({ order, cancelledBy, actorId }) => {
  const skipped = { attempted: false, status: "skipped", reason: "not_eligible" };

  if (!isRefundEligible(order)) {
    return skipped;
  }

  const idempotencyKey = buildCancelRefundIdempotencyKey(order._id.toString());
  const existingAttempt = (order.razorpayRefunds || []).find(
    (r) => r.idempotencyKey === idempotencyKey && r.refundId,
  );
  if (existingAttempt) {
    return {
      attempted: true,
      status: existingAttempt.status,
      razorpayRefundId: existingAttempt.refundId,
      amount: existingAttempt.amount,
      amountRupees: Number((existingAttempt.amount / 100).toFixed(2)),
      idempotencyKey,
      duplicate: true,
    };
  }

  const originalPaidPaise = await getOriginalPaidPaise(order);
  const alreadyRefundedPaise = getTotalRefundedPaise(order);
  const remainingPaidPaise = Math.max(originalPaidPaise - alreadyRefundedPaise, 0);
  const appOrderAmountPaise = Math.round((Number(order.grandTotal) || 0) * 100);
  const refundAmountPaise = Math.min(appOrderAmountPaise, remainingPaidPaise);

  if (refundAmountPaise <= 0) {
    return { attempted: false, status: "skipped", reason: "already_fully_refunded" };
  }

  if (!order.razorpayRefunds) {
    order.razorpayRefunds = [];
  }

  order.refundStatus = "pending";

  const orderItemsSnapshot = (order.items || []).map((item) => ({
    productId: item.productId?._id || item.productId,
    variationId: item.variationId,
    quantity: Number(item.quantity || 0),
  }));

  try {
    const refundData = await createRefund({
      paymentId: order.razorpayPaymentId,
      amountPaise: refundAmountPaise,
      idempotencyKey,
      notes: {
        orderId: order._id?.toString(),
        appOrderId: order.orderId || "",
        refundType: "full_order_cancel",
        cancelledBy: cancelledBy || "",
        actorId: actorId?.toString?.() || "",
      },
    });

    order.razorpayRefunds.push(
      mapRazorpayRefundToDoc({
        data: refundData,
        idempotencyKey,
        requestedAmountPaise: refundAmountPaise,
        returnItemsSnapshot: orderItemsSnapshot,
      }),
    );
    updateOrderRefundTotals(order, originalPaidPaise);
    await order.save();

    return {
      attempted: true,
      status: refundData.status,
      razorpayRefundId: refundData.id,
      amount: refundData.amount,
      amountRupees: Number((refundData.amount / 100).toFixed(2)),
      idempotencyKey,
      currency: refundData.currency,
    };
  } catch (err) {
    const rzError = err?.response?.data?.error || err?.error || err;
    console.error("Razorpay full cancel refund failed:", rzError);

    order.razorpayRefunds.push({
      paymentId: order.razorpayPaymentId,
      status: "failed",
      idempotencyKey,
      requestedAmountPaise: refundAmountPaise,
      returnItemsSnapshot: orderItemsSnapshot,
      error: {
        message: rzError?.description || rzError?.message || err.message,
        code: rzError?.code,
        reason: rzError?.reason,
        source: rzError?.source,
      },
      createdAt: new Date(),
    });
    order.refundStatus = "failed";
    await order.save();

    return {
      attempted: true,
      status: "failed",
      idempotencyKey,
      amount: refundAmountPaise,
      amountRupees: Number((refundAmountPaise / 100).toFixed(2)),
      error: rzError?.description || rzError?.message || err.message,
    };
  }
};

module.exports = {
  isRefundEligible,
  computeRefundForReturnItems,
  processDriverReturnRefund,
  processFullOrderCancelRefund,
  buildIdempotencyKey,
};
