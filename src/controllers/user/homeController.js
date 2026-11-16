const Banner = require("../../models/bannerModel");
const Product = require("../../models/productModel");
const Category = require("../../models/categorySubCategoryModel");
const Order = require("../../models/orderModel");
const HomeHeading = require("../../models/homeHeadingModel");
const {
  filterActiveVariations,
  filterProductsForUser,
} = require("../../utils/productVariationFilter");
const { responseHandler } = require("../../utils/responseHandler");
const { catchAsyncError } = require("../../utils/generateError");
const statusCode = require("../../utils/httpResponseCode");
const getPagination = require("../../utils/getPagination");
const mongoose = require("mongoose");
const { redisConnection } = require("../../config/redis");

// Only data shared by every user is cached. User-specific "buy again" data is
// still fetched live below, so the API response and its behaviour stay intact.
const HOME_SHARED_CACHE_KEY = "home:shared:v2";
const HOME_SHARED_CACHE_TTL_SECONDS = 60;

const getHomeSharedCache = async () => {
  if (redisConnection.status !== "ready") return null;

  try {
    const cachedData = await redisConnection.get(HOME_SHARED_CACHE_KEY);
    return cachedData ? JSON.parse(cachedData) : null;
  } catch (error) {
    console.error("Home cache read failed:", error.message);
    return null;
  }
};

const setHomeSharedCache = async (data) => {
  if (redisConnection.status !== "ready") return;

  try {
    await redisConnection.set(
      HOME_SHARED_CACHE_KEY,
      JSON.stringify(data),
      "EX",
      HOME_SHARED_CACHE_TTL_SECONDS
    );
  } catch (error) {
    console.error("Home cache write failed:", error.message);
  }
};

const getPopularPickProducts = async ({ skip = 0, limit = 10 } = {}) => {
  const activeCategories = await Category.find({ status: "Active" }).distinct("_id");
  const pipeline = [
    { $match: { status: "Delivered" } },
    { $unwind: "$items" },
    { $match: { "items.variationId": { $ne: null } } },
    {
      $group: {
        _id: { productId: "$items.productId", variationId: "$items.variationId" },
        totalSold: { $sum: "$items.quantity" }
      }
    },
    {
      $lookup: {
        from: "products",
        localField: "_id.productId",
        foreignField: "_id",
        as: "product"
      }
    },
    { $unwind: "$product" },
    { $match: { "product.isDeleted": { $ne: true }, "product.categoryId": { $in: activeCategories } } },
    {
      $addFields: {
        variation: {
          $arrayElemAt: [
            {
              $filter: {
                input: "$product.productVariations",
                as: "v",
                cond: {
  $and: [
    { $eq: ["$$v._id", "$_id.variationId"] },
    { $ne: ["$$v.isDeleted", true] } // ✅ ADD
  ]
}
              }
            },
            0
          ]
        }
      }
    },
    { $match: { variation: { $ne: null } } },
    { $match: { "variation.stockQuantity": { $gt: 0 } } },
    { $sort: { totalSold: -1 } },
    {
      $group: {
        _id: "$product._id",
        product: { $first: "$product" },
        variation: { $first: "$variation" },
        totalSold: { $sum: "$totalSold" },
        topVariationSold: { $first: "$totalSold" },
      }
    },
    { $sort: { totalSold: -1, topVariationSold: -1 } },
    { $skip: skip },
    { $limit: limit },
    {
      $project: {
        _id: "$_id",
        categoryId: "$product.categoryId",
        subcategoryId: "$product.subcategoryId",
        productName: "$product.productName",
        gst: "$product.gst",
        keywords: "$product.keywords",
        productVariations: ["$variation"],
        // totalSold: 1
      }
    }
  ];

  return Order.aggregate(pipeline);
};

