const Category = require("../../models/categorySubCategoryModel");
const Product = require("../../models/productModel");
const Cart = require("../../models/cartModel");
const generateSKU = require("../../utils/skuGenerator");
const { catchAsyncError } = require("../../utils/generateError");
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");
const mongoose = require("mongoose");
const itemService = require("../../integrations/petpooja/services/itemService");

exports.createProduct = catchAsyncError(async (req, res) => {
  const { categoryId, subcategoryId, productName, gst, hsnCode, keywords, productVariations } =
    req.body;
  console.log("reqbody", req.body);
  if (
    !categoryId ||
    !subcategoryId ||
    !productName ||
    !productVariations ||
    !Array.isArray(productVariations)
  ) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "categoryId,subcategoryId,productName and productVariations are required",
    });
  }
  for (let i = 0; i < productVariations.length; i++) {
    const v = productVariations[i];
    if (v.minStock === undefined || v.minStock === null || v.minStock === "") {
      return responseHandler({
        res,
        code: statusCode.DATAMISSING,
        message: `minStock is required for variation at index ${i}`,
      });
    }
    if (Number(v.minStock) < 0) {
      return responseHandler({
        res,
        code: statusCode.DATAMISSING,
        message: `minStock cannot be negative (variation index ${i})`,
      });
    }
    if (v.stockQuantity === undefined || v.stockQuantity === null || v.stockQuantity === "") {
      return responseHandler({
        res,
        code: statusCode.DATAMISSING,
        message: `stockQuantity is required for variation at index ${i}`,
      });
    }
    if (Number(v.stockQuantity) < 0) {
      return responseHandler({
        res,
        code: statusCode.DATAMISSING,
        message: `stockQuantity cannot be negative (variation index ${i})`,
      });
    }
  }
  // Validate category & subcategory
  const categoryDoc = await Category.findById(categoryId);
  if (!categoryDoc) {
    return responseHandler({ res, code: statusCode.DATAMISSING, message: "Invalid category" });
  }

  const subCategoryDoc = categoryDoc.subCategories.find(
    (sc) => sc._id.toString() === subcategoryId,
  );
  if (!subCategoryDoc) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "subcategoryId does not belong to this categoryId",
    });
  }
  // Remove forbidden fields if someone passes them
  productVariations.forEach((variation) => {
    delete variation.bannerId;
    delete variation.bannerStatusPerSku;
  });

  // Generate SKU for each variation if not provided
  const processedVariations = productVariations.map((variation, index) => {
    const minStock = variation.minStock;
    const stockQty = variation.stockQuantity;

    let stockStatus = "inStock";
    if (stockQty === 0) {
      stockStatus = "outOfStock";
    } else if (stockQty < minStock) {
      stockStatus = "lowStock";
    }

    let sku = variation.sku;

    // Generate SKU if not provided
    if (!sku || sku.trim() === "") {
      sku = generateSKU(
        categoryDoc.categoryName,
        subCategoryDoc.subCategoryName,
        productName,
        variation.measurmentValue,
        variation.measurmentUnit,
        index,
      );
    }

    return {
      ...variation,
      sku,
      stockStatus,
      outOfStockCount: stockStatus === "outOfStock" ? 1 : 0,
      bannerStatusPerSku: "Inactive",
      bannerId: null,
      description: itemService.formatDescription(variation.description),
    };
  });

  const product = await Product.create({
    categoryId,
    subcategoryId,
    productName,
    gst,
    hsnCode,
    keywords: Array.isArray(keywords) ? keywords.map((k) => k.trim().toLowerCase()) : [],
    productVariations: processedVariations,
  });

  // --- SYNC TO PETPOOJA ---
  try {
    for (let variation of product.productVariations) {
      const petpoojaId = await itemService.createItem(product, variation);
      variation.petpoojaItemId = petpoojaId;
    }
    await product.save();
  } catch (petpoojaError) {
    console.error("[PETPOOJA] Product Sync Error:", petpoojaError.message);
    // We don'\''t fail the main request, but log it.
    // In a more robust system, we'\''d queue this for retry.
  }

  return responseHandler({
    res,
    code: statusCode.CREATED,
    message: "Product created successfully",
    data: product,
  });
});
exports.getAllProductVariations = catchAsyncError(async (req, res) => {
  const {
    categoryId,
    subCategoryId,
    stockStatus,
    bannerId,
    search,
    page = 1,
    limit = 10,
  } = req.query;

  const matchStage = {};

  // Filter by category
  if (categoryId) {
    matchStage.categoryId = new mongoose.Types.ObjectId(categoryId);
  }
  if (subCategoryId) {
    matchStage.subcategoryId = new mongoose.Types.ObjectId(subCategoryId);
  }

  // Filter by stockStatus
  if (stockStatus) {
    matchStage["productVariations.stockStatus"] = stockStatus;
  }

  // Filter by bannerId
  if (bannerId) {
    matchStage["productVariations.bannerId"] = new mongoose.Types.ObjectId(bannerId);
  }

  // Search by productName or sku
  if (search) {
    matchStage.$or = [
      { productName: { $regex: search, $options: "i" } },
      { "productVariations.sku": { $regex: search, $options: "i" } },
    ];
  }
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const aggregationResult = await Product.aggregate([
    // { $unwind: "$productVariations" }, // break array into individual documents

    {
      $match: {
        isDeleted: { $ne: true },
      },
    },

    // 🔥 STEP 2: UNWIND VARIATIONS
    {
      $unwind: "$productVariations",
    },

    // 🔥 STEP 3: VARIATION SOFT DELETE FILTER
    {
      $match: {
        "productVariations.isDeleted": { $ne: true },
      },
    },

    { $match: matchStage },
    {
      $lookup: {
        from: "categories", // collection name in MongoDB
        localField: "categoryId",
        foreignField: "_id",
        as: "categoryInfo",
      },
    },
    { $unwind: "$categoryInfo" },
    // ✅ Lookup banners
    {
      $lookup: {
        from: "banners",
        localField: "productVariations.bannerId",
        foreignField: "_id",
        as: "bannerInfo",
      },
    },
    {
      $unwind: {
        path: "$bannerInfo",
        preserveNullAndEmptyArrays: true, // keep products without banner
      },
    },
    // { $match: matchStage },
    // ✅ Add bannerName inside variation
    {
      $addFields: {
        "productVariations.bannerName": "$bannerInfo.title",
        "productVariations.hsnCode": "$hsnCode",
      },
    },
    { $sort: { "productVariations._id": -1 } },
    {
      $facet: {
        totalProducts: [{ $count: "count" }], // total matching variations
        data: [
          { $skip: skip },
          { $limit: parseInt(limit) },
          {
            $project: {
              // productId: "$_id",
              productName: 1,
              hsnCode: 1,
              categoryId: 1,
              categoryName: "$categoryInfo.categoryName",
              subcategoryId: 1,
              variation: "$productVariations",
            },
          },
        ],
      },
    },
  ]);
  const totalProducts = aggregationResult[0].totalProducts[0]
    ? aggregationResult[0].totalProducts[0].count
    : 0;

  const paginatedVariations = aggregationResult[0].data;
  const totalOnPage = paginatedVariations.length;
  const totalPages = Math.ceil(totalProducts / parseInt(limit));

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Product variations fetched successfully",
    data: {
      totalProducts,
      totalOnPage,
      totalPages,
      page: parseInt(page),
      limit: parseInt(limit),
      variations: paginatedVariations,
    },
  });
});
exports.getProductById = catchAsyncError(async (req, res) => {
  const { productId } = req.query;
  if (!mongoose.Types.ObjectId.isValid(productId)) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid product ID",
    });
  }
  const productData = await Product.aggregate([
    { $match: { _id: new mongoose.Types.ObjectId(productId), isDeleted: { $ne: true } } },
    {
      $addFields: {
        productVariations: {
          $filter: {
            input: "$productVariations",
            as: "variation",
            cond: { $ne: ["$$variation.isDeleted", true] },
          },
        },
      },
    },

    // Lookup subCategory name
    {
      $lookup: {
        from: "categories",
        let: { subCatId: "$subcategoryId" },
        pipeline: [
          { $unwind: "$subCategories" },
          { $match: { $expr: { $eq: ["$subCategories._id", "$$subCatId"] } } },
          { $project: { "subCategories.subCategoryName": 1 } },
        ],
        as: "subCategoryData",
      },
    },
    {
      $addFields: {
        subCategoryName: { $arrayElemAt: ["$subCategoryData.subCategories.subCategoryName", 0] },
      },
    },
    // Lookup category name
    {
      $lookup: {
        from: "categories",
        localField: "categoryId",
        foreignField: "_id",
        as: "categoryData",
      },
    },
    {
      $addFields: {
        categoryName: { $arrayElemAt: ["$categoryData.categoryName", 0] },
        description: { $arrayElemAt: ["$categoryData.description", 0] },
      },
    },

    // Lookup banner details for each productVariation.bannerId
    {
      $lookup: {
        from: "banners",
        localField: "productVariations.bannerId",
        foreignField: "_id",
        as: "bannerData",
      },
    },
    {
      $addFields: {
        productVariations: {
          $map: {
            input: "$productVariations",
            as: "variation",
            in: {
              $mergeObjects: [
                "$$variation",
                {
                  bannerTitle: {
                    $arrayElemAt: [
                      "$bannerData.title",
                      { $indexOfArray: ["$bannerData._id", "$$variation.bannerId"] },
                    ],
                  },
                },
              ],
            },
          },
        },
      },
    },

    {
      $project: {
        categoryData: 0,
        subCategoryData: 0,
        bannerData: 0,
      },
    },
  ]);
  const product = productData[0];

  const similarProducts = await Product.find({ categoryId: product.categoryId }).select(
    "productName categoryId subcategoryId productVariations",
  );

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Product fetched successfully",
    data: {
      ...product,
      similarProducts,
    },
  });
});

