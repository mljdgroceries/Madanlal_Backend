const money = (value) => Number(value.toFixed(2));

const validCoordinates = (value) => Array.isArray(value) && value.length === 2 &&
  value.every((n) => typeof n === "number" && Number.isFinite(n)) &&
  Math.abs(value[0]) <= 180 && Math.abs(value[1]) <= 90;

const validateConfig = (config) => {
  if (config.deliveryChargesEnabled !== undefined && typeof config.deliveryChargesEnabled !== "boolean") {
    throw new Error("deliveryChargesEnabled must be true or false.");
  }
  if (!["actual", "roundUp"].includes(config.distanceCalculationMode)) {
    throw new Error("distanceCalculationMode must be actual or roundUp.");
  }
  if (typeof config.platformFee !== "number" || !Number.isFinite(config.platformFee) || config.platformFee < 0) {
    throw new Error("platformFee must be a non-negative number.");
  }
  if (!Array.isArray(config.distanceRanges) || !config.distanceRanges.length) {
    throw new Error("At least one distance range is required.");
  }
  const ranges = [...config.distanceRanges].sort((a, b) => a.distanceFrom - b.distanceFrom);
  let end = 0;
  for (const range of ranges) {
    if (range.minOrderMessage !== undefined && typeof range.minOrderMessage !== "string") {
      throw new Error("minOrderMessage must be a string.");
    }
    for (const key of ["distanceFrom", "distanceTo", "minOrderValue", "deliveryChargePerKm", "freeDeliveryAbove"]) {
      if (typeof range[key] !== "number" || !Number.isFinite(range[key]) || range[key] < 0) {
        throw new Error(`${key} must be a non-negative number.`);
      }
    }
    if (range.distanceFrom !== end || range.distanceTo <= range.distanceFrom) {
      throw new Error("Distance ranges must start at 0 and be contiguous, without overlaps or gaps.");
    }
    if (range.freeDeliveryAbove < range.minOrderValue) {
      throw new Error("freeDeliveryAbove must be at least minOrderValue.");
    }
    end = range.distanceTo;
  }
  return ranges;
};

// Great-circle distance. Coordinates use GeoJSON order: [longitude, latitude].
const distanceKm = (origin, destination) => {
  if (!validCoordinates(origin) || !validCoordinates(destination)) {
    throw new Error("Valid warehouse and customer coordinates [longitude, latitude] are required.");
  }
  const rad = (n) => n * Math.PI / 180;
  const a = Math.sin(rad(destination[1] - origin[1]) / 2) ** 2 +
    Math.cos(rad(origin[1])) * Math.cos(rad(destination[1])) *
    Math.sin(rad(destination[0] - origin[0]) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
};

const calculateDelivery = (config, distance, cartValue) => {
  const ranges = validateConfig(config);
  if (!Number.isFinite(distance) || distance < 0 || !Number.isFinite(cartValue) || cartValue < 0) {
    throw new Error("Distance and cart value must be non-negative numbers.");
  }
  cartValue = money(cartValue);
  // The lower band owns the shared boundary: 0–2 includes 2, 2–4 means >2–4.
  const range = ranges.find((r, i) => (i === 0 ? distance >= 0 : distance > r.distanceFrom) && distance <= r.distanceTo);
  const base = { pricingMode: "distance", distanceMethod: "straightLine", distanceKm: distance,
    distanceCalculationMode: config.distanceCalculationMode, platformFee: config.platformFee,
    distanceRanges: ranges, deliveryChargesEnabled: config.deliveryChargesEnabled !== false };
  if (!range) return { ...base, serviceable: false, canPlaceOrder: false, deliveryCharge: 0,
    errorType: "OUTSIDE_DELIVERY_RANGE", message: "Your address is outside our delivery range." };
  const billableDistanceKm = config.distanceCalculationMode === "roundUp" ? Math.ceil(distance) : distance;
  const amountToAdd = money(Math.max(range.minOrderValue - cartValue, 0));
  const freeDelivery = config.deliveryChargesEnabled === false || cartValue >= range.freeDeliveryAbove;
  // Round the final delivery fee to whole rupees; 0.50 rounds up.
  const deliveryCharge = freeDelivery ? 0 : Math.round(billableDistanceKm * range.deliveryChargePerKm);
  const freeDeliveryMessage = config.deliveryChargesEnabled === false ? "No delivery fee on your order"
    : `No delivery fee on orders of ₹${range.freeDeliveryAbove} or above`;
  const customMessage = (range.minOrderMessage || "").trim()
    .replaceAll("{minOrderValue}", String(range.minOrderValue))
    .replaceAll("{amountToAdd}", amountToAdd.toFixed(2));
  const message = amountToAdd > 0
    ? customMessage || `Add ₹${amountToAdd.toFixed(2)} more to reach the minimum order value of ₹${range.minOrderValue}.`
    : `Minimum order value of ₹${range.minOrderValue} achieved!`;
  return { ...base, serviceable: true, canPlaceOrder: cartValue >= range.minOrderValue,
    billableDistanceKm, selectedDistanceRange: range, deliveryCharge,
    minOrderValue: range.minOrderValue, freeDeliveryAbove: range.freeDeliveryAbove,
    freeDeliveryMessage, amountToFreeDelivery: freeDelivery ? 0 : money(Math.max(range.freeDeliveryAbove - cartValue, 0)),
    message, errorType: cartValue < range.minOrderValue ? "MINIMUM_ORDER_NOT_MET" : null,
    minOrderInfo: { minOrderValue: range.minOrderValue, amountToAdd, message },
    deliveryChargeInfo: { deliveryCharge, freeDeliveryAbove: range.freeDeliveryAbove, freeDeliveryMessage,
      message: freeDelivery ? "Free delivery applied!" : `Delivery charge ₹${deliveryCharge} applied for your order` } };
};

module.exports = { validCoordinates, validateConfig, distanceKm, calculateDelivery };
