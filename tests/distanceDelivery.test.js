const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { calculateDelivery, validateConfig, distanceKm, validCoordinates } = require("../src/helpers/distanceDeliveryHelper");
const config = {
  distanceCalculationMode: "actual", platformFee: 5,
  distanceRanges: [
    { distanceFrom: 0, distanceTo: 2, minOrderValue: 1500, deliveryChargePerKm: 10, freeDeliveryAbove: 3000 },
    { distanceFrom: 2, distanceTo: 4, minOrderValue: 2000, deliveryChargePerKm: 12, freeDeliveryAbove: 4000 },
    { distanceFrom: 4, distanceTo: 6, minOrderValue: 2500, deliveryChargePerKm: 15, freeDeliveryAbove: 5000 },
    { distanceFrom: 6, distanceTo: 10, minOrderValue: 3000, deliveryChargePerKm: 18, freeDeliveryAbove: 6000 },
  ],
};

test("requested examples: actual KM, free delivery, minimum order", () => {
  assert.equal(calculateDelivery(config, 3.2, 2500).deliveryCharge, 38);
  assert.equal(calculateDelivery(config, 3.5, 2500).deliveryCharge, 42);
  const free = calculateDelivery(config, 3.5, 4000);
  assert.equal(free.deliveryCharge, 0);
  assert.equal(free.canPlaceOrder, true);
  assert.equal(free.platformFee, 5);
  const blocked = calculateDelivery(config, 3.5, 1900);
  assert.equal(blocked.canPlaceOrder, false);
  assert.equal(blocked.minOrderInfo.amountToAdd, 100);
  assert.equal(blocked.errorType, "MINIMUM_ORDER_NOT_MET");
  assert.equal(calculateDelivery(config, 3.5, 2000).canPlaceOrder, true);
});

test("delivery fee and message round to whole rupees at the half-rupee boundary", () => {
  for (const mode of ["actual", "roundUp"]) {
    for (const [charge, expected] of [[81.26, 81], [81.4, 81], [81.49, 81], [81.499, 81], [81.5, 82], [81.51, 82], [81.99, 82], [82, 82]]) {
      const settings = { ...config, distanceCalculationMode: mode,
        distanceRanges: [{ ...config.distanceRanges[0], deliveryChargePerKm: charge }] };
      const quote = calculateDelivery(settings, 1, 1500);
      assert.equal(quote.deliveryCharge, expected);
      assert.equal(quote.deliveryChargeInfo.deliveryCharge, expected);
      assert.equal(quote.deliveryChargeInfo.message, `Delivery charge ₹${expected} applied for your order`);
      assert.equal(calculateDelivery(settings, 1, 3000).deliveryCharge, 0);
    }
  }
});

test("roundUp changes billable KM but selects band using actual distance", () => {
  const quote = calculateDelivery({ ...config, distanceCalculationMode: "roundUp" }, 3.2, 2500);
  assert.equal(quote.billableDistanceKm, 4);
  assert.equal(quote.deliveryCharge, 48);
  assert.equal(quote.minOrderValue, 2000);
});

test("shared boundaries, range limit, zero distance, fixed platform fee and dynamic banner", () => {
  for (const [distance, minimum] of [[0,1500],[2,1500],[2.00001,2000],[4,2000],[6,2500],[10,3000]]) {
    const quote = calculateDelivery(config, distance, 3000);
    assert.equal(quote.minOrderValue, minimum);
    assert.equal(quote.platformFee, 5);
  }
  assert.equal(calculateDelivery(config, 10.001, 100000).serviceable, false);
  assert.equal(calculateDelivery(config, 0, 1500).deliveryCharge, 0);
  assert.match(calculateDelivery(config, 1, 1500).freeDeliveryMessage, /3000/);
  assert.match(calculateDelivery(config, 3, 2500).freeDeliveryMessage, /4000/);
  assert.equal(calculateDelivery(config, 3, 3999.99).deliveryCharge, 36);
  assert.equal(calculateDelivery(config, 3, 3999.9999999999995).deliveryCharge, 0);
});

