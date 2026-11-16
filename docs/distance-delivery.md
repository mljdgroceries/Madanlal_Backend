# Distance-based delivery: backend and app integration

## Admin pincode eligibility (2026-09-24)

Add/edit address, signed-in and guest carts, COD and prepaid checkout now use the same delivery quote service. `location.pincode` must be a six-digit pincode listed in `locations.pin` of an active admin zone. Configure these using `POST /api/v1/admin/createZone` or `PUT /api/v1/admin/updateZone`. Unlisted/inactive/deleted pincodes return `PINCODE_NOT_SERVICEABLE`; invalid pincodes return `INVALID_PINCODE`. The earlier Agra ward boundary is no longer used in the request flow. This matches the user-provided pincode only; it does not reverse-geocode coordinates or prove geographic postal membership.

After pincode eligibility, distance from the active default warehouse to `location.coordinates` selects the matching global distance band. Zone coordinates are never used as an origin. No hard-coded 20 km limit applies: the admin's final band sets the limit. Add/edit blocks an unmatched range but does not enforce minimum cart value. Add-address success includes `data.deliveryLocation` with warehouse ID, zone ID, pincode, distance and selected band. Cart/checkout rechecks current pincodes and warehouse settings so older saved addresses cannot bypass deactivation. Put postal text in `location.address`. Deploy the controller and service together; no database migration is needed.

## Admin form fields

Warehouse create/update also accepts `warehouseName` and numeric `latitude`, `longitude` together. These are converted to the existing `coordinates: [longitude, latitude]`; old coordinate-array payloads remain supported. If both formats are sent, they must agree. Warehouse JSON responses include the saved name plus latitude/longitude aliases (null for an unset location). Existing warehouses do not need a new address when saving just name/location; creating a new warehouse still requires its postal address.

Distance configuration also accepts `deliveryChargesEnabled` (boolean, default true). When false, delivery fees are zero but minimum-order, configured service radius and the constant platform fee remain enforced. Omit the field on update to retain its existing value.

Each distance range accepts `minOrderMessage`. Empty/omitted uses the generated minimum-order message. Custom text can include `{minOrderValue}` and `{amountToAdd}`, substituted for the selected range and current cart. This message is used in cart and blocked checkout responses; it does not change the minimum-order rule. Prefer placeholders to hard-coded amounts.

The admin screen's From/To values must be KM (for example 0 and 2), not old order-amount values such as 1500 and 2999. Include a global platform fee input and an actual/roundUp selector in the UI. This repository supplies their backend support, not the admin UI itself.

The backend uses the active default warehouse's saved coordinates and the customer's delivery-address coordinates. Pincode decides eligibility through active admin zones; distance bands decide pricing. Existing driver assignments and historical order totals are preserved.

## Configure before rollout

This repository contains the backend, not the admin/mobile UI. Deploy the backend together with the following admin/app integration. No live database configuration has been written by this change. Until a global distance configuration and valid default warehouse coordinates are saved, new checkout is blocked with an explicit configuration error. Legacy pincode pricing is not used as a fallback.

### 1. Use the existing warehouse

Fetch `GET /api/v1/admin/warehouse/getAll` with the existing admin authentication. Find the active warehouse with `isDefault: true`.

Update `PUT /api/v1/admin/warehouse/update/<warehouseId>` with:

```js
{ coordinates: [warehouseLongitude, warehouseLatitude] }
```

The two values must be numbers, longitude first. Use the real map pin or device location at the warehouse. The existing address, phone and email remain unchanged when omitted. A new warehouse is not required. Creation also accepts `coordinates`.

The admin UI can offer “Use current location” or a movable map pin and save the resulting coordinates. Text addresses are not automatically geocoded. If the warehouse moves, save both the new address and its new coordinates. `PATCH /api/v1/admin/warehouse/setDefault/<warehouseId>` switches the origin to another existing warehouse. Each new cart/checkout request reads the latest default warehouse location.

### 2. Save distance bands and one platform fee

Use `POST /api/v1/admin/saveDeliveryConfig` with the complete payload below. The numbers are the user's example configuration; `platformFee: 5` is illustrative—replace it with the existing business platform fee.

```json
{
  "pricingMode": "distance",
  "distanceCalculationMode": "actual",
  "platformFee": 5,
  "distanceRanges": [
    { "distanceFrom": 0, "distanceTo": 2, "minOrderValue": 1500, "deliveryChargePerKm": 10, "freeDeliveryAbove": 3000 },
    { "distanceFrom": 2, "distanceTo": 4, "minOrderValue": 2000, "deliveryChargePerKm": 12, "freeDeliveryAbove": 4000 },
    { "distanceFrom": 4, "distanceTo": 6, "minOrderValue": 2500, "deliveryChargePerKm": 15, "freeDeliveryAbove": 5000 },
    { "distanceFrom": 6, "distanceTo": 10, "minOrderValue": 3000, "deliveryChargePerKm": 18, "freeDeliveryAbove": 6000 }
  ]
}
```

