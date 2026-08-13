const FreeItem = require("../../models/freeItemModel");
const FreeItemRule= require("../../models/freeItemRuleModel")
const { catchAsyncError } = require("../../utils/generateError");
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");

exports.addFreeItem = catchAsyncError(async (req, res) => {
    const { productName, stock, productImage} = req.body;

    if (!productName || !productImage) {
        return responseHandler({
            res,
            code: statusCode.DATAMISSING,
            message: "productName and productImage are required"
        });
    }

    const newFreeItem = await FreeItem.create({
        productName,
        stock: stock || 0,  
        productImage,
    });

    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Free item added successfully",
        data: newFreeItem
    });
});

exports.getAllFreeItem= catchAsyncError(async (req, res) => {
  const freeItem = await FreeItem.find()
    // .populate("freeItems")
    // .sort({ createdAt: -1 });

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Free item  fetched successfully.",
    data: freeItem,
  });
});
exports.deleteFreeItem = catchAsyncError(async (req, res) => {
  const { itemId } = req.query;

  if (!itemId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Item ID is required.",
    });
  }

  const assignedRule = await FreeItemRule.findOne({ freeItems: itemId });

  if (assignedRule) {
    return responseHandler({
      res,
      code: statusCode.CONFLICT,
      message: "This free item cannot be deleted because it is assigned to free item rules ",
    });
  }

  const deletedItem = await FreeItem.findByIdAndDelete(itemId);

  if (!deletedItem) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Free item not found.",
    });
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Free item deleted successfully.",
    data: deletedItem,
  });
});