test("configuration rejects missing, negative, nonnumeric, overlapping and gapped values", () => {
  for (const field of ["distanceFrom", "distanceTo", "minOrderValue", "deliveryChargePerKm", "freeDeliveryAbove"]) {
    for (const value of [undefined, null, "2", -1, NaN, Infinity]) {
      const bad = structuredClone(config);
      bad.distanceRanges[0][field] = value;
      assert.throws(() => validateConfig(bad));
    }
  }
  for (const from of [1, 3]) {
    const bad = structuredClone(config);
    bad.distanceRanges[1].distanceFrom = from;
    assert.throws(() => validateConfig(bad), /contiguous/);
  }
  assert.throws(() => validateConfig({ ...config, platformFee: -1 }));
  assert.throws(() => validateConfig({ ...config, distanceCalculationMode: "unknown" }));
  assert.throws(() => validateConfig({ ...config, distanceRanges: [] }));
});

test("coordinates require real numeric pairs and distance changes when warehouse moves", () => {
  for (const coords of [[], [78], [181,27], [78,91], [null,27], ["78",27], [NaN,27]]) {
    assert.equal(validCoordinates(coords), false);
    assert.throws(() => distanceKm(coords, [78,27]));
  }
  assert.equal(distanceKm([78,27], [78,27]), 0);
  assert.ok(Math.abs(distanceKm([0,0], [0,1]) - 111.1949266) < 0.00001);
  assert.notEqual(distanceKm([78,27], [78,27.02]), distanceKm([78,27.01], [78,27.02]));
});

const load = (relative, mocks) => {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, "../src", relative), "utf8"), {
    module, exports: module.exports, console: { log() {}, error() {} },
    process: { env: { RAZORPAY_KEY_ID: "test", RAZORPAY_KEY_SECRET: "test" } },
    require(id) {
      const key = id.split("/").pop();
      if (key === "distanceDeliveryHelper") return { calculateDelivery, validateConfig, distanceKm, validCoordinates };
      if (key === "warehouseLocationHelper") return require("../src/helpers/warehouseLocationHelper");
      if (key === "agraCityHelper") return require("../src/helpers/agraCityHelper");
      if (key === "cartPriceHelper") return require("../src/helpers/cartPriceHelper");
      if (key === "generateError") return { catchAsyncError: (fn) => fn };
      if (key === "responseHandler") return { responseHandler: (value) => value };
      if (key === "httpResponseCode") return { SUCCESS: 200, DATAMISSING: 400, RESULTNOTFOUND: 404 };
      return mocks[key] || {};
    },
  });
  return module.exports;
};

const service = (settings = config, warehouse = { _id: "warehouse", coordinates: [78,27] }) => load("services/distanceDeliveryService.js", {
  distanceDeliveryConfigModel: { findById: () => ({ lean: async () => settings }) },
  warehouseModel: { findOne: () => ({ lean: async () => warehouse }) },
  deliveryZonesModel: { findOne: (query) => ({ lean: async () => query.status === "Active" && query["locations.pin"] === "282007" ? { _id: "zone" } : null }) },
});
const address = { _id: "address", isDefault: true, location: { coordinates: [78,27.0314762562], pincode: "282007" } };