exports.getProductVariationById = catchAsyncError(async (req, res) => {
  const { variationId } = req.query;

  if (!mongoose.Types.ObjectId.isValid(variationId)) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid variation ID",
    });
  }
  const result = await Product.aggregate([
    { $unwind: "$productVariations" },

    // Match variation first
    {
      $match: {
        "productVariations._id": new mongoose.Types.ObjectId(variationId),
      },
    },
    // Lookup category (contains subCategories)
    {
      $lookup: {
        from: "categories",
        let: { catId: "$categoryId", subId: "$subcategoryId" },
        pipeline: [
          { $match: { $expr: { $eq: ["$_id", "$$catId"] } } },

          // pick only needed fields + filter correct subCategory
          {
            $project: {
              categoryName: 1,
              subCategory: {
                $filter: {
                  input: "$subCategories",
                  as: "sub",
                  cond: { $eq: ["$$sub._id", "$$subId"] },
                },
              },
            },
          },
        ],
        as: "categoryInfo",
      },
    },
    { $unwind: { path: "$categoryInfo", preserveNullAndEmptyArrays: true } },

    // Lookup banner
    {
      $lookup: {
        from: "banners",
        let: { bId: "$productVariations.bannerId" },
        pipeline: [{ $match: { $expr: { $eq: ["$_id", "$$bId"] } } }, { $project: { title: 1 } }],
        as: "bannerInfo",
      },
    },
    { $unwind: { path: "$bannerInfo", preserveNullAndEmptyArrays: true } },

    // Final projection
    {
      $project: {
        productName: 1,
        gst: 1,
        hsnCode: 1,
        categoryId: 1,
        categoryName: "$categoryInfo.categoryName",
        subcategoryId: 1,
        subcategoryName: { $arrayElemAt: ["$categoryInfo.subCategory.subCategoryName", 0] },

        // Keep variation object as is, just add bannerName in it
        variation: {
          $mergeObjects: [
            "$productVariations",
            { bannerName: "$bannerInfo.title" }, // add bannerName into variation
          ],
        },
        // variation: "$productVariations",
        // bannerId: "$productVariations.bannerId",
        // bannerName: "$bannerInfo.bannerName"
      },
      // $project: {
      //     _id: 1,
      //     productName: 1,
      //     categoryId: 1,
      //     categoryName: "$categoryInfo.categoryName",
      //     subcategoryId: 1,
      //     subcategoryName: { $arrayElemAt: ["$categoryInfo.subCategory.subCategoryName", 0] },
      //     gst: 1,
      //     variation: {
      //         _id: "$productVariations._id",       // put _id first
      //         productType: "$productVariations.productType",
      //         measurmentUnit: "$productVariations.measurmentUnit",
      //         measurmentValue: "$productVariations.measurmentValue",
      //         stockStatus: "$productVariations.stockStatus",
      //         stockQuantity: "$productVariations.stockQuantity",
      //         mrp: "$productVariations.mrp",
      //         sellingPrice: "$productVariations.sellingPrice",
      //         discountPercent: "$productVariations.discountPercent",
      //         sku: "$productVariations.sku",
      //         productImages: "$productVariations.productImages",
      //         description: "$productVariations.description",
      //         bannerId: "$productVariations.bannerId",
      //         bannerName: "$bannerInfo.title",
      //         bannerStatusPerSku: "$productVariations.bannerStatusPerSku"
      //     }
      // }
    },
  ]);

  if (result.length === 0) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Product variation not found",
    });
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Product variation fetched successfully",
    data: result[0],
  });
});

