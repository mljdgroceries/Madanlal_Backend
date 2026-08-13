const Coupons = require('../models/promotionsAndCouponModal');
const CouponUsage = require('../models/couponUsageModel');

/**
 * Find the best auto‑applicable coupon for the given user/cart.
 * Returns an object `{ coupon, discount }` where `coupon` is the coupon document
 * (or null) and `discount` is the monetary value of the discount.
 */
async function getAutoApplicableCoupon(userId, cart, subTotal) {
  // Only consider active coupons that are marked for auto‑apply
  const now = new Date();
  const candidateCoupons = await Coupons.find({
    status: "Active",
    autoApplyForEligibleOrders: true,
    validFrom: { $lte: now },
    validTill: { $gte: now },
  });

  let bestCoupon = null;
  let bestDiscount = 0;

  for (const cp of candidateCoupons) {
    // Global usage limit
    if (cp.usageLimit && cp.usageUsed >= cp.usageLimit) continue;

    // Minimum order value requirement
    if (cp.minOrderValue && subTotal < cp.minOrderValue) continue;

    // Per‑user usage limit (if defined)
    if (cp.usagePerUser) {
      const usage = await CouponUsage.findOne({ userId, couponId: cp._id });
      if (usage && usage.usedCount >= cp.usagePerUser) continue;
    }

    // Compute discount amount based on type
    let discount = 0;
    if (cp.discountType === "Percentage") {
      discount = (subTotal * cp.discountValue) / 100;
      if (cp.maxDiscount && discount > cp.maxDiscount) discount = cp.maxDiscount;
    } else if (cp.discountType === "FixedAmount") {
      discount = cp.discountValue;
    } else if (cp.discountType === "FreeDelivery") {
      // Handled elsewhere – treat as zero discount here
      discount = 0;
    }

    // Ensure discount does not exceed subtotal
    if (discount > subTotal) discount = subTotal;

    if (discount > bestDiscount) {
      bestDiscount = discount;
      bestCoupon = cp;
    }
  }

  return { coupon: bestCoupon, discount: bestDiscount };
}

module.exports = { getAutoApplicableCoupon };
