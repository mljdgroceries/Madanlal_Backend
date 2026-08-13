const Product = require("../models/productModel");

const getStockStatus = (quantity, minStock = 0) => {
  if (quantity <= 0) return "outOfStock";
  if (quantity <= minStock) return "lowStock";
  return "inStock";
};

const updateVariationStatus = async (product, variationId, isRestock = false) => {
  const variation = product?.productVariations?.find(
    (entry) => entry._id.toString() === variationId.toString(),
  );
  if (!variation) return;

  const nextStatus = getStockStatus(
    Number(variation.stockQuantity || 0),
    Number(variation.minStock || 0),
  );
  const update = {
    $set: {
      "productVariations.$.stockStatus": nextStatus,
    },
  };
  if (isRestock) {
    update.$set["productVariations.$.lastRestockedAt"] = new Date();
  } else if (variation.stockStatus !== "outOfStock" && nextStatus === "outOfStock") {
    update.$inc = { "productVariations.$.outOfStockCount": 1 };
  }

  await Product.updateOne(
    { _id: product._id, "productVariations._id": variationId },
    update,
  );
};

const restoreOrderItemsStock = async (items = []) => {
  for (const item of items) {
    const quantity = Number(item.quantity || 0);
    if (quantity <= 0) continue;

    const product = await Product.findOneAndUpdate(
      {
        _id: item.productId?._id || item.productId,
        "productVariations._id": item.variationId,
      },
      { $inc: { "productVariations.$.stockQuantity": quantity } },
      { new: true },
    );

    if (product) {
      await updateVariationStatus(product, item.variationId, true);
    }
  }
};

const reserveOrderItemsStock = async (items = []) => {
  const reservedItems = [];

  try {
    for (const item of items) {
      const quantity = Number(item.quantity || 0);
      if (quantity <= 0) continue;

      const product = await Product.findOneAndUpdate(
        {
          _id: item.productId?._id || item.productId,
          isDeleted: { $ne: true },
          productVariations: {
            $elemMatch: {
              _id: item.variationId,
              isDeleted: { $ne: true },
              stockQuantity: { $gte: quantity },
            },
          },
        },
        { $inc: { "productVariations.$.stockQuantity": -quantity } },
        { new: true },
      );

      if (!product) {
        const error = new Error("Requested quantity is no longer available.");
        error.code = "INSUFFICIENT_STOCK";
        throw error;
      }

      reservedItems.push({
        productId: item.productId?._id || item.productId,
        variationId: item.variationId,
        quantity,
      });
      await updateVariationStatus(product, item.variationId);
    }

    return true;
  } catch (error) {
    await restoreOrderItemsStock(reservedItems);
    throw error;
  }
};

module.exports = {
  reserveOrderItemsStock,
  restoreOrderItemsStock,
};