exports.Home = catchAsyncError(async (req, res) => {
  const { page, limit } = req.query;
  const { skip, limitNum } = getPagination(page, limit);
  const now = new Date();

  const cachedSharedData = await getHomeSharedCache();
  let sharedHomeData = cachedSharedData;

  if (!sharedHomeData) {
  const activeCategoryIds = await Category.find({ status: "Active" }).distinct("_id");
  // --- Fetch banners & categories ---
  const allBanners = await Banner.find({
    status: "Active",
    startDate: { $lte: now },
    $or: [
      { endDate: { $exists: false } },
      { endDate: null },
      { endDate: { $gte: now } },
    ],
  }).populate("festivalPromotionId", "name");

  const bannersWithProducts = [];
  for (const banner of allBanners) {
    const hasLinkedProducts = await Product.exists({
      isDeleted: { $ne: true },
      categoryId: { $in: activeCategoryIds },
      "productVariations.bannerId": banner._id,
      "productVariations.bannerStatusPerSku": "Active",
      "productVariations.isDeleted": { $ne: true }
    });

    const hasSelectedVariations = Array.isArray(banner.selectedVariations) && banner.selectedVariations.length > 0;

    if (hasLinkedProducts || hasSelectedVariations) {
      bannersWithProducts.push(banner);
    } else {
      // Include active promotional banners even if no products are explicitly mapped
      bannersWithProducts.push(banner);
    }
  }

  const allCategories = await Category.find({ status: "Active" }).sort({ sortOrder: 1 });

  const categoriesWithProducts = [];
  for (const category of allCategories) {
    const subcategoriesWithProducts = [];

    const sortedSubCategories = category.subCategories
      .filter(sub => sub.status === "Active")
      .sort((a, b) => a.sortOrder - b.sortOrder);

    for (const subCategory of sortedSubCategories) {
      if (subCategory.status === "Active") {
        const hasProducts = await Product.exists({
          isDeleted: { $ne: true }, // ✅ ADD
          categoryId: category._id,
          subcategoryId: subCategory._id,
          productVariations: { $exists: true, $not: { $size: 0 } },
          "productVariations.isDeleted": { $ne: true } // ✅ ADD
        });

        if (hasProducts) {
          subcategoriesWithProducts.push(subCategory);
        }
      }
    }

    if (subcategoriesWithProducts.length > 0) {
      categoriesWithProducts.push({
        ...category.toObject(),
        subCategories: subcategoriesWithProducts
      });
    }
  }

  const popularPicks = await getPopularPickProducts({ skip: 0, limit: 10 });

  const allHeadings = await HomeHeading.find({ status: "Active" }).sort({ createdAt: -1 });
  const headingsWithProducts = [];

  for (const heading of allHeadings) {
    if (heading.productIds && heading.productIds.length > 0) {
      const productIds = heading.productIds.slice(0, 10);
      const products = await Product.find({
        _id: { $in: productIds },
        isDeleted: { $ne: true },
        categoryId: { $in: activeCategoryIds },
        productVariations: { $exists: true, $not: { $size: 0 } },
        "productVariations.isDeleted": { $ne: true }
      });

      if (products.length > 0) {
        headingsWithProducts.push({
          _id: heading._id,
          heading: heading.heading,
          products: filterProductsForUser(products),
        });
      }
    }
  }

  sharedHomeData = {
    banners: bannersWithProducts,
    categories: categoriesWithProducts,
    popularPicks,
    headings: headingsWithProducts,
  };

  // Cache failure must never affect the home API response.
  setHomeSharedCache(sharedHomeData);
  }

  // --- buyAgain ---
  let buyAgain = [];

  if (req.user?.id) {
    const deliveredOrders = await Order.find({
      userId: req.user.id,
      status: "Delivered"
    }).select("items").sort({ "tracking.deliveredAt": -1 }).limit(10);

    const productVariationPairs = deliveredOrders.flatMap(order =>
      order.items.map(item => ({
        productId: item.productId.toString(),
        variationId: item.variationId ? item.variationId.toString() : null
      }))
    );

    const uniquePairs = [];
    const seen = new Set();

    for (const p of productVariationPairs) {
      const key = `${p.productId}_${p.variationId}`;
      if (!seen.has(key)) {
        uniquePairs.push(p);
        seen.add(key);
      }
    }

    // ✅ FILTER DELETED PRODUCTS
    const products = await Product.find({
      _id: { $in: uniquePairs.map(p => p.productId) },
      isDeleted: { $ne: true },
      categoryId: { $in: await Category.find({ status: "Active" }).distinct("_id") }
    });

    buyAgain = products.map(product => {
      const orderedVariations = uniquePairs
        .filter(p => p.productId === product._id.toString())
        .map(p =>
          product.productVariations.find(v =>
            v._id.toString() === p.variationId &&
            !v.isDeleted // ✅ ADD
          )
        )
        .filter(v => v);

      if (orderedVariations.length === 0) return null;

      return {
        ...product.toObject(),
        productVariations: orderedVariations
      };
    }).filter(p => p !== null);
  }

  /* Headings are included in sharedHomeData above and served from cache.
  // --- Headings ---
  const allHeadings = await HomeHeading.find({ status: "Active" }).sort({ createdAt: -1 });
  const headingsWithProducts = [];

  for (const heading of allHeadings) {
    if (heading.productIds && heading.productIds.length > 0) {
      const productIds = heading.productIds.slice(0, 10);

      const products = await Product.find({
        _id: { $in: productIds },
        isDeleted: { $ne: true }, // ✅ ADD
        productVariations: { $exists: true, $not: { $size: 0 } },
        "productVariations.isDeleted": { $ne: true } // ✅ ADD
      });

      if (products.length > 0) {
        headingsWithProducts.push({
          _id: heading._id,
          heading: heading.heading,
          products: filterProductsForUser(products),
        });
      }
    }
  }

  */

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Home data fetched successfully",
    data: {
      banners: sharedHomeData.banners,
      categories: sharedHomeData.categories,
      popularPicks: sharedHomeData.popularPicks,
      buyAgain,
      headings: sharedHomeData.headings,
    },
  });
});