test("setting a warehouse default repeatedly persists true and clears other defaults", async () => {
  for (const initiallyDefault of [true, false]) {
    const rows = [{ _id: "selected", isActive: true, isDefault: initiallyDefault },
      { _id: "other", isActive: true, isDefault: true }];
    const ctl = load("controllers/admin/warehouseController.js", {
      warehouseModel: {
        findOne: async () => ({ ...rows[0], save: async () => {} }),
        findOneAndUpdate: async (filter, update) => {
          assert.equal(filter._id, "selected");
          assert.equal(filter.isActive, true);
          rows[0].isDefault = update.$set.isDefault;
          return { ...rows[0] };
        },
        updateMany: async (filter, update) => {
          assert.equal(filter._id.$ne, "selected");
          for (const row of rows) if (row._id !== filter._id.$ne && row.isDefault) row.isDefault = update.$set.isDefault;
        },
        find: () => ({ sort: async () => rows.map(row => ({ ...row })) }),
      },
    });
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await ctl.setDefaultWarehouse({ params: { warehouseId: "selected" } }, {});
      assert.equal(response.data.isDefault, true);
      const fetched = await ctl.getAllWarehouses({}, {});
      assert.equal(fetched.data[0].isDefault, true);
      assert.equal(fetched.data[1].isDefault, false);
    }
  }
});

test("add/edit address requires admin pincode and warehouse range, but not minimum cart value", async () => {
  for (const handler of ["addAddress", "editAddress"]) {
    const existing = { _id: "address", location: { coordinates: [78.0081,27.1767] } };
    const user = { addresses: [existing], save: async () => { throw new Error("SAVE_REACHED"); } };
    const ctl = load("controllers/user/userController.js", {
      userModel: { findById: async () => user },
      distanceDeliveryService: service(),
    });
    const request = { user: { _id: "user" }, query: { addressId: "address" }, body: {
      fullName: "Test", area_building: "Sikandra", houseFlatOfficeNo: "Shop", countryCode: "+91",
      phoneNumber: "0000000000", addressType: "Home", isDefault: false,
      location: { coordinates: [78,27.0314762562], pincode: "999999", address: "Agra" },
    } };
    const rejected = await ctl[handler](request, {});
    assert.equal(rejected.code, 400);
    assert.equal(rejected.data.errorType, "PINCODE_NOT_SERVICEABLE");
    assert.equal(user.addresses.length, 1);
    assert.deepEqual(existing.location.coordinates, [78.0081,27.1767]);
    request.body.location.pincode = "282007";
    await assert.rejects(() => ctl[handler](request, {}), /SAVE_REACHED/);
  }
});

test("delivery charge toggle preserves minimum, service area and platform fee", () => {
  const disabled = { ...config, deliveryChargesEnabled: false };
  assert.equal(calculateDelivery(disabled, 3.5, 2500).deliveryCharge, 0);
  assert.equal(calculateDelivery(disabled, 3.5, 2500).platformFee, 5);
  assert.equal(calculateDelivery(disabled, 3.5, 1900).canPlaceOrder, false);
  assert.equal(calculateDelivery(disabled, 11, 10000).serviceable, false);
  assert.equal(calculateDelivery(disabled, 3.5, 2500).amountToFreeDelivery, 0);
  assert.throws(() => validateConfig({ ...config, deliveryChargesEnabled: "false" }));
});

test("new address response identifies the saved map pin without changing selection/defaults", async () => {
  const existing = { _id: "old-address", isSelected: true, isDefault: true,
    location: { coordinates: [78.0421422, 27.1751448] } };
  const addresses = [existing];
  addresses.push = function (value) {
    return Array.prototype.push.call(this, { ...value, _id: "new-address" });
  };
  const user = { addresses, save: async () => {} };
  const location = { coordinates: [78.021112, 27.1795328], pincode: "282003", address: "Agra Fort" };
  const ctl = load("controllers/user/userController.js", {
    userModel: { findById: async () => user },
    partyService: { syncUserParty: async () => ({}) },
    distanceDeliveryService: { getDeliveryQuote: async ({ location: input }) => {
      assert.deepEqual(input.coordinates, location.coordinates);
      return { serviceable: true, pincode: input.pincode, distanceKm: 2.1351892365452283 };
    } },
  });
  const response = await ctl.addAddress({ user: { _id: "user" }, body: {
    fullName: "Test", area_building: "H Block", houseFlatOfficeNo: "67",
    countryCode: "+91", phoneNumber: "0000000000", addressType: "Other", isDefault: false, location,
  } }, {});
  assert.equal(response.code, 200);
  assert.equal(response.data.addressId, "new-address");
  assert.equal(response.data.deliveryLocation.addressId, response.data.addressId);
  assert.equal(response.data.address, user.addresses[1]);
  assert.deepEqual(response.data.address.location.coordinates, location.coordinates);
  assert.equal(existing.isSelected, true);
  assert.equal(existing.isDefault, true);
  assert.equal(response.data.address.isSelected, false);
  assert.equal(response.data.address.isDefault, false);
});

