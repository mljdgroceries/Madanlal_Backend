const categoryModel = require("../../models/categorySubCategoryModel");
const productModel = require("../../models/productModel");
const { catchAsyncError } = require("../../utils/generateError");
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");
const {
  generateCategoryCodeFromName,
  generateSubCategoryCode,
} = require("../../utils/categoryCodeGeneration");
const mongoose = require("mongoose");

// Create Category
exports.createCategory = catchAsyncError(async (req, res) => {
  const {
    categoryName,
    description,
    categoryImage,
    subCategories,
  } = req.body;

  if (!categoryName || categoryName.trim() === "") {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Category name is required",
    });
  }

  // As per required format: category code should be same as category name.
  const finalCategoryCode = generateCategoryCodeFromName(categoryName);
  console.log("finalCategoryCode", finalCategoryCode);
  // Check for duplicate category name
  const existingCategoryByName = await categoryModel.findOne({
    categoryName: { $regex: new RegExp(`^${categoryName}$`, "i") },
  });
  if (existingCategoryByName) {
    return responseHandler({
      res,
      code: statusCode.CONFLICT,
      message: "Category with this name already exists",
    });
  }
  // Check for duplicate category code
  const existingCategoryCode = await categoryModel.findOne({
    categoryCode: finalCategoryCode,
  });
  console.log("existingCategoryCode", existingCategoryCode);
  if (existingCategoryCode) {
    return responseHandler({
      res,
      code: statusCode.CONFLICT,
      message: "Category with this code already exists",
    });
  }
  if (subCategories && subCategories.length > 0) {
    // Check for duplicate subcategory names within the same category
    const subCategoryNames = subCategories.map((sub) => sub.subCategoryName);
    const duplicateSubNames = subCategoryNames.filter(
      (name, index) => subCategoryNames.indexOf(name) !== index,
    );
    if (duplicateSubNames.length > 0) {
      return responseHandler({
        res,
        code: statusCode.CONFLICT,
        message: `Duplicate subcategory names found: ${duplicateSubNames.join(", ")}`,
      });
    }
  }
  const lastCategory = await categoryModel.findOne({}).sort({ sortOrder: -1 });
  const nextSortOrder = lastCategory ? lastCategory.sortOrder + 1 : 1;

  let processedSubCategories = [];
  if (subCategories && subCategories.length > 0) {
    let subCounter = 1; // local counter reset for each category
    // Process subcategories and generate codes for them
    for (let i = 0; i < subCategories.length; i++) {
      const sub = subCategories[i];
      if (!sub.subCategoryName || sub.subCategoryName.trim() === "") {
        return responseHandler({
          res,
          code: statusCode.DATAMISSING,
          message: `SubCategory name is required for subcategory at index ${i}`,
        });
      }

      const subCategoryCode = generateSubCategoryCode(
        categoryName,
        sub.subCategoryName,
      );
      subCounter++;
      processedSubCategories.push({
        ...sub,
        subCategoryCode,
        sortOrder: sub.sortOrder || i + 1,
      });
    }
  }

  const categoryData = {
    categoryName,
    categoryCode: finalCategoryCode,
    sortOrder: nextSortOrder,
    description,
    categoryImage,
    subCategories: processedSubCategories,
  };

  const category = await categoryModel.create(categoryData);

  return responseHandler({
    res,
    code: statusCode.CREATED,
    message: "Category created successfully",
    data: category,
  });
});
//reorder categories
exports.reorderCategories = catchAsyncError(async (req, res) => {
  const { orderedIds } = req.body;

  if (!orderedIds || !Array.isArray(orderedIds)) {
    return res.status(400).json({
      code: 400,
      message: "orderedIds must be an array of category IDs",
    });
  }

  // 1. Get current categories sorted by sortOrder
  const categories = await categoryModel.find({}).sort({ sortOrder: 1 });

  // 2. Old mapping of sortOrder
  const oldMap = {};
  categories.forEach((cat) => {
    oldMap[cat._id.toString()] = cat.sortOrder;
  });

  // 3. Prepare bulk update ops (only for changed items)
  const ops = [];
  orderedIds.forEach((id, index) => {
    const newSort = index + 1;
    const oldSort = oldMap[id];

    if (oldSort !== newSort) {
      ops.push({
        updateOne: {
          filter: { _id: id },
          update: { $set: { sortOrder: newSort } },
        },
      });
    }
  });

  // 4. Run bulkWrite if needed
  if (ops.length > 0) {
    await categoryModel.bulkWrite(ops);
  }

  return res.status(200).json({
    code: 200,
    message: "Categories reordered successfully",
    updatedCount: ops.length,
  });
});
// Get All Categories
exports.getAllCategories = catchAsyncError(async (req, res) => {
  const categories = await categoryModel.find().sort({ sortOrder: 1 }).lean();

  if (!categories) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Categories not found",
    });
  }
  for (let i = 0; i < categories.length; i++) {
    let cat = categories[i];

    // subcategoryCount
    cat.subCategoryCount = cat.subCategories ? cat.subCategories.length : 0;

    // productCount (all products of this category)
    const productCount = await productModel.countDocuments({
      categoryId: cat._id,
      isDeleted: { $ne: true }, // ✅ ADD
    });
    cat.productCount = productCount;

    // sort subcategories
    if (cat.subCategories && cat.subCategories.length > 0) {
      cat.subCategories.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    }

    // add product count for each subcategory
    for (let j = 0; j < cat.subCategories.length; j++) {
      const sub = cat.subCategories[j];
      const subProductCount = await productModel.countDocuments({
        categoryId: cat._id,
        subcategoryId: sub._id,
        isDeleted: { $ne: true }, // ✅ ADD
      });
      sub.productCount = subProductCount;
    }
  }
  // categories.forEach(cat => {
  //     if (cat.subCategories && cat.subCategories.length > 0) {
  //         cat.subCategories.sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
  //     }
  // });
  const totalCategories = await categoryModel.countDocuments();

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Categories fetched successfully",
    data: {
      totalCategories,
      categories,
    },
  });
});