exports.seeAllBuyAgain = catchAsyncError(async (req, res) => {
  const { page = 1, limit = 10 } = req.query;
  const { skip, limitNum, pageNum } = getPagination(page, limit);

  if (!req.user?.id) {
    return responseHandler({
      res,
      code: statusCode.FORBIDDEN,
      message: "Login required to access Buy Again products.",
    });
  }

  // Get all delivered orders
  const deliveredOrders = await Order.find({
    userId: req.user.id,
    status: "Delivered"
  }).select("items").sort({ "tracking.deliveredAt": -1 });

  const productVariationPairs = deliveredOrders.flatMap(order =>
    order.items.map(item => ({
      productId: item.productId.toString(),
      variationId: item.variationId?.toString() || null
    }))
  );

  const seen = new Set();
  const uniquePairs = [];

  for (const item of productVariationPairs) {
    const key = `${item.productId}_${item.variationId}`;
    if (!seen.has(key)) {
      uniquePairs.push(item);
      seen.add(key);
    }
  }

  const productIds = uniquePairs.map(p => p.productId);

  // ✅ COUNT ONLY NON-DELETED PRODUCTS
  const totalProducts = await Product.countDocuments({
    _id: { $in: productIds },
    isDeleted: { $ne: true },
    categoryId: { $in: await Category.find({ status: "Active" }).distinct("_id") }
  });

  // ✅ FETCH ONLY NON-DELETED PRODUCTS
  const products = await Product.find({
    _id: { $in: productIds },
    isDeleted: { $ne: true },
    categoryId: { $in: await Category.find({ status: "Active" }).distinct("_id") }
  })
    .skip(skip)
    .limit(limitNum);

  // ✅ Attach filtered variations
  const finalProducts = products.map(product => {
    const orderedVariations = uniquePairs
      .filter(p => p.productId === product._id.toString())
      .map(p =>
        product.productVariations?.find(v =>
          v._id.toString() === p.variationId &&
          !v.isDeleted // ✅ ADD
        )
      )
      .filter(v => v); // remove null

    // ❌ REMOVE PRODUCT IF NO VALID VARIATION
    if (orderedVariations.length === 0) return null;

    return {
      ...product.toObject(),
      productVariations: orderedVariations
    };
  }).filter(p => p !== null); // ✅ clean null products

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Buy again products fetched successfully",
    data: {
      pagination: {
        totalItems: totalProducts,
        currentPage: pageNum,
        pageSize: limitNum,
        totalPages: Math.ceil(totalProducts / limitNum)
      },
      products: finalProducts
    }
  });
});

