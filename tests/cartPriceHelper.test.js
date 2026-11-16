const { test } = require("node:test");
const assert = require("node:assert/strict");
const { getVariationPrice, refreshCartPrices, checkoutPriceReview } = require("../src/helpers/cartPriceHelper");

const product = (price = 100) => ({
  _id: "peanuts", productVariations: [{ _id: "500g", sellingPrice: price }],
});
const item = (price = 90) => ({ productId: "peanuts", variationId: "500g", quantity: 2, price, totalPrice: price * 2 });

test("old Rs 90 cart refreshes to Rs 100 and requires review before checkout", () => {
  const items = [item()];
  const changes = refreshCartPrices(items, [product()]);
  assert.equal(items[0].price, 100);
  assert.equal(items[0].totalPrice, 200);
  assert.deepEqual(checkoutPriceReview(items, changes, { cartValue: 180 }), {
    errorType: "CART_PRICE_CHANGED", priceChanges: changes, cartValue: 200,
  });
  assert.equal(changes[0].oldPrice, 90);
  assert.equal(changes[0].newPrice, 100);
});

test("reviewed retry and unchanged prices continue through the original flow", () => {
  const items = [item(100)];
  const changes = refreshCartPrices(items, [product()]);
  assert.deepEqual(changes, []);
  assert.equal(checkoutPriceReview(items, changes, { cartValue: 200 }), null);
  assert.equal(checkoutPriceReview(items, changes, {}), null);
});

test("stale client total is blocked even after another request refreshed the cart", () => {
  assert.equal(checkoutPriceReview([item(100)], [], { cartValue: 180 }).errorType, "CART_PRICE_CHANGED");
});

test("price decreases also require review; GST is not added a second time", () => {
  const items = [item(100)];
  const changes = refreshCartPrices(items, [product(90)]);
  assert.equal(items[0].totalPrice, 180);
  assert.equal(checkoutPriceReview(items, changes, { cartValue: 200 }).cartValue, 180);
});

test("missing, deleted, or invalid variants cannot fall back to the stale price", () => {
  for (const products of [[], [{ ...product(), isDeleted: true }],
    [{ _id: "peanuts", productVariations: [] }],
    [{ _id: "peanuts", productVariations: [{ _id: "500g", sellingPrice: 100, isDeleted: true }] }],
    [product(-1)], [product(null)]]) {
    const items = [item()];
    assert.throws(() => refreshCartPrices(items, products));
    assert.equal(items[0].price, 90);
  }
  for (const price of [undefined, null, "", NaN, Infinity, -1]) {
    assert.throws(() => getVariationPrice({ sellingPrice: price }));
  }
  assert.equal(getVariationPrice({ sellingPrice: 0 }), 0);
});

// Run real controller handlers with isolated database/payment dependencies.
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const loadController = (name, mocks) => {
  const exports = {};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src/controllers/user", name), "utf8"), {
    exports, console: { log() {}, error() {} },
    process: { env: { RAZORPAY_KEY_ID: "test", RAZORPAY_KEY_SECRET: "test" } },
    require(id) {
      if (id.endsWith("/cartPriceHelper")) return { getVariationPrice, refreshCartPrices, checkoutPriceReview };
      if (id.endsWith("/generateError")) return { catchAsyncError: (fn) => fn };
      if (id.endsWith("/responseHandler")) return { responseHandler: (response) => response };
      if (id.endsWith("/httpResponseCode")) return { DATAMISSING: 400, SUCCESS: 200 };
      return mocks[id.split("/").pop()] || {};
    },
  });
  return exports;
};

for (const [file, handler] of [["userController.js", "placeorder"], ["productsPayment.js", "createOrder"]]) {
  test(`${handler}: stale price stops before order or payment creation`, async () => {
    let saves = 0;
    let orderCreates = 0;
    let paymentCreates = 0;
    const cart = { items: [item()], isModified: () => true, save: async () => { saves++; } };
    const query = { populate: async () => cart };
    const address = { _id: "address", isDefault: true, location: { pincode: "282005" } };
    const addresses = [address];
    addresses.id = () => address;
    const controller = loadController(file, {
      cartModel: { findOne: () => query },
      userModel: { findById: async () => ({ addresses, save: async () => {} }) },
      deliveryZonesModel: { findOne: async () => ({ status: "Active" }) },
      productModel: { find: () => ({ select: () => ({ lean: async () => [product()] }) }) },
      stockSyncHelper: { validateCartStockWithPetpooja: async () => ({ ok: true }) },
      orderModel: { create: async () => { orderCreates++; } },
      razorPay: { orders: { create: async () => { paymentCreates++; } } },
    });
    const result = await controller[handler]({ user: { _id: "user" }, body: {
      addressId: "address", paymentType: "COD", cartData: { cartValue: 180 },
    } }, {});
    assert.equal(result.code, 400);
    assert.equal(result.data.errorType, "CART_PRICE_CHANGED");
    assert.equal(cart.items[0].price, 100);
    assert.equal(saves, 1);
    assert.equal(orderCreates, 0);
    assert.equal(paymentCreates, 0);
  });
}

