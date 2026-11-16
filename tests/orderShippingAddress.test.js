const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('src/integrations/petpooja/services/partyService.js', 'utf8');
const shipping = { id: 202, type: 'shipping', street: '22 New Colony School', city: 'Agra', pincode: '282001' };
const deliveryAddress = { houseFlatOfficeNo: '22', area_building: 'New Colony', landmark: 'School', address: 'Agra', pincode: '282001' };
const user = { petpoojaCustomerId: '10', addresses: [{ isDefault: true, houseFlatOfficeNo: 'Wrong user default' }] };
function service(addresses) {
  const context = { module: { exports: {} }, console, require: name => {
    if (name === './baseService') return class {};
    if (name === '../../../models/warehouseModel') assert.fail('billing must not depend on warehouse');
    return { PARTIES: { BASE: '/parties' } };
  } };
  vm.runInNewContext(source, context);
  const party = context.module.exports;
  party.getParty = async () => ({ addresses });
  return party;
}
test('Bill To and Ship To use order delivery snapshot despite stale IDs', async () => {
  const party = service([{ ...shipping, type: 'billing' }]);
  party.put = async () => assert.fail('matching addresses need no update');
  const order = { deliveryAddress, billingPetpoojaAddressId: '101', shippingPetpoojaAddressId: '101' };
  await party.resolveOrderShippingAddress(user, order);
  assert.equal(order.billingPetpoojaAddressId, '202');
  assert.equal(order.shippingPetpoojaAddressId, '202');
});
test('replaces warehouse billing with delivery address and refreshes IDs', async () => {
  const oldBilling = { id: 301, type: 'billing', street: 'Warehouse', city: 'Agra', pincode: '' };
  const party = service([oldBilling, shipping]);
  party.put = async (url, payload) => {
    assert.equal(url, '/10');
    assert.equal(payload.addresses[0].type, 'shipping');
    assert.equal(payload.addresses[1].type, 'billing');
    assert.equal(payload.addresses[1].street, shipping.street);
    party.getParty = async () => ({ addresses: payload.addresses.map((a, i) => ({ ...a, id: 1000 + i })) });
  };
  const order = { deliveryAddress };
  await party.resolveOrderShippingAddress(user, order);
  assert.equal(order.billingPetpoojaAddressId, '1001');
  assert.equal(order.shippingPetpoojaAddressId, '1001');
});
test('adds delivery address when party has no addresses', async () => {
  const party = service([]);
  party.put = async (url, payload) => {
    assert.equal(payload.addresses.length, 1);
    assert.equal(payload.addresses[0].type, 'billing');
    assert.equal(payload.addresses[0].street, shipping.street);
    party.getParty = async () => ({ addresses: [{ ...payload.addresses[0], id: 500 }] });
  };
  const order = { deliveryAddress };
  await party.resolveOrderShippingAddress(user, order);
  assert.equal(order.billingPetpoojaAddressId, '500');
  assert.equal(order.shippingPetpoojaAddressId, '500');
});
test('missing delivery address fails', async () => {
  await assert.rejects(service([]).resolveOrderShippingAddress(user, {}), /Order delivery address is missing/);
});
test('missing API billing match fails', async () => {
  const party = service([shipping]);
  party.put = async () => {};
  await assert.rejects(party.resolveOrderShippingAddress(user, { deliveryAddress }), /did not return the order billing address/);
});