exports.deleteProductVariation = catchAsyncError(async (req, res) => {
  const { productId, variationId } = req.query;
  const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");

  const s3 = new S3Client({
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
    region: process.env.AWS_REGION,
  });

  if (
    !mongoose.Types.ObjectId.isValid(productId) ||
    !mongoose.Types.ObjectId.isValid(variationId)
  ) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid product or variation ID",
    });
  }

  const product = await Product.findById(productId);
  if (!product) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Product not found",
    });
  }

  const variation = product.productVariations.id(variationId);
  if (!variation) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Variation not found",
    });
  }

  // Admin deletion is local-only. The linked Petpooja item remains unchanged.

  // 🔥 CASE 1: LAST VARIATION → SOFT DELETE PRODUCT
  if (product.productVariations.length === 1) {
    await Product.findByIdAndDelete(productId);
    await Cart.updateMany(
      { "items.productId": product._id },
      { $pull: { items: { productId: product._id } } },
    );

    return responseHandler({
      res,
      code: statusCode.SUCCESS,
      message: "Last variation deleted and product hard deleted successfully",
    });
  }

  // 🔥 CASE 2: NORMAL VARIATION DELETE (SOFT)
  product.productVariations.pull(variationId);
  await product.save();
  await Cart.updateMany(
    { "items.productId": product._id, "items.variationId": variation._id },
    { $pull: { items: { productId: product._id, variationId: variation._id } } },
  );

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Product variation hard deleted successfully",
  });
});