Fetch it with `GET /api/v1/admin/getDeliveryConfigByZone?pricingMode=distance` (no zone ID needed). There is one global distance configuration, so platform fee stays the same across all bands. Submit all fields when changing the configuration. Saving replaces the band list; remove a row from that list to remove a band. Historical zone configuration endpoints/data remain available but do not price new orders.

Validation rejects missing/non-numeric/negative values, gaps, overlaps, non-increasing bands, and free-delivery thresholds below the minimum order. Bands must start at zero and cover a continuous delivery radius.

## Calculation rules

- Current distance method: **straight-line great-circle distance (Haversine)** from coordinates, not driving-route distance. `distanceMethod` is `straightLine`. There is no Google Maps dependency or road-distance lookup.
- `actual`: distance × applicable per-KM rate, rounded to the nearest whole rupee. Example: 3.2 × 12 = ₹38.40 → ₹38.
- `roundUp`: ceil(distance) × applicable rate. Example: ceil(3.2) × 12 = ₹48.
- In both modes, round the final delivery fee once: below ₹0.50 rounds down; ₹0.50 and above rounds up (₹81.40 → ₹81, ₹81.50 → ₹82). Cart messages, checkout and payment totals use this rounded fee.
- The band always uses the unrounded distance. The lower band owns an exact shared boundary: 0–2 includes 2; 2–4 means greater than 2 and up to 4. Exactly 10 KM is allowed for the sample configuration; above 10 is not.
- Minimum and free-delivery thresholds use the server-calculated GST-inclusive product subtotal **before coupons**, excluding delivery/platform fees. Qualifying free gifts do not increase that subtotal.
- Below minimum: checkout blocked, including when a free-delivery coupon exists.
- At or above `freeDeliveryAbove`: delivery fee is zero. Otherwise the entire distance is charged at the selected band's rate (not progressive slab billing).
- Valid existing free-delivery coupons remain supported. Platform fee is still charged.
- Missing customer coordinates, missing warehouse configuration and out-of-range addresses block checkout; high cart value cannot override serviceability.

## Mobile/web app changes

1. Store map coordinates as `location.coordinates: [longitude, latitude]` and pincode as `location.pincode`. Add/edit requires an active admin-listed pincode and a matching warehouse-distance band.
2. Fetch `GET /api/v1/user/getCart?addressId=<selectedAddressId>` after address, quantity or coupon changes. If `addressId` is omitted, the saved selected/default address is used. Refresh before checkout if settings/location may have changed.
3. Replace the static ₹2999 banner with `data.freeDeliveryMessage`. Hide the banner when it is empty. `data.freeDeliveryAbove` is the selected threshold; do not derive it from old amount-based `deliveryRanges`.
4. Show `data.minOrderInfo.message`; disable checkout when `data.canPlaceOrder` is false. Display `data.deliveryCharge`, `data.platformFee` and `data.totalAmount` from the server.
5. `data.deliveryPricing` contains `distanceKm`, `billableDistanceKm`, `selectedDistanceRange`, `distanceRanges`, threshold, serviceability and error details. `deliveryRanges` in the signed-in cart is an alias of the new **distance** bands; update consumers expecting old `minAmount/maxAmount` rows.
6. Guest cart `POST /api/v1/user/guest/getCart` optionally takes `location.coordinates` alongside `items`, and returns the same distance fee/banner information. Without coordinates it returns a missing-location message and no threshold banner. Guest `canPlaceOrder` stays false because login is required.
7. COD `placeorder` and prepaid `payment/createOrder` use the actual checkout address and recalculate fees/minimum eligibility. Client `cartData.deliveryCharge` and `cartData.platformFee` do not control the price. Handle a 400 minimum/location/serviceability response by refreshing the cart and showing its message. Prepaid amount must come from the payment API response.

For a 3.5 KM address in the example configuration:

| Product subtotal | Delivery | Platform | Checkout |
| --- | --- | --- | --- |
| ₹1,900 | ₹42 quote | ₹5 | Blocked; add ₹100 |
| ₹2,500 | ₹42 | ₹5 | Allowed; payable ₹2,547 before coupons |
| ₹4,000 | ₹0 | ₹5 | Allowed; payable ₹4,005 before coupons |

New orders save `deliveryPricing` with the fee, range and warehouse coordinates used when the order was created. Updating the warehouse/configuration does not reprice existing orders or already-created prepaid payment orders.

## Verification

Run `node --test tests/cartPriceHelper.test.js tests/distanceDelivery.test.js`.

Tests cover requested examples, boundary distances, rounding mode, dynamic banners, fixed platform fee, invalid configuration/coordinates, warehouse-only coordinate updates, cart responses, coupon minimum enforcement, and COD/prepaid fee calculation with forged client fees. Controller/database/payment dependencies are mocked; live MongoDB, Razorpay and mobile UI require staging validation after configuration.