test("quotes recheck admin pincode activation and use only the current default warehouse", async () => {
  let enabled = true;
  let origin = [78,27];
  const svc = load("services/distanceDeliveryService.js", {
    distanceDeliveryConfigModel: { findById: () => ({ lean: async () => config }) },
    warehouseModel: { findOne: (query) => {
      assert.equal(query.isDefault, true);
      assert.equal(query.isActive, true);
      return { lean: async () => ({ _id: "origin", coordinates: origin }) };
    } },
    deliveryZonesModel: { findOne: (query) => {
      assert.equal(query.status, "Active");
      assert.equal(query["locations.pin"], "282007");
      return { lean: async () => enabled ? { _id: "zone", locations: [{ pin: "282007", lat: 0, lng: 0 }] } : null };
    } },
  });
  const quote = await svc.getDeliveryQuote(address, 2500);
  assert.equal(quote.zoneId, "zone");
  assert.equal(quote.warehouseId, "origin");
  assert.ok(quote.distanceKm > 3 && quote.distanceKm < 4);
  assert.equal(quote.selectedDistanceRange.distanceFrom, 2);
  assert.equal(quote.deliveryCharge, 42);
  enabled = false;
  assert.equal((await svc.getDeliveryQuote(address, 2500)).errorType, "PINCODE_NOT_SERVICEABLE");
  await assert.rejects(() => svc.requireDeliveryQuote(address, 2500), /pincode/);
  enabled = true;
  origin = [77.3774704,28.6258719];
  assert.equal((await svc.getDeliveryQuote(address, 2500)).errorType, "OUTSIDE_DELIVERY_RANGE");
});

test("custom minimum messages substitute configured values and reset to automatic when empty", () => {
  const custom = structuredClone(config);
  custom.distanceRanges[1].minOrderMessage = "Minimum Rs.{minOrderValue}; add Rs.{amountToAdd}.";
  assert.equal(calculateDelivery(custom, 3.5, 1900).message, "Minimum Rs.2000; add Rs.100.00.");
  assert.match(calculateDelivery(custom, 3.5, 2000).message, /achieved/);
  custom.distanceRanges[1].minOrderMessage = "";
  assert.match(calculateDelivery(custom, 3.5, 1900).message, /Add ₹100/);
});

test("warehouse form accepts name and separate coordinates without changing old coordinate payloads", () => {
  const { warehouseLocationFields } = require("../src/helpers/warehouseLocationHelper");
  assert.deepEqual(warehouseLocationFields({ warehouseName: " Main ", latitude: 27, longitude: 78 }),
    { warehouseName: "Main", coordinates: [78,27] });
  assert.deepEqual(warehouseLocationFields({ coordinates: [78,27] }), { coordinates: [78,27] });
  for (const input of [{ latitude: 27 }, { latitude: "27", longitude: 78 }, { warehouseName: "" },
    { latitude: 27, longitude: 78, coordinates: [79,27] }]) {
    assert.throws(() => warehouseLocationFields(input));
  }
});

