const StoredClosure = require("../../models/storedClosureModel");
const { catchAsyncError } = require("../../utils/generateError");
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");

exports.createClosure = catchAsyncError(async (req, res) => {
  const { closureDate, closureType } = req.body;
  if (!closureDate || !closureType) {
    return responseHandler({
      res,
      code: statusCode.BADREQUEST,
      message: "Closure date and type are required.",
    });
  }
  const closure = await StoredClosure.create({
    closureDate,
    closureType,
  });
  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Store closure created successfully.",
    data: closure,
  });
});
exports.getAllClosures = catchAsyncError(async (req, res) => {
  const closures = await StoredClosure.find();

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Store closures fetched successfully.",
    data: closures,
  });
});
exports.deleteClosure = catchAsyncError(async (req, res) => {
  const { id } = req.query;

  if (!id) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Closure ID is required.",
    });
  }

  const closure = await StoredClosure.findByIdAndDelete(id);
  if (!closure) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Closure not found.",
    });
  }
  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Store closure deleted successfully.",
  });
});
