const Config = require("../models/distanceDeliveryConfigModel");
const Warehouse = require("../models/warehouseModel");
const Zone = require("../models/deliveryZonesModel");
const { validCoordinates, distanceKm, calculateDelivery } = require("../helpers/distanceDeliveryHelper");

const getDeliveryQuote = async (address, cartValue) => {
  const [config, warehouse] = await Promise.all([
    Config.findById("global").lean(),
    Warehouse.findOne({ isDefault: true, isActive: true }).lean(),
  ]);
  const unavailable = (errorType, message) => ({ pricingMode: "distance", serviceable: false,
    canPlaceOrder: false, deliveryCharge: 0, platformFee: config?.platformFee || 0,
    distanceRanges: config?.distanceRanges || [], errorType, message });
  if (!config) return unavailable("DELIVERY_NOT_CONFIGURED", "Distance delivery configuration is not set. Please contact the store.");
  if (!validCoordinates(warehouse?.coordinates)) {
    return unavailable("WAREHOUSE_LOCATION_MISSING", "Warehouse location is not configured. Please contact the store.");
  }
  if (!validCoordinates(address?.location?.coordinates)) {
    return unavailable("ADDRESS_LOCATION_MISSING", "Please set your delivery address location on the map.");
  }
  // Only active admin-configured pincodes are eligible. Zone lat/lng is
  // never a distance origin; all quotes use the active default warehouse.
  const rawPincode = address.location.pincode;
  const pincode = typeof rawPincode === "string" || typeof rawPincode === "number"
    ? String(rawPincode).trim() : "";
  if (!/^[1-9][0-9]{5}$/.test(pincode)) {
    return unavailable("INVALID_PINCODE", "A valid six-digit pincode is required inside location.");
  }
  const zone = await Zone.findOne({ "locations.pin": pincode, status: "Active" }).lean();
  if (!zone) return unavailable("PINCODE_NOT_SERVICEABLE", "Delivery is not available for this pincode.");
  return { ...calculateDelivery(config, distanceKm(warehouse.coordinates, address.location.coordinates), cartValue),
    pincode, zoneId: zone._id,
    warehouseId: warehouse._id, warehouseCoordinates: warehouse.coordinates,
    customerCoordinates: address.location.coordinates };
};

const requireDeliveryQuote = async (address, cartValue, { coupon, userId } = {}) => {
  const quote = await getDeliveryQuote(address, cartValue);
  if (!quote.canPlaceOrder) {
    const error = new Error(quote.message);
    error.statusCode = 400;
    error.errorType = quote.errorType;
    throw error;
  }
  if (coupon?.discountType === "FreeDelivery" && coupon.status === "Active") {
    const now = new Date();
    const withinDates = now >= new Date(coupon.validFrom) && now <= new Date(coupon.validTill);
    const withinGlobalLimit = !coupon.usageLimit || coupon.usageUsed < coupon.usageLimit;
    const meetsMinimum = !coupon.minOrderValue || cartValue >= coupon.minOrderValue;
    if (withinDates && withinGlobalLimit && meetsMinimum) {
      const usage = coupon.usagePerUser
        ? await require("../models/couponUsageModel").findOne({ userId, couponId: coupon._id }) : null;
      if (!coupon.usagePerUser || (usage?.usedCount || 0) < coupon.usagePerUser) {
        quote.deliveryCharge = 0;
        quote.freeDeliveryCouponApplied = true;
        quote.deliveryChargeInfo = { ...quote.deliveryChargeInfo, deliveryCharge: 0,
          message: "Free delivery applied via coupon!" };
      }
    }
  }
  return quote;
};

module.exports = { getDeliveryQuote, requireDeliveryQuote };
