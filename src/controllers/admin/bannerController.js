const Banner = require("../../models/bannerModel");
const Product = require("../../models/productModel")
const Festival = require("../../models/festivalModel");
const { catchAsyncError } = require("../../utils/generateError");
const { responseHandler } = require("../../utils/responseHandler");
const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");
const statusCode = require("../../utils/httpResponseCode");
const mongoose = require("mongoose");

const normalizeSelectedVariations = (selectedVariations = []) => {
  if (!Array.isArray(selectedVariations)) return [];

  const seen = new Set();
  return selectedVariations
    .filter(
      (sv) =>
        sv.productId &&
        sv.variationId &&
        mongoose.Types.ObjectId.isValid(sv.productId) &&
        mongoose.Types.ObjectId.isValid(sv.variationId)
    )
    .filter((sv) => {
      const key = `${sv.productId.toString()}::${sv.variationId.toString()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((sv) => ({
      productId: sv.productId,
      variationId: sv.variationId,
    }));
};

const validateSelectedVariations = async (selectedVariations = []) => {
  for (const sv of selectedVariations) {
    const product = await Product.findOne({ _id: sv.productId, isDeleted: { $ne: true } });
    if (!product) {
      return "Invalid product in selectedVariations";
    }

    const variation = product.productVariations.find(
      (v) => v._id.toString() === sv.variationId.toString() && v.isDeleted !== true
    );
    if (!variation) {
      return "Invalid variation in selectedVariations";
    }
  }

  return null;
};

const syncBannerVariations = async (bannerId, selectedVariations = []) => {
  const bannerObjectId = new mongoose.Types.ObjectId(bannerId);

  await Product.updateMany(
    { "productVariations.bannerId": bannerObjectId },
    {
      $set: {
        "productVariations.$[variation].bannerId": null,
        "productVariations.$[variation].bannerStatusPerSku": "Inactive",
      },
    },
    {
      arrayFilters: [{ "variation.bannerId": bannerObjectId }],
    }
  );

  if (!selectedVariations.length) return;

  await Promise.all(
    selectedVariations.map(async (sv) => {
      const productObjectId = new mongoose.Types.ObjectId(sv.productId);
      const variationObjectId = new mongoose.Types.ObjectId(sv.variationId);

      await Banner.updateMany(
        { _id: { $ne: bannerObjectId } },
        {
          $pull: {
            selectedVariations: {
              productId: productObjectId,
              variationId: variationObjectId,
            },
          },
        }
      );

      return Product.updateOne(
        {
          _id: productObjectId,
          isDeleted: { $ne: true },
          "productVariations._id": variationObjectId,
        },
        {
          $set: {
            "productVariations.$[variation].bannerId": bannerObjectId,
            "productVariations.$[variation].bannerStatusPerSku": "Active",
          },
        },
        {
          arrayFilters: [
            {
              "variation._id": variationObjectId,
              "variation.isDeleted": { $ne: true },
            },
          ],
        }
      );
    })
  );
};

exports.createFestival = catchAsyncError(async (req, res) => {
  const { name, description, category } = req.body;

  // Validation
  if (!name || !category) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Festival name and category are required",
    });
  }



  // Check duplicate festival by name
  const existing = await Festival.findOne({ name });
  if (existing) {
    return responseHandler({
      res,
      code: statusCode.CONFLICT,
      message: "Festival name already exists",
    });
  }
  const festival = await Festival.create({
    name,
    category,
    description,
  });

  return responseHandler({
    res,
    code: statusCode.CREATED,
    message: "Festival created successfully",
    data: festival,
  });
});
exports.getFestivals = catchAsyncError(async (req, res) => {
  const festivals = await Festival.find().sort({
    createdAt: -1,
  });

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Festivals fetched successfully",
    data: festivals,
  });
});
exports.createBanner = catchAsyncError(async (req, res) => {
  const {
    bannerImage,
    title,
    description,
    festivalPromotionId,
    status,
    startDate,
    endDate,
    selectedVariations,
  } = req.body;

  const normalizedSelectedVariations = normalizeSelectedVariations(selectedVariations);

  // Validate selectedVariations to ensure product and variation exist and are not deleted
  if (Array.isArray(selectedVariations) && normalizedSelectedVariations.length !== selectedVariations.length) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid selectedVariations",
    });
  }

  const validationError = await validateSelectedVariations(normalizedSelectedVariations);
  if (validationError) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: validationError,
    });
  }

  const banner = new Banner({
    bannerImage,
    title,
    description,
    festivalPromotionId,
    status,
    startDate,
    endDate,
    selectedVariations: normalizedSelectedVariations,
  });

  await banner.save();
  await syncBannerVariations(banner._id, normalizedSelectedVariations);

  return responseHandler({
    res,
    code: statusCode.CREATED,
    message: "Banner created successfully",
    data: banner,
  });
});
exports.getBanners = catchAsyncError(async (req, res) => {
  const {
    status,
    festivalPromotionId,
    fromDate,
    toDate,
  } = req.query;

  let filter = {};

  if (status && status !== "All") {
    filter.status = status;
  }


  if (festivalPromotionId && mongoose.Types.ObjectId.isValid(festivalPromotionId)) {
    filter.festivalPromotionId = festivalPromotionId;
  }


  if (fromDate || toDate) {
    const overlapClauses = [];

    if (fromDate && toDate) {
      const from = new Date(fromDate);
      from.setHours(0, 0, 0, 0);
      const to = new Date(toDate);
      to.setHours(23, 59, 59, 999);

      overlapClauses.push({
        startDate: { $lte: to },
        $or: [
          { endDate: { $exists: false } },
          { endDate: null },
          { endDate: { $gte: from } },
        ],
      });
    } else if (fromDate) {
      const from = new Date(fromDate);
      from.setHours(0, 0, 0, 0);
      overlapClauses.push({
        $or: [
          { endDate: { $exists: false } },
          { endDate: null },
          { endDate: { $gte: from } },
        ],
      });
    } else if (toDate) {
      const to = new Date(toDate);
      to.setHours(23, 59, 59, 999);
      overlapClauses.push({
        startDate: { $lte: to },
      });
    }

    if (overlapClauses.length > 0) {
      filter.$and = [...(filter.$and || []), ...overlapClauses];
    }
  }
  // Fetch banners with basic info
  const banners = await Banner.find(filter)
    .populate("festivalPromotionId", "name")
    .sort({ createdAt: -1 });

  // Populate each banner with detailed selected variations (product title and variation data)
  for (const banner of banners) {
    if (Array.isArray(banner.selectedVariations) && banner.selectedVariations.length) {
      const enriched = await Promise.all(
        banner.selectedVariations.map(async ({ productId, variationId }) => {
          const product = await Product.findOne({
            _id: productId,
            isDeleted: { $ne: true },
          })
            .select("productName productVariations")
            .lean();

          if (!product) return null;

          const variation = product.productVariations.find(
            (v) => v._id.toString() === variationId.toString() && v.isDeleted !== true
          );

          if (!variation) return null;

          return {
            productId,
            variationId,
            productTitle: product.productName,
            variation,
          };
        })
      );
      banner.selectedVariations = enriched.filter((v) => v);
    }
  }

  if (!banners || banners.length === 0) {
    return responseHandler({
      res,
      code: statusCode.SUCCESS,
      message: "No banners found",
      data: [],
    });
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Banners fetched successfully",
    data: banners,
  });
});

exports.deleteBanner = catchAsyncError(async (req, res) => {
  const { bannerId } = req.params;

  const s3 = new S3Client({
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
    region: process.env.AWS_REGION,
  });

  // Validate ObjectId
  if (!mongoose.Types.ObjectId.isValid(bannerId)) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid banner ID",
    });
  }

  // Find banner
  const banner = await Banner.findById(bannerId);

  if (!banner) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Banner not found",
    });
  }

  // Get image key from S3 URL
  const imageKey = banner.bannerImage
    ? banner.bannerImage.split(".amazonaws.com/")[1]
    : null;

  // Hard delete from DB
  await Banner.findByIdAndDelete(bannerId);
  await syncBannerVariations(bannerId, []);

  // Delete image from S3
  if (imageKey) {
    try {
      await s3.send(
        new DeleteObjectCommand({
          Bucket: process.env.AWS_BUCKET_NAME,
          Key: imageKey,
        })
      );
    } catch (error) {
      console.log("Error deleting banner image:", error.message);
      // API ko fail mat karo, DB delete priority hai
    }
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Banner deleted successfully",
  });
});
exports.editBanner = catchAsyncError(async (req, res) => {
  const { bannerId } = req.params;
  const updateData = req.body;

  const existingBanner = await Banner.findById(bannerId);
  if (!existingBanner) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Banner not found",
    });
  }

  if (Object.prototype.hasOwnProperty.call(updateData, "selectedVariations")) {
    const normalizedSelectedVariations = normalizeSelectedVariations(updateData.selectedVariations);

    if (
      Array.isArray(updateData.selectedVariations) &&
      normalizedSelectedVariations.length !== updateData.selectedVariations.length
    ) {
      return responseHandler({
        res,
        code: statusCode.DATAMISSING,
        message: "Invalid selectedVariations",
      });
    }

    const validationError = await validateSelectedVariations(normalizedSelectedVariations);
    if (validationError) {
      return responseHandler({
        res,
        code: statusCode.DATAMISSING,
        message: validationError,
      });
    }

    updateData.selectedVariations = normalizedSelectedVariations;
  }

  if (
    updateData.bannerImage &&
    updateData.bannerImage !== existingBanner.bannerImage
  ) {
    const s3 = new S3Client({
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
      region: process.env.AWS_REGION,
    });

    const oldImageKey = existingBanner.bannerImage
      ? existingBanner.bannerImage.split(".amazonaws.com/")[1]
      : null;

    if (oldImageKey) {
      try {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: oldImageKey,
          })
        );
        console.log("Old banner image deleted:", oldImageKey);
      } catch (err) {
        console.log("Error deleting old banner image:", err.message);
      }
    }
  }


  const banner = await Banner.findByIdAndUpdate(
    bannerId,
    { $set: updateData },
    { new: true, runValidators: true }
  );

  if (Object.prototype.hasOwnProperty.call(updateData, "selectedVariations")) {
    await syncBannerVariations(bannerId, updateData.selectedVariations);
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Banner updated successfully",
    data: banner,
  });
});
