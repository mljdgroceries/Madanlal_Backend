// sellingPrice and cart.price are both GST-inclusive. Never reprice saved orders.
const getVariationPrice = (variation) => {
  const value = variation?.sellingPrice;
  const price = Number(value);
  if (value === null || value === undefined || value === "" || !Number.isFinite(price) || price < 0) {
    throw new Error("Product price is unavailable. Please refresh your cart and try again.");
  }
  return price;
};

const refreshCartPrices = (items, products) => {
  // Validate every item before mutating the cart.
  const updates = items.map((item) => {
    const product = products.find((p) => String(p._id) === String(item.productId));
    const variation = product?.productVariations?.find((v) => String(v._id) === String(item.variationId));
    if (!product || product.isDeleted || !variation || variation.isDeleted) {
      throw new Error("A product is no longer available. Please refresh your cart and try again.");
    }
    return { item, price: getVariationPrice(variation) };
  });
  const priceChanges = [];
  for (const { item, price } of updates) {
    if (Number(item.price) !== price) {
      priceChanges.push({ productId: item.productId, variationId: item.variationId, oldPrice: item.price, newPrice: price });
    }
    item.price = price;
    item.totalPrice = price * Number(item.quantity);
  }
  return priceChanges;
};

const checkoutPriceReview = (items, priceChanges, cartData) => {
  const cartValue = Number(items.reduce((sum, item) => sum + item.price * Number(item.quantity), 0).toFixed(2));
  const submittedValue = cartData?.cartValue;
  const totalChanged = submittedValue !== undefined && submittedValue !== null &&
    (!Number.isFinite(Number(submittedValue)) || Math.round(Number(submittedValue) * 100) !== Math.round(cartValue * 100));
  if (!priceChanges.length && !totalChanged) return null;
  return { errorType: "CART_PRICE_CHANGED", priceChanges, cartValue };
};

module.exports = { getVariationPrice, refreshCartPrices, checkoutPriceReview };