test("addToCart updates an existing line to the current inventory price", async () => {
  const cart = { items: [item()], save: async () => {} };
  const variation = { _id: "500g", sellingPrice: 100, stockQuantity: 20 };
  const controller = loadController("userController.js", {
    userModel: { findById: async () => ({}) },
    productModel: { findById: async () => ({ productVariations: { id: () => variation } }) },
    cartModel: { findOne: async () => cart },
  });
  const result = await controller.addToCart({ user: { _id: "user" }, body: {
    productId: "peanuts", variationId: "500g", quantity: 3,
  } }, {});
  assert.equal(result.code, 200);
  assert.equal(cart.items[0].price, 100);
  assert.equal(cart.items[0].totalPrice, 300);
});

test("reviewed prepaid checkout uses matching payment/order totals and keeps GST and coupon calculation", async () => {
  const cart = { items: [item(100)], isModified: () => false };
  let paymentPayload;
  let orderPayload;
  const controller = loadController("productsPayment.js", {
    distanceDeliveryService: { requireDeliveryQuote: async () => ({ deliveryCharge: 10, platformFee: 2 }) },
    cartModel: { findOne: () => ({ populate: async () => cart }) },
    userModel: { findById: async () => ({ addresses: { id: () => ({ location: { pincode: "282005" } }) } }) },
    deliveryZonesModel: { findOne: async () => ({}) },
    productModel: { find: () => ({ select: () => ({ lean: async () => [{ ...product(), gst: 5 }] }) }) },
    stockSyncHelper: { validateCartStockWithPetpooja: async () => ({ ok: true }) },
    deliveryDateCalculator: { calculateExpectedDeliveryDate: async () => ({}) },
    autoCouponHelper: { getAutoApplicableCoupon: async () => ({ coupon: { _id: "coupon", discountType: "Percentage", discountValue: 10 } }) },
    orderModel: {
      findOne: async () => null,
      create: async (payload) => { orderPayload = payload; return { ...payload, _id: "order" }; },
    },
    razorPay: { orders: { create: async (payload) => {
      paymentPayload = payload; return { ...payload, id: "rz-order" };
    } } },
  });
  const result = await controller.createOrder({ user: { _id: "user" }, body: {
    addressId: "address", cartData: { cartValue: 200, deliveryCharge: 10, platformFee: 2 },
  } }, {});
  assert.equal(result.code, 200);
  assert.equal(orderPayload.items[0].priceWithGST, 100);
  assert.equal(orderPayload.items[0].basePrice, 95.24);
  assert.equal(orderPayload.subTotal, 200);
  assert.equal(orderPayload.couponDiscount, 20);
  assert.equal(orderPayload.grandTotal, 192);
  assert.equal(paymentPayload.amount, 19200);
});

test("all items are validated before any cart mutation", () => {
  const items = [item(), { ...item(), variationId: "missing" }];
  assert.throws(() => refreshCartPrices(items, [product()]));
  assert.equal(items[0].price, 90);
});

test("Rs 2000 prepaid order adds no gateway convenience fee or fee GST, ignoring client surcharges", async () => {
  const cart = { items: [item(1000)], isModified: () => false };
  let paymentPayload;
  let orderPayload;
  const controller = loadController("productsPayment.js", {
    distanceDeliveryService: { requireDeliveryQuote: async () => ({ deliveryCharge: 0, platformFee: 0 }) },
    cartModel: { findOne: () => ({ populate: async () => cart }) },
    userModel: { findById: async () => ({ addresses: { id: () => ({ location: { coordinates: [78, 27] } }) } }) },
    productModel: { find: () => ({ select: () => ({ lean: async () => [{ ...product(1000), gst: 5 }] }) }) },
    stockSyncHelper: { validateCartStockWithPetpooja: async () => ({ ok: true }) },
    deliveryDateCalculator: { calculateExpectedDeliveryDate: async () => ({}) },
    autoCouponHelper: { getAutoApplicableCoupon: async () => ({ coupon: null, discount: 0 }) },
    orderModel: {
      findOne: async () => null,
      create: async (payload) => { orderPayload = payload; return { ...payload, _id: "order" }; },
    },
    razorPay: { orders: { create: async (payload) => {
      paymentPayload = payload; return { ...payload, id: "rz-order" };
    } } },
  });
  const result = await controller.createOrder({ user: { _id: "user" }, body: {
    addressId: "address", cartData: {
      cartValue: 2000, deliveryCharge: 40, platformFee: 40,
      convenienceFee: 40, gatewayFee: 40, feeGST: 7.2,
    },
  } }, {});
  assert.equal(result.code, 200, result.message);
  assert.equal(orderPayload.subTotal, 2000);
  assert.equal(orderPayload.deliveryCharge, 0);
  assert.equal(orderPayload.platformFee, 0);
  assert.equal(orderPayload.grandTotal, 2000);
  assert.equal(paymentPayload.amount, 200000);
  assert.equal(result.data.amount, 200000);
  assert.deepEqual(Object.keys(paymentPayload).sort(), ["amount", "currency", "notes", "receipt"]);
});

test("saved order snapshots remain untouched and decimal totals compare in paise", () => {
  const savedOrder = { items: [item()] };
  const cartItems = structuredClone(savedOrder.items);
  refreshCartPrices(cartItems, [product(99.95)]);
  assert.equal(checkoutPriceReview(cartItems, [], { cartValue: "199.90" }), null);
  assert.equal(savedOrder.items[0].price, 90);
  assert.equal(savedOrder.items[0].totalPrice, 180);
});
