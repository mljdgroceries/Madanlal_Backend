const { test } = require("node:test");
const assert = require("node:assert/strict");
const { distanceKm, calculateDelivery } = require("../src/helpers/distanceDeliveryHelper");
const config = {
  distanceCalculationMode: "actual", platformFee: 10, deliveryChargesEnabled: true,
  distanceRanges: [{ distanceFrom: 0, distanceTo: 20, minOrderValue: 1500,
    deliveryChargePerKm: 10, freeDeliveryAbove: 3000 }],
};

test("customer coordinates need not equal the warehouse; 20 km is inclusive", () => {
  const warehouse = [78.0081, 27.1767];
  const customer = [78.0421, 27.1751];
  const distance = distanceKm(warehouse, customer);
  assert.ok(distance > 2 && distance < 20);
  const quote = calculateDelivery(config, distance, 0);
  assert.equal(quote.serviceable, true);
  assert.equal(quote.canPlaceOrder, false); // Minimum order applies only to checkout.
  assert.equal(calculateDelivery(config, 0, 0).serviceable, true);
  assert.equal(calculateDelivery(config, 20, 1500).serviceable, true);
  assert.equal(calculateDelivery(config, 20.001, 3000).serviceable, false);
  assert.ok(distanceKm([77, 27], customer) > 20); // Moving the origin changes eligibility.
});
