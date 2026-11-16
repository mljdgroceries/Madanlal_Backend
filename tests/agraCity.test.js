const { test } = require("node:test");
const assert = require("node:assert/strict");
const { isInAgraCity, validateAgraAddress, polygonContains } = require("../src/helpers/agraCityHelper");
const { distanceKm } = require("../src/helpers/distanceDeliveryHelper");

test("Sikandra address is allowed even with a warehouse over 20 km away", () => {
  const coordinates = [77.954133, 27.2273367];
  assert.ok(distanceKm([77.3774704, 28.6258719], coordinates) > 160);
  assert.equal(validateAgraAddress({ coordinates }).serviceable, true);
  assert.equal(isInAgraCity([78.0081, 27.1767]), true);
  assert.equal(isInAgraCity([78.0421, 27.1751]), true);
});

test("outside-city and invalid coordinates cannot be bypassed by address text or pincode", () => {
  for (const coordinates of [[77.3774704,28.6258719], [77.67,27.49], [78.2,27.1767]]) {
    assert.equal(validateAgraAddress({ coordinates, address: "Agra", pincode: "282007" }).errorType, "OUTSIDE_AGRA_CITY");
  }
  for (const coordinates of [undefined, [], [78], ["78",27], [181,27], [78,NaN]]) {
    assert.equal(validateAgraAddress({ coordinates }).errorType, "ADDRESS_LOCATION_MISSING");
  }
});

test("polygon edges and holes are handled without treating the bounding box as the city", () => {
  const rings = [[[0,0],[4,0],[4,4],[0,4],[0,0]], [[1,1],[2,1],[2,2],[1,2],[1,1]]];
  assert.equal(polygonContains([0,0], rings), true);
  assert.equal(polygonContains([0,2], rings), true);
  assert.equal(polygonContains([3,3], rings), true);
  assert.equal(polygonContains([1.5,1.5], rings), false);
  assert.equal(polygonContains([1,1.5], rings), true);
  assert.equal(polygonContains([5,2], rings), false);
});