// Update Category
exports.updateCategory = catchAsyncError(async (req, res) => {
  const { categoryId } = req.params;
  const updateData = { ...req.body };

  if (!mongoose.Types.ObjectId.isValid(categoryId)) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid category ID",
    });
  }
  // Prevent sortOrder from being updated via API body
  delete updateData.sortOrder;

  // Check if category exists
  const existingCategory = await categoryModel.findOne({
    _id: categoryId,
  });

  if (!existingCategory) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Category not found",
    });
  }

  // Check if categoryCode is being updated and if it already exists
  if (
    updateData.categoryCode &&
    updateData.categoryCode !== existingCategory.categoryCode
  ) {
    // 1. Check if category code already exists in other categories
    const codeExists = await categoryModel.findOne({
      categoryCode: updateData.categoryCode,
      _id: { $ne: categoryId },
    });

    if (codeExists) {
      return responseHandler({
        res,
        code: statusCode.CONFLICT,
        message: "Category with this code already exists",
      });
    }

    // 2. Check if new category code matches any existing subcategory code
    // const allCategories = await categoryModel.find({});
    // const allExistingSubCodes = [];

    // allCategories.forEach(category => {
    //     category.subCategories.forEach(sub => {
    //         allExistingSubCodes.push(sub.subCategoryCode);
    //     });
    // });

    // if (allExistingSubCodes.includes(updateData.categoryCode)) {
    //     return responseHandler({
    //         res,
    //         code: statusCode.CONFLICT,
    //         message: "Category code cannot match any existing subcategory code"
    //     });
    // }
  }

  const finalCategoryName = updateData.categoryName || existingCategory.categoryName;
  updateData.categoryCode = generateCategoryCodeFromName(finalCategoryName);

  // --- IMAGE REPLACEMENT LOGIC ---
  if (
    updateData.categoryImage &&
    updateData.categoryImage !== existingCategory.categoryImage
  ) {
    const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");
    const s3 = new S3Client({
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID,
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      },
      region: process.env.AWS_REGION,
    });

    // old image key nikaalo
    const oldImageKey = existingCategory.categoryImage
      ? existingCategory.categoryImage.split(".amazonaws.com/")[1]
      : null;

    if (oldImageKey) {
      try {
        await s3.send(
          new DeleteObjectCommand({
            Bucket: process.env.AWS_BUCKET_NAME,
            Key: oldImageKey,
          }),
        );
      } catch (err) {
        console.log("Error deleting old image:", err.message);
        // don’t fail request if delete fails
      }
    }
  }
  // --- SUBCATEGORY HANDLING ---
  if (updateData.subCategories && updateData.subCategories.length > 0) {
    // Duplicate subcategory name check
    const subCategoryNames = updateData.subCategories.map(
      (sub) => sub.subCategoryName,
    );
    const duplicateSubNames = subCategoryNames.filter(
      (name, idx) => subCategoryNames.indexOf(name) !== idx,
    );
    if (duplicateSubNames.length > 0) {
      return responseHandler({
        res,
        code: statusCode.CONFLICT,
        message: `Duplicate subcategory names found: ${duplicateSubNames.join(", ")}`,
      });
    }

    // Generate subcategory codes based on required format AAA-BBB
    const processedSubCategories = updateData.subCategories.map((sub, i) => {
      const subCategoryName = sub.subCategoryName || "";
      const subCategoryCode = generateSubCategoryCode(
        finalCategoryName,
        subCategoryName,
      );
      return {
        ...sub,
        subCategoryCode,
        sortOrder: sub.sortOrder || i + 1,
      };
    });

    updateData.subCategories = processedSubCategories;
  } else if (updateData.categoryName) {
    // If category name changes, regenerate existing subcategory codes with new prefix.
    updateData.subCategories = existingCategory.subCategories.map((sub) => ({
      ...sub.toObject(),
      subCategoryCode: generateSubCategoryCode(
        finalCategoryName,
        sub.subCategoryName,
      ),
    }));
  }

  const updatedCategory = await categoryModel.findByIdAndUpdate(
    categoryId,
    { $set: updateData },
    { new: true, runValidators: true },
  );

  return responseHandler({
    res,
    code: statusCode.UPDATED,
    message: "Category updated successfully",
    data: updatedCategory,
  });
});
// Delete Category (Hard Delete)
exports.deleteCategory = catchAsyncError(async (req, res) => {
  const { categoryId } = req.params;
  const { S3Client, DeleteObjectCommand } = require("@aws-sdk/client-s3");

  const s3 = new S3Client({
    credentials: {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    },
    region: process.env.AWS_REGION,
  });

  if (!mongoose.Types.ObjectId.isValid(categoryId)) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid category ID",
    });
  }

  const category = await categoryModel.findById(categoryId);

  if (!category) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Category not found",
    });
  }
  const productExists = await productModel.exists({
    categoryId,
    isDeleted: { $ne: true }, // ✅ ADD
  });
  if (productExists) {
    return responseHandler({
      res,
      code: statusCode.CONFLICT,
      message: "Cannot delete this category as it contains products",
    });
  }

  // Store the image key for deletion
  const imageKey = category.categoryImage
    ? category.categoryImage.split(".amazonaws.com/")[1]
    : null;

  // Hard delete the category (this will also delete all subcategories)
  await categoryModel.findByIdAndDelete(categoryId);

  // Delete the associated image from S3 if it exists
  if (imageKey) {
    try {
      const deleteParams = {
        Bucket: process.env.AWS_BUCKET_NAME,
        Key: imageKey,
      };
      await s3.send(new DeleteObjectCommand(deleteParams));
    } catch (error) {
      console.log("Error deleting category image:", error.message);
      // Don't fail the request if image deletion fails
    }
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Category deleted successfully",
  });
});
//reorder subcategories
exports.reorderSubCategories = catchAsyncError(async (req, res) => {
  const { categoryId, orderedIds } = req.body;

  if (!categoryId || !mongoose.Types.ObjectId.isValid(categoryId)) {
    return res.status(400).json({
      code: 400,
      message: "Invalid categoryId",
    });
  }

  if (!orderedIds || !Array.isArray(orderedIds)) {
    return res.status(400).json({
      code: 400,
      message: "orderedIds must be an array of subCategory IDs",
    });
  }

  // 1. Get the category with its subCategories
  const category = await categoryModel.findById(categoryId);

  if (!category) {
    return res.status(404).json({
      code: 404,
      message: "Category not found",
    });
  }

  // 2. Build old mapping of subCategory sortOrder
  const oldMap = {};
  category.subCategories.forEach((sub) => {
    oldMap[sub._id.toString()] = sub.sortOrder;
  });

  // 3. Prepare bulk update ops (only for changed subCategories)
  const ops = [];
  orderedIds.forEach((id, index) => {
    const newSort = index + 1;
    const oldSort = oldMap[id];

    if (oldSort !== newSort) {
      ops.push({
        updateOne: {
          filter: { _id: categoryId, "subCategories._id": id },
          update: { $set: { "subCategories.$.sortOrder": newSort } },
        },
      });
    }
  });

  // 4. Run bulkWrite if needed
  if (ops.length > 0) {
    await categoryModel.bulkWrite(ops);
  }

  return res.status(200).json({
    code: 200,
    message: "SubCategories reordered successfully",
    updatedCount: ops.length,
  });
});
// Update SubCategory
exports.updateSubCategory = catchAsyncError(async (req, res) => {
  const { categoryId, subCategoryId } = req.params;
  const updateData = req.body;

  if (
    !mongoose.Types.ObjectId.isValid(categoryId) ||
    !mongoose.Types.ObjectId.isValid(subCategoryId)
  ) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid category or subcategory ID",
    });
  }

  const category = await categoryModel.findById(categoryId);

  if (!category) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Category not found",
    });
  }

  const subCategory = category.subCategories.find(
    (sub) => sub._id.toString() === subCategoryId,
  );

  if (!subCategory) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "SubCategory not found",
    });
  }

  // Check if subcategory code is being updated and if it already exists
  if (
    updateData.subCategoryCode &&
    updateData.subCategoryCode !== subCategory.subCategoryCode
  ) {
    // 1. Check if subcategory code already exists in this category
    const codeExists = category.subCategories.find(
      (sub) =>
        sub.subCategoryCode === updateData.subCategoryCode &&
        sub._id.toString() !== subCategoryId,
    );

    if (codeExists) {
      return responseHandler({
        res,
        code: statusCode.CONFLICT,
        message: "SubCategory with this code already exists in this category",
      });
    }
  }

  // Update subcategory
  if (updateData.subCategoryName) {
    updateData.subCategoryCode = generateSubCategoryCode(
      category.categoryName,
      updateData.subCategoryName,
    );
  }
  Object.assign(subCategory, updateData);

  await category.save();

  return responseHandler({
    res,
    code: statusCode.UPDATED,
    message: "SubCategory updated successfully",
    data: category,
  });
});
// Delete SubCategory (Hard Delete)
exports.deleteSubCategory = catchAsyncError(async (req, res) => {
  const { categoryId, subCategoryId } = req.params;

  if (
    !mongoose.Types.ObjectId.isValid(categoryId) ||
    !mongoose.Types.ObjectId.isValid(subCategoryId)
  ) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid category or subcategory ID",
    });
  }

  const category = await categoryModel.findById(categoryId);

  if (!category) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Category not found",
    });
  }

  const subCategory = category.subCategories.find(
    (sub) => sub._id.toString() === subCategoryId,
  );

  if (!subCategory) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "SubCategory not found",
    });
  }
  const productExists = await productModel.exists({
    categoryId,
    subcategoryId: subCategoryId,
    isDeleted: { $ne: true }, // ✅ ADD
  });

  if (productExists) {
    return responseHandler({
      res,
      code: statusCode.CONFLICT,
      message: "Cannot delete this subcategory as it contains products",
    });
  }

  // Hard delete the subcategory by removing it from the array
  category.subCategories.pull(subCategoryId);
  await category.save();

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "SubCategory deleted successfully",
  });
});