test("admin saves one global distance config, rejects overlapping ranges without writing", async () => {
  let saved;
  const ctl = load("controllers/admin/deliveryConfigController.js", {
    warehouseModel: { findOne: () => ({ lean: async () => ({ _id: "warehouse", warehouseName: "Main", coordinates: [78,27], isDefault: true, isActive: true }) }) },
    distanceDeliveryConfigModel: { findByIdAndUpdate: async (id, update) => {
      assert.equal(id, "global"); saved = update.$set; return saved;
    } },
  });
  const good = await ctl.saveDeliveryConfig({ body: config }, {});
  assert.equal(good.code, 200);
  assert.equal(good.data.warehouse._id, "warehouse");
  assert.equal(good.data.warehouse.latitude, 27);
  assert.equal(good.data.warehouse.longitude, 78);
  assert.equal(saved.platformFee, 5);
  saved = undefined;
  const bad = structuredClone(config);
  bad.distanceRanges[1].distanceFrom = 1;
  const rejected = await ctl.saveDeliveryConfig({ body: bad }, {});
  assert.equal(rejected.code, 400);
  assert.equal(saved, undefined);
});

test("existing warehouse can update only coordinates while keeping its address", async () => {
  let update;
  const ctl = load("controllers/admin/warehouseController.js", {
    warehouseModel: { findOneAndUpdate: async (filter, fields) => { update = fields; return fields; } },
  });
  const result = await ctl.updateWarehouse({ params: { warehouseId: "existing" }, body: { coordinates: [78,27] } }, {});
  assert.equal(result.code, 200);
  assert.equal(update.address, undefined);
  assert.equal(update.coordinates[0], 78);
  update = undefined;
  assert.equal((await ctl.updateWarehouse({ params: { warehouseId: "existing" }, body: { coordinates: [999,27] } }, {})).code, 400);
  assert.equal(update, undefined);
});

test("cart exposes selected-address pricing and dynamic banner, blocks below minimum", async () => {
  for (const subtotal of [1900, 2500, 4000]) {
    const cart = { items: [{ productId: "p", variationId: "v", price: subtotal, quantity: 1 }], isModified: () => false };
    const ctl = load("controllers/user/userController.js", {
      distanceDeliveryService: service(),
      cartModel: { findOne: async () => cart },
      productModel: { findById: () => ({ lean: () => ({ select: async () => ({ _id: "p",
        productVariations: [{ _id: "v", sellingPrice: subtotal }] }) }) }) },
      userModel: { findById: () => ({ lean: async () => ({ addresses: [address] }) }) },
      autoCouponHelper: { getAutoApplicableCoupon: async () => ({ coupon: null, discount: 0 }) },
      freeItemRuleModel: { find: () => ({ populate: async () => [] }) },
    });
    const result = await ctl.getCart({ user: { _id: "user" }, query: { addressId: "address" } }, {});
    assert.equal(result.code, 200, result.message);
    assert.equal(result.data.canPlaceOrder, subtotal >= 2000);
    assert.match(result.data.freeDeliveryMessage, /4000/);
    assert.equal(result.data.deliveryCharge, subtotal >= 4000 ? 0 : 42);
    assert.equal(result.data.platformFee, 5);
  }
});

test("guest cart quotes mapped location and requests a map pin when coordinates are absent", async () => {
  const ctl = load("controllers/user/userController.js", {
    distanceDeliveryService: service(),
    productModel: { findById: () => ({ lean: () => ({ select: async () => ({ _id: "p",
      productVariations: [{ _id: "v", sellingPrice: 2500 }] }) }) }) },
  });
  const items = [{ productId: "p", variationId: "v", quantity: 1 }];
  const mapped = await ctl.guestGetCart({ body: { items, location: address.location } }, {});
  assert.equal(mapped.data.totalAmount, 2547);
  assert.equal(mapped.data.canPlaceOrder, false);
  assert.match(mapped.data.freeDeliveryMessage, /4000/);
  const unmapped = await ctl.guestGetCart({ body: { items } }, {});
  assert.equal(unmapped.data.serviceable, false);
  assert.equal(unmapped.data.deliveryPricing.errorType, "ADDRESS_LOCATION_MISSING");
  assert.equal(unmapped.data.freeDeliveryMessage, "");
});