exports.updateProductAndVariations = catchAsyncError(async (req, res) => {
  const { productId } = req.query;
  const updatedData = req.body;
  // Payload size guard – reject requests larger than 4 MiB
  const MAX_PAYLOAD = 4 * 1024 * 1024; // 4 MiB
  const payloadSize = Buffer.byteLength(JSON.stringify(updatedData), 'utf8');
  if (payloadSize > MAX_PAYLOAD) {
    return responseHandler({
      res,
      code: 413,
      message: 'Payload too large',
    });
  }
  const { productVariations } = updatedData;
  const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");

  const s3 = new S3Client({
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
    region: process.env.AWS_REGION,
  });

  if (!mongoose.Types.ObjectId.isValid(productId)) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid product ID",
    });
  }

  // Fetch the existing product
  let product = await Product.findById(productId);
  if (!product) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Product not found",
    });
  }

  // --- Step A: Process Top-Level Product Updates ---
  const topLevelUpdates = { ...updatedData };
  delete topLevelUpdates.productVariations;

  if (Array.isArray(topLevelUpdates.keywords)) {
    topLevelUpdates.keywords = topLevelUpdates.keywords.map((k) => k.trim().toLowerCase());
  }

  // Execute top-level updates
  if (Object.keys(topLevelUpdates).length > 0) {
    product = await Product.findByIdAndUpdate(
      productId,
      { $set: topLevelUpdates },
      { new: true, runValidators: true },
    );
  }
  // Stock sync for variations is now handled later in the update flow (Step D) where each variation is processed.

  // --- Step B: Separate Existing and New Variations ---
  if (!Array.isArray(productVariations)) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "productVariations array is required",
    });
  }
  for (let i = 0; i < productVariations.length; i++) {
    const v = productVariations[i];

    if (v.minStock === undefined || v.minStock === null || v.minStock === "") {
      return responseHandler({
        res,
        code: statusCode.DATAMISSING,
        message: `minStock is required for variation at index ${i}`,
      });
    }
    if (Number(v.minStock) < 0) {
      return responseHandler({
        res,
        code: statusCode.DATAMISSING,
        message: `minStock cannot be negative (variation index ${i})`,
      });
    }

    if (v.stockQuantity === undefined || v.stockQuantity === null || v.stockQuantity === "") {
      return responseHandler({
        res,
        code: statusCode.DATAMISSING,
        message: `stockQuantity is required for variation at index ${i}`,
      });
    }
    if (Number(v.stockQuantity) < 0) {
      return responseHandler({
        res,
        code: statusCode.DATAMISSING,
        message: `stockQuantity cannot be negative (variation index ${i})`,
      });
    }
  }

  const existingVariations = productVariations.filter(
    (v) => v.sku && v.sku.trim() !== "" && product.productVariations.some((pv) => pv.sku === v.sku),
  );
  let newVariations = productVariations.filter(
    (v) =>
      !v.sku || v.sku.trim() === "" || !product.productVariations.some((pv) => pv.sku === v.sku),
  );

  // --- Step C: Handle New Variations ---
  if (newVariations.length > 0) {
    const currentCategoryId = updatedData.categoryId;
    const currentSubcategoryId = updatedData.subcategoryId;
    const currentProductName = updatedData.productName;

    if (!currentCategoryId || !currentSubcategoryId || !currentProductName) {
      return responseHandler({
        res,
        code: statusCode.DATAMISSING,
        message:
          "Category ID, Subcategory ID, and Product Name are required in the payload when adding a new variation.",
      });
    }

    const categoryDoc = await Category.findById(currentCategoryId);
    if (!categoryDoc) {
      return responseHandler({ res, code: statusCode.DATAMISSING, message: "Invalid category" });
    }

    const subCategoryDoc = categoryDoc.subCategories.find(
      (sc) => sc._id.toString() === currentSubcategoryId,
    );
    if (!subCategoryDoc) {
      return responseHandler({ res, code: statusCode.DATAMISSING, message: "Invalid subcategory" });
    }

    const initialCount = product.productVariations.length;

    newVariations = newVariations.map((variation, index) => {
      const stockQty = variation.stockQuantity;
      const minStock = variation.minStock;

      let stockStatus = "inStock";
      if (stockQty === 0) stockStatus = "outOfStock";
      else if (stockQty < minStock) stockStatus = "lowStock";

      const newSku = generateSKU(
        categoryDoc.categoryName,
        subCategoryDoc.subCategoryName,
        currentProductName,
        variation.measurmentValue,
        variation.measurmentUnit,
        initialCount + index,
      );

      return {
        ...variation,
        sku: newSku,
        stockStatus,
        outOfStockCount: stockStatus === "outOfStock" ? 1 : 0,
        bannerStatusPerSku: "Inactive",
        bannerId: null,
      };
    });

    await Product.findByIdAndUpdate(productId, {
      $push: { productVariations: { $each: newVariations } },
    });

    // --- SYNC NEW VARIATIONS TO PETPOOJA ---
    try {
      const updatedProduct = await Product.findById(productId);
      const addedVariations = updatedProduct.productVariations.slice(-newVariations.length);
      for (let variation of addedVariations) {
        const petpoojaId = await itemService.createItem(updatedProduct, variation);
        variation.petpoojaItemId = petpoojaId;
      }
      await updatedProduct.save();
    } catch (petpoojaError) {
      console.error("[PETPOOJA] New Variations Sync Error:", petpoojaError.message);
    }
  }

  // --- Step D: Handle Existing Variations (Image replace + Bulk update) ---
  if (existingVariations.length > 0) {
    const bulkOps = [];

    for (const u of existingVariations) {
      const oldVariation = product.productVariations.find((v) => v.sku === u.sku);

      if (oldVariation && u.productImages) {
        // 1. Delete old images from S3 if replaced
        const oldImages = oldVariation.productImages || [];
        const newImages = u.productImages || [];

        const imagesToDelete = oldImages.filter((img) => !newImages.includes(img));

        for (const img of imagesToDelete) {
          // Check if this image is being used by ANY other variation (existing or new)
          const isImageUsedElsewhere =
            product.productVariations.some(
              (v) =>
                v.sku !== u.sku && !v.isDeleted && v.productImages && v.productImages.includes(img),
            ) || newVariations.some((v) => v.productImages && v.productImages.includes(img));

          if (!isImageUsedElsewhere) {
            const imageKey = img.includes(".amazonaws.com/")
              ? img.split(".amazonaws.com/")[1]
              : null;
            if (imageKey) {
              try {
                await s3.send(
                  new DeleteObjectCommand({
                    Bucket: process.env.AWS_BUCKET_NAME,
                    Key: imageKey,
                  }),
                );
                console.log("Deleted from S3:", imageKey);
              } catch (err) {
                console.log("Error deleting old variation image:", err.message);
              }
            }
          }
        }
      }

      const stockQty = u.stockQuantity;
      const minStock = u.minStock;

      let stockStatus = "inStock";
      if (stockQty === 0) stockStatus = "outOfStock";
      else if (stockQty < minStock) stockStatus = "lowStock";

      const shouldIncOutOfStockCount =
        oldVariation && oldVariation.stockStatus !== "outOfStock" && stockStatus === "outOfStock";

      // Existing variation updates are local-only. Petpooja remains unchanged.

      const updateDoc = {
        $set: {
          "productVariations.$.productType": u.productType,
          "productVariations.$.measurmentUnit": u.measurmentUnit,
          "productVariations.$.measurmentValue": u.measurmentValue,
          "productVariations.$.stockStatus": stockStatus,
          "productVariations.$.stockQuantity": u.stockQuantity,
          "productVariations.$.minStock": u.minStock,
          "productVariations.$.mrp": u.mrp,
          "productVariations.$.sellingPrice": u.sellingPrice,
          "productVariations.$.discountPercent": u.discountPercent,
          "productVariations.$.productImages": u.productImages,
          "productVariations.$.description": u.description,
          "productVariations.$.bannerId": u.bannerId || null,
          "productVariations.$.bannerStatusPerSku":
            u.bannerStatusPerSku === "Active" ? "Active" : "Inactive",
          "productVariations.$.petpoojaItemId":
            u.petpoojaItemId || (oldVariation ? oldVariation.petpoojaItemId : null),
          "productVariations.$.isDeleted": false,
          "productVariations.$.deletedAt": null,
        },
      };

      if (shouldIncOutOfStockCount) {
        updateDoc.$inc = { "productVariations.$.outOfStockCount": 1 };
      }

      // 2. Prepare bulk operation
      bulkOps.push({
        updateOne: {
          filter: { _id: productId, "productVariations.sku": u.sku },
          update: updateDoc,
        },
      });
    }

    // Run all updates in bulk
    if (bulkOps.length > 0) {
      await Product.bulkWrite(bulkOps);
    }
  }

  // --- Step E: Final Response ---
  const updatedProduct = await Product.findById(productId);

  // Sync existing variation details (including product name and prices) to Petpooja.
  // Keep the local update successful even if Petpooja is temporarily unavailable.
  if (existingVariations.length > 0) {
    for (const existingVariation of existingVariations) {
      const updatedVariation = updatedProduct.productVariations.find(
        (variation) => variation.sku === existingVariation.sku,
      );

      if (!updatedVariation?.petpoojaItemId) {
        console.warn(
          `[PETPOOJA] Skipping existing variation sync because Petpooja item ID is missing for SKU ${existingVariation.sku}`,
        );
        continue;
      }

      try {
        await itemService.updateItem(
          updatedVariation.petpoojaItemId,
          updatedProduct,
          updatedVariation,
        );
      } catch (petpoojaError) {
        console.error(
          `[PETPOOJA] Existing variation sync error for SKU ${existingVariation.sku}:`,
          petpoojaError.message,
        );
      }
    }
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Product and variations updated successfully",
    data: updatedProduct,
  });
});
exports.getAllLowStockProductVariations = catchAsyncError(async (req, res) => {
  const aggregationResult = await Product.aggregate([
    { $unwind: "$productVariations" },
    {
      $facet: {
        totalVariations: [{ $count: "count" }],
        lowStockCount: [
          { $match: { "productVariations.stockStatus": "lowStock" } },
          { $count: "count" },
        ],
        outOfStockCount: [
          { $match: { "productVariations.stockStatus": "outOfStock" } },
          { $count: "count" },
        ],
        totalStockValue: [
          {
            $project: {
              stockValue: {
                $multiply: ["$productVariations.stockQuantity", "$productVariations.sellingPrice"],
              },
            },
          },
          {
            $group: {
              _id: null,
              totalStockValue: { $sum: "$stockValue" },
            },
          },
        ],
        lowStockVariations: [
          { $match: { "productVariations.stockStatus": "lowStock" } },
          {
            $lookup: {
              from: "categories",
              localField: "categoryId",
              foreignField: "_id",
              as: "categoryInfo",
            },
          },
          {
            $unwind: {
              path: "$categoryInfo",
              preserveNullAndEmptyArrays: true,
            },
          },
          {
            $project: {
              productName: 1,
              categoryId: 1,
              categoryName: "$categoryInfo.categoryName",
              subcategoryId: 1,
              createdAt: 1,
              variation: "$productVariations",
            },
          },
        ],
      },
    },
  ]);

  const result = aggregationResult[0];

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Low stock product variations fetched successfully",
    data: {
      totalVariations: result.totalVariations[0]?.count || 0,
      lowStockCount: result.lowStockCount[0]?.count || 0,
      outOfStockCount: result.outOfStockCount[0]?.count || 0,
      totalStockValue: result.totalStockValue[0]?.totalStockValue || 0,
      variations: result.lowStockVariations,
    },
  });
});
exports.restockparticularvariation = catchAsyncError(async (req, res) => {
  const { productId, variationId, stockQuantity } = req.body;

  if (!productId || !variationId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "productId and variationId required",
    });
  }

  const product = await Product.findById(productId);
  if (!product) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Product not found",
    });
  }

  const variation = product.productVariations.id(variationId);
  if (!variation) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Variation not found",
    });
  }

  const previousStatus = variation.stockStatus;
  const targetQuantity = Number(stockQuantity);
  if (!Number.isFinite(targetQuantity) || targetQuantity < 0) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Valid stockQuantity is required",
    });
  }

  variation.stockQuantity = targetQuantity;
  variation.lastRestockedAt = new Date();

  const minStock = variation.minStock;

  if (variation.stockQuantity === 0) {
    variation.stockStatus = "outOfStock";
  } else if (variation.stockQuantity < minStock) {
    variation.stockStatus = "lowStock";
  } else {
    variation.stockStatus = "inStock";
  }

  if (previousStatus !== "outOfStock" && variation.stockStatus === "outOfStock") {
    variation.outOfStockCount = (variation.outOfStockCount || 0) + 1;
  }

  // Admin stock updates are local-only. Petpooja stock remains unchanged.

  await product.save();

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Variation restocked successfully",
    data: product,
  });
});
