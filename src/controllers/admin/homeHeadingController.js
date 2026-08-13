const HomeHeading = require("../../models/homeHeadingModel");
const Product = require("../../models/productModel");
const { catchAsyncError } = require("../../utils/generateError");
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");
const getPagination = require("../../utils/getPagination");
const mongoose = require("mongoose");

exports.createHomeHeading = catchAsyncError(async (req, res) => {
    const { heading, productIds } = req.body;
    if (!heading || !productIds || !Array.isArray(productIds)) {
        return responseHandler({
            res,
            code: statusCode.DATAMISSING,
            message: "Heading and productIds are required"
        });
    }
    // const homeHeading = await HomeHeading.create({ heading, productIds });
     // 🔴 Check valid ObjectIds
  const validObjectIds = productIds.filter((id) =>
    require("mongoose").Types.ObjectId.isValid(id)
  );

  if (validObjectIds.length !== productIds.length) {
    return responseHandler({
      res,
      code: statusCode.BADREQUEST,
      message: "Invalid productIds provided",
    });
  }

  // 🟢 Fetch only ACTIVE (not deleted) products
  const validProducts = await Product.find({
    _id: { $in: productIds },
    isDeleted: { $ne: true }, // ✅ IMPORTANT
  }).select("_id");

  // 🔴 Check if any product is deleted or not found
  if (validProducts.length !== productIds.length) {
    return responseHandler({
      res,
      code: statusCode.BADREQUEST,
      message: "Some products are deleted or not found",
    });
  }

  // 🟢 Remove duplicate IDs (optional but best practice)
  const uniqueProductIds = [...new Set(productIds)];

  // 🟢 Create Home Heading
  const homeHeading = await HomeHeading.create({
    heading,
    productIds: uniqueProductIds,
  });
    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Home heading created successfully",
        data: homeHeading,
    });
});
exports.getAllHomeHeading = catchAsyncError(async (req, res) => {
    const homeHeading = await HomeHeading.find();
    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Home heading fetched successfully",
        data: homeHeading,
    });
});