exports.seeAllPopularPicks = catchAsyncError(async (req, res) => {
  const { page = 1, limit = 10 } = req.query;
  const { skip, limitNum, pageNum } = getPagination(page, limit);

  const products = await getPopularPickProducts({ skip, limit: limitNum });

  // total distinct popular variations in stock
  const totalAgg = await Order.aggregate([
    { $match: { status: "Delivered" } },
    { $unwind: "$items" },
    { $match: { "items.variationId": { $ne: null } } },
    {
      $group: {
        _id: { productId: "$items.productId", variationId: "$items.variationId" },
        totalSold: { $sum: "$items.quantity" }
      }
    },
    {
      $lookup: {
        from: "products",
        localField: "_id.productId",
        foreignField: "_id",
        as: "product"
      }
    },
    { $unwind: "$product" },
    { $match: { "product.isDeleted": { $ne: true } } },
    {
      $addFields: {
        variation: {
          $arrayElemAt: [
            {
              $filter: {
                input: "$product.productVariations",
                as: "v",
                cond: {
  $and: [
    { $eq: ["$$v._id", "$_id.variationId"] },
    { $ne: ["$$v.isDeleted", true] }
  ]
}
              }
            },
            0
          ]
        }
      }
    },
    { $match: { variation: { $ne: null } } },
    { $match: { "variation.stockQuantity": { $gt: 0 } } },
    {
      $group: {
        _id: "$product._id",
      }
    },
    { $count: "total" }
  ]);

  const totalProducts = totalAgg[0]?.total || 0;

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Popular picks fetched successfully",
    data: {
      pagination: {
        totalItems: totalProducts,
        currentPage: pageNum,
        pageSize: limitNum,
        totalPages: Math.ceil(totalProducts / limitNum)
      },
      products
    }
  });
});

exports.viewParticularHeading = catchAsyncError(async (req, res) => {  
  const { homeHeadingId } = req.query;

  if (!homeHeadingId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Home heading ID is required"
    });
  }

  const result = await HomeHeading.aggregate([
    {
      $match: {
        _id: new mongoose.Types.ObjectId(homeHeadingId),
        status: "Active"
      }
    },
    {
      $lookup: {
        from: "products",
        let: { productIds: "$productIds" },
        pipeline: [
          {
            $match: {
              $expr: { $in: ["$_id", "$$productIds"] },
              isDeleted: { $ne: true } // ✅ PRODUCT SOFT DELETE FILTER
            }
          },
          {
            $addFields: {
              productVariations: {
                $filter: {
                  input: "$productVariations",
                  as: "v",
                  cond: {
                    $ne: ["$$v.isDeleted", true] // ✅ VARIATION SOFT DELETE FILTER
                  }
                }
              }
            }
          },
          {
            $match: {
              "productVariations.0": { $exists: true } // ✅ at least 1 valid variation
            }
          }
        ],
        as: "productIds"
      }
    }
  ]);

  const homeHeading = result[0];

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Home heading fetched successfully",
    data: homeHeading
  });
});