test("missing configuration/locations and outside addresses block", async () => {
  for (const [svc, addr, expected] of [
    [service(null), address, "DELIVERY_NOT_CONFIGURED"],
    [service(config, {}), address, "WAREHOUSE_LOCATION_MISSING"],
    [service(), {}, "ADDRESS_LOCATION_MISSING"],
    [service(), { location: { coordinates: [78,28], pincode: "282007" } }, "OUTSIDE_DELIVERY_RANGE"],
    [service(), { location: { coordinates: [78,27], pincode: "999999" } }, "PINCODE_NOT_SERVICEABLE"],
    [service(), { location: { coordinates: [78,27], pincode: "" } }, "INVALID_PINCODE"],
  ]) {
    const quote = await svc.getDeliveryQuote(addr, 10000);
    assert.equal(quote.canPlaceOrder, false);
    assert.equal(quote.errorType, expected);
    await assert.rejects(() => svc.requireDeliveryQuote(addr, 10000));
  }
  const quote = await service().requireDeliveryQuote(address, 2500);
  assert.equal(quote.deliveryCharge, 42);
  assert.equal(quote.platformFee, 5);
});

test("free delivery coupon works at checkout but never bypasses minimum order", async () => {
  const svc = service();
  const coupon = { discountType: "FreeDelivery", status: "Active", validFrom: "2000-01-01", validTill: "2100-01-01" };
  assert.equal((await svc.requireDeliveryQuote(address, 2500, { coupon })).deliveryCharge, 0);
  await assert.rejects(() => svc.requireDeliveryQuote(address, 1900, { coupon }), /minimum order/);
  assert.equal((await svc.requireDeliveryQuote(address, 2500, { coupon: { ...coupon, status: "Inactive" } })).deliveryCharge, 42);
});

for (const clientFee of [undefined, 0, 54]) {
  for (const enabled of [true, false]) {
  test(`prepaid Rs 99 checkout with client fee ${clientFee} and delivery enabled ${enabled}`, async () => {
    // Fixture permits this small cart; production minimum-order rules still apply.
    const settings = { distanceCalculationMode: "actual", platformFee: 15, deliveryChargesEnabled: enabled,
      distanceRanges: [{ distanceFrom: 0, distanceTo: 20, minOrderValue: 0,
        deliveryChargePerKm: 54 / distanceKm([78, 27], address.location.coordinates),
        freeDeliveryAbove: 3000 }] };
    const quotes = service(settings);
    const cartQuote = await quotes.getDeliveryQuote(address, 30);
    let paymentPayload;
    let orderPayload;
    const cart = { items: [{ productId: "p", variationId: "v", price: 5, quantity: 6 }],
      isModified: () => false };
    const ctl = load("controllers/user/productsPayment.js", {
      distanceDeliveryService: quotes,
      cartModel: { findOne: () => ({ populate: async () => cart }) },
      userModel: { findById: async () => ({ addresses: { id: (id) => id === "address" ? address : null } }) },
      productModel: { find: () => ({ select: () => ({ lean: async () => [{ _id: "p", gst: 5,
        productVariations: [{ _id: "v", sellingPrice: 5 }] }] }) }) },
      stockSyncHelper: { validateCartStockWithPetpooja: async () => ({ ok: true }) },
      deliveryDateCalculator: { calculateExpectedDeliveryDate: async () => ({}) },
      autoCouponHelper: { getAutoApplicableCoupon: async () => ({ coupon: null, discount: 0 }) },
      orderModel: { findOne: async () => null,
        create: async (payload) => { orderPayload = payload; return { ...payload, _id: "order" }; } },
      razorPay: { orders: { create: async (payload) => {
        paymentPayload = payload; return { ...payload, id: "rz-197" };
      } } },
    });
    const cartData = { couponDiscount: 0, platformFee: 15, totalAmount: 99 };
    if (clientFee !== undefined) cartData.deliveryCharge = clientFee;
    const response = await ctl.createOrder({ user: { _id: "user" }, body: {
      addressId: "address", cartData,
    } }, {});
    if (!enabled) {
      assert.equal(response.code, 400);
      assert.equal(response.data.errorType, "CHECKOUT_TOTAL_CHANGED");
      assert.equal(response.data.deliveryCharge, 0);
      assert.equal(response.data.totalAmount, 45);
      assert.equal(paymentPayload, undefined);
      assert.equal(orderPayload, undefined);
      return;
    }
    assert.equal(response.code, 200, response.message);
    assert.equal(cartQuote.deliveryCharge, 54);
    assert.equal(orderPayload.deliveryCharge, cartQuote.deliveryCharge);
    assert.equal(orderPayload.platformFee, 15);
    assert.equal(orderPayload.subTotal, 30);
    assert.equal(orderPayload.grandTotal, 99);
    assert.equal(paymentPayload.amount, 9900);
    assert.equal(response.data.amount, 9900);
    assert.equal(response.data.deliveryCharge, 54);
    assert.equal(response.data.platformFee, 15);
    assert.equal(response.data.totalAmount, 99);
    assert.equal(response.data.razorpayOrderId, orderPayload.razorpayOrderId);
  });
  }
}