exports.getHomeHeadingById = catchAsyncError(async (req, res) => {
    const { homeHeadingId } = req.query;

    if (!homeHeadingId) {
        return responseHandler({
            res,
            code: statusCode.DATAMISSING,
            message: "Home heading ID is required",
        });
    }

    const result = await HomeHeading.aggregate([
        {
            $match: {
                _id: new mongoose.Types.ObjectId(homeHeadingId),
            },
        },

        // 1️⃣ products
        // {
        //     $lookup: {
        //         from: "products",
        //         localField: "productIds",
        //         foreignField: "_id",
        //         as: "productIds",
        //     },
        // },

        {
  $lookup: {
    from: "products",
    let: { productIds: "$productIds" },
    pipeline: [
      {
        $match: {
          $expr: { $in: ["$_id", "$$productIds"] },
          isDeleted: { $ne: true } // ✅ ADD THIS
        }
      }
    ],
    as: "productIds",
  },
},

        // 2️⃣ unwind products
        { $unwind: "$productIds" },

        // 3️⃣ category
        {
            $lookup: {
                from: "categories",
                localField: "productIds.categoryId",
                foreignField: "_id",
                as: "category",
            },
        },
        { $unwind: "$category" },

        // 4️⃣ subcategory from category.subCategories
        {
            $addFields: {
                subCategoryObj: {
                    $arrayElemAt: [
                        {
                            $filter: {
                                input: "$category.subCategories",
                                as: "sub",
                                cond: {
                                    $eq: ["$$sub._id", "$productIds.subcategoryId"],
                                },
                            },
                        },
                        0,
                    ],
                },
            },
        },

        // 5️⃣ reshape product
        {
            $addFields: {
                "productIds.categoryId": {
                    _id: "$category._id",
                    categoryName: "$category.categoryName",
                },
                "productIds.subcategoryId": {
                    _id: "$subCategoryObj._id",
                    subCategoryName: "$subCategoryObj.subCategoryName",
                },
            },
        },

        {
            $project: {
                category: 0,
                subCategoryObj: 0,
            },
        },

        {
            $group: {
                _id: "$_id",
                heading: { $first: "$heading" },
                productIds: { $push: "$productIds" },
                status: { $first: "$status" },
                createdAt: { $first: "$createdAt" },
                updatedAt: { $first: "$updatedAt" },
                __v: { $first: "$__v" },
                // productIds: { $push: "$productIds" },
            },
        },
    ]);

    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Home heading fetched successfully",
        data: result[0],
    });
});
exports.updateHomeHeading = catchAsyncError(async (req, res) => {
    const { homeHeadingId } = req.query;
    const { heading, productIds } = req.body;
    if (!homeHeadingId || !heading || !productIds || !Array.isArray(productIds)) {
        return responseHandler({
            res,
            code: statusCode.DATAMISSING,
            message: "Home heading ID, heading and productIds are required"
        });
    }
    // const homeHeading = await HomeHeading.findByIdAndUpdate(homeHeadingId, { heading, productIds }, { new: true });
      // 🔴 Validate heading id
  if (!mongoose.Types.ObjectId.isValid(homeHeadingId)) {
    return responseHandler({
      res,
      code: statusCode.BADREQUEST,
      message: "Invalid homeHeadingId",
    });
  }

  // 🔴 Validate productIds
  const validObjectIds = productIds.filter((id) =>
    mongoose.Types.ObjectId.isValid(id)
  );

  if (validObjectIds.length !== productIds.length) {
    return responseHandler({
      res,
      code: statusCode.BADREQUEST,
      message: "Invalid productIds provided",
    });
  }

  // 🟢 Check products exist & NOT deleted
  const validProducts = await Product.find({
    _id: { $in: productIds },
    isDeleted: { $ne: true }, // ✅ IMPORTANT
  }).select("_id");

  if (validProducts.length !== productIds.length) {
    return responseHandler({
      res,
      code: statusCode.BADREQUEST,
      message: "Some products are deleted or not found",
    });
  }

  // 🟢 Remove duplicates
  const uniqueProductIds = [...new Set(productIds)];

  // 🔴 Check heading exists
  const existingHeading = await HomeHeading.findById(homeHeadingId);
  if (!existingHeading) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Home heading not found",
    });
  }

  // 🟢 Update
  const homeHeading = await HomeHeading.findByIdAndUpdate(
    homeHeadingId,
    {
      $set: {
        heading,
        productIds: uniqueProductIds,
      },
    },
    { new: true }
  );
    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Home heading updated successfully",
        data: homeHeading,
    });
});
exports.deleteHomeHeading = catchAsyncError(async (req, res) => {
    const { homeHeadingId } = req.query;
    if (!homeHeadingId) {
        return responseHandler({
            res,
            code: statusCode.DATAMISSING,
            message: "Home heading ID is required"
        });
    }
    const homeHeading = await HomeHeading.findByIdAndDelete(homeHeadingId);
    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Home heading deleted successfully",
        data: homeHeading,
    });
});
exports.getAllProducts = catchAsyncError(async (req, res) => {
    const { search, page, limit } = req.query;
    const pagination = getPagination(page, limit);
    const { skip, limitNum } = pagination;
   const query = {
  isDeleted: { $ne: true } // ✅ ADD THIS
};
    if (search && search.trim() !== "") {
        query.productName = { $regex: search, $options: "i" };
    }
    const products = await Product.aggregate([
        { $match: query },

        {
            $lookup: {
                from: "categories",
                localField: "categoryId",
                foreignField: "_id",
                as: "category"
            }
        },
        { $unwind: "$category" },

        {
            $addFields: {
                subCategoryObj: {
                    $arrayElemAt: [
                        {
                            $filter: {
                                input: "$category.subCategories",
                                as: "sub",
                                cond: { $eq: ["$$sub._id", "$subcategoryId"] }
                            }
                        },
                        0
                    ]
                }
            }
        },

        {
            $addFields: {
                categoryId: {
                    _id: "$category._id",
                    categoryName: "$category.categoryName"
                },
                subcategoryId: {
                    _id: "$subCategoryObj._id",
                    subCategoryName: "$subCategoryObj.subCategoryName"
                }
            }
        },

        {
            $project: {
                category: 0,
                subCategoryObj: 0
            }
        },

        { $sort: { createdAt: -1 } },
        { $skip: skip },
        { $limit: limitNum }
    ]);
    // const products = await Product.find(query).populate("categoryId", "categoryName")
    // .populate("subcategoryId", "subCategoryName") .skip(skip).limit(limitNum).sort({ createdAt: -1 });
    const total = await Product.countDocuments(query);
    const totalPages = Math.ceil(total / limitNum);

    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Products fetched successfully",
        data: {
            products,
            total,
            totalPages,
            page: parseInt(page) || 1,
            limit: parseInt(limit) || 10,
        },
    });
});