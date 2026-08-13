const Product = require("../models/productModel");
const ItemService = require("../integrations/petpooja/services/itemService");

const buildStockStatus = (qty, minStock = 0) => {
  if (qty <= 0) return "outOfStock";
  if (qty < minStock) return "lowStock";
  return "inStock";
};

/**
 * Pull live stock from Petpooja for one variation and update admin DB when Petpooja is lower or different.
 */
const syncVariationStockFromPetpooja = async (product, variation) => {
  if (!variation?.petpoojaItemId) {
    throw new Error("Petpooja item ID missing for this variation.");
  }

  const petpoojaQty = await ItemService.getCurrentStock(variation.petpoojaItemId);
  if (petpoojaQty === null) {
    throw new Error("Unable to fetch live stock from Petpooja.");
  }

  const liveQty = Number(petpoojaQty);
  const localQty = Number(variation.stockQuantity || 0);
  // Checkout may lower local stock from Petpooja, but must never increase it.
  // Increasing here can overwrite stock already reserved by another concurrent order.
  if (liveQty < localQty) {
    variation.stockQuantity = liveQty;
    variation.stockStatus = buildStockStatus(liveQty, Number(variation.minStock || 0));
    await product.save();
  }

  return Math.min(liveQty, localQty);
};

/**
 * Validate cart stock: sync from Petpooja first, then check quantities.
 * Returns { ok: true } or { ok: false, stockIssues: [...] }
 */
const validateCartStockWithPetpooja = async (cartItems = []) => {
  const stockIssues = [];

  for (const item of cartItems) {
    const product = await Product.findById(item.productId);
    if (!product || product.isDeleted) {
      stockIssues.push({
        productId: item.productId,
        variationId: item.variationId,
        productName: "Product not available",
        requestedQuantity: item.quantity,
        availableQuantity: 0,
        message: "This product is no longer available.",
      });
      continue;
    }

    const variation = product.productVariations.id(item.variationId);
    if (!variation || variation.isDeleted) {
      stockIssues.push({
        productId: item.productId,
        variationId: item.variationId,
        productName: product.productName,
        requestedQuantity: item.quantity,
        availableQuantity: 0,
        message: "This product variant is no longer available.",
      });
      continue;
    }

    let availableQuantity = Number(variation.stockQuantity || 0);
    try {
      availableQuantity = await syncVariationStockFromPetpooja(product, variation);
    } catch (err) {
      stockIssues.push({
        productId: item.productId,
        variationId: item.variationId,
        productName: product.productName,
        requestedQuantity: item.quantity,
        availableQuantity,
        message: `${product.productName} stock could not be verified from Petpooja. Please try again.`,
        error: err.message,
      });
      continue;
    }

    if (item.quantity > availableQuantity) {
      stockIssues.push({
        productId: item.productId,
        variationId: item.variationId,
        productName: product.productName,
        requestedQuantity: item.quantity,
        availableQuantity,
        message:
          availableQuantity > 0
            ? `Only ${availableQuantity} item(s) available for ${product.productName}. Please update your cart quantity.`
            : `${product.productName} is currently out of stock. Please remove it from your cart.`,
      });
    }
  }

  if (stockIssues.length > 0) {
    return { ok: false, stockIssues };
  }
  return { ok: true };
};

const syncOrderItemsStockFromPetpooja = async (orderItems = []) => {
  for (const item of orderItems) {
    const product = await Product.findById(item.productId);
    if (!product) continue;
    const variation = product.productVariations.find(
      (v) => v._id.toString() === item.variationId.toString() && !v.isDeleted,
    );
    if (!variation) continue;
    await syncVariationStockFromPetpooja(product, variation);
  }
};

module.exports = {
  validateCartStockWithPetpooja,
  syncVariationStockFromPetpooja,
  syncOrderItemsStockFromPetpooja,
  buildStockStatus,
};
