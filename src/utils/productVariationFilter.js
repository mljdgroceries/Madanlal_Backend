const filterActiveVariations = (product) => {
  const obj =
    product && typeof product.toObject === "function"
      ? product.toObject()
      : { ...product };

  obj.productVariations = (obj.productVariations || []).filter(
    (v) => v && v.isDeleted !== true,
  );
  return obj;
};

const filterProductsForUser = (products = []) =>
  products
    .map(filterActiveVariations)
    .filter((p) => (p.productVariations || []).length > 0);

const filterBannerProducts = (products = [], selectedVariations = []) => {
  if (!Array.isArray(selectedVariations) || selectedVariations.length === 0) {
    return filterProductsForUser(products);
  }

  const selectedKeys = new Set(
    selectedVariations.map(
      (sv) => `${sv.productId?.toString?.() || sv.productId}::${sv.variationId?.toString?.() || sv.variationId}`,
    ),
  );

  return products
    .map((product) => {
      const obj = filterActiveVariations(product);
      obj.productVariations = (obj.productVariations || []).filter((v) =>
        selectedKeys.has(`${obj._id.toString()}::${v._id.toString()}`),
      );
      return obj;
    })
    .filter((p) => p.productVariations.length > 0);
};

const filterProductsByBannerVariation = (products = [], bannerId) => {
  const bannerIdStr = bannerId?.toString?.() || bannerId;

  return products
    .map((product) => {
      const obj = filterActiveVariations(product);
      obj.productVariations = (obj.productVariations || []).filter((v) => {
        const variationBannerId = v.bannerId?.toString?.() || v.bannerId;
        return variationBannerId === bannerIdStr && v.bannerStatusPerSku === "Active";
      });
      return obj;
    })
    .filter((p) => p.productVariations.length > 0);
};

module.exports = {
  filterActiveVariations,
  filterProductsForUser,
  filterBannerProducts,
  filterProductsByBannerVariation,
};