for (const [file, handler] of [["userController.js", "placeorder"], ["productsPayment.js", "createOrder"]]) {
  for (const subtotal of [1900, 2500, 4000]) {
    test(`${handler}: server prices ${subtotal} cart and ignores forged client fee`, async () => {
      let capturedOrder;
      let capturedPayment;
      const addresses = [structuredClone(address)];
      addresses.id = () => addresses[0];
      const cart = { items: [{ productId: "p", variationId: "v", price: subtotal, quantity: 1 }], isModified: () => false };
      const ctl = load(`controllers/user/${file}`, {
        distanceDeliveryService: service(),
        cartModel: { findOne: () => ({ populate: async () => cart }) },
        userModel: { findById: async () => ({ addresses, save: async () => {} }) },
        productModel: { find: () => ({ select: () => ({ lean: async () => [{ _id: "p", gst: 5,
          productVariations: [{ _id: "v", sellingPrice: subtotal }] }] }) }) },
        stockSyncHelper: { validateCartStockWithPetpooja: async () => ({ ok: true }) },
        deliveryDateCalculator: { calculateExpectedDeliveryDate: async () => ({}) },
        autoCouponHelper: { getAutoApplicableCoupon: async () => ({ coupon: null, discount: 0 }) },
        orderModel: {
          findOne: async () => null,
          create: async (payload) => {
            capturedOrder = payload;
            // Stop COD after persistence, before unrelated stock/external integration work.
            if (handler === "placeorder") throw new Error("ORDER_CAPTURED");
            return { ...payload, _id: "order" };
          },
        },
        razorPay: { orders: { create: async (payload) => { capturedPayment = payload; return { ...payload, id: "rz" }; } } },
      });
      const invoke = () => ctl[handler]({ user: { _id: "user" }, body: {
        addressId: "address", paymentType: "COD", cartData: { cartValue: subtotal, deliveryCharge: 0, platformFee: 0 },
      } }, {});
      if (subtotal < 2000) {
        const response = await invoke();
        assert.equal(response.code, 400);
        assert.equal(response.data.errorType, "MINIMUM_ORDER_NOT_MET");
        assert.equal(capturedOrder, undefined);
        assert.equal(capturedPayment, undefined);
      } else {
        if (handler === "placeorder") await assert.rejects(invoke, /ORDER_CAPTURED/);
        else { const response = await invoke(); assert.equal(response.code, 200, response.message); }
        const fee = subtotal >= 4000 ? 0 : 42;
        assert.equal(capturedOrder.deliveryCharge, fee);
        assert.equal(capturedOrder.platformFee, 5);
        assert.equal(capturedOrder.grandTotal, subtotal + fee + 5);
        assert.equal(capturedOrder.deliveryPricing.freeDeliveryAbove, 4000);
        if (capturedPayment) assert.equal(capturedPayment.amount, (subtotal + fee + 5) * 100);
      }
    });
  }
}
