const DeliveryOrderConfig = require("../../models/deliveryConfigModel");
const { catchAsyncError } = require("../../utils/generateError");
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");


exports.saveDeliveryConfig = catchAsyncError(async (req, res) => {
  const { zoneId } = req.body;

  // 🟥 1. Validation
  if (!zoneId) {
    return responseHandler({
      res,
      code: statusCode.BADREQUEST,
      message: "Zone ID is required.",
    });
  }

  // 🟡 2. Check if config already exists for this zone
  const existingConfig = await DeliveryOrderConfig.findOne({ zoneId, status: { $ne: "Deleted" } });

  let config;
  let message;

  if (existingConfig) {
    // 🟢 3. Update existing config
    config = await DeliveryOrderConfig.findOneAndUpdate(
      { zoneId },
      { $set: req.body },
      { new: true }
    );
    message = "Delivery configuration updated successfully.";
  } else {
    // 🟢 4. Create new config if not exists
    config = await DeliveryOrderConfig.create(req.body);
    message = "Delivery configuration created successfully.";
  }

  // 🟢 5. Send success response
  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message,
    data: config,
  });
});

exports.getDeliveryConfigByZone = catchAsyncError(async (req, res) => {
  const { zoneId } = req.query;
  if (!zoneId) {
    return responseHandler({
      res,
      code: statusCode.BADREQUEST,
      message: "Zone ID is required.",
    });
  }

  const config = await DeliveryOrderConfig.findOne({ zoneId });
  if (!config) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "No configuration found for this zone.",
    });
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Delivery configuration fetched successfully.",
    data: config,
  });
});

exports.deleteConfig = catchAsyncError(async (req, res) => {
  const { zoneId } = req.query;

  const config = await DeliveryOrderConfig.findOneAndUpdate(
    { zoneId },
    { $set: { status: "Deleted" } },
    { new: true }
  );

  if (!config) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Configuration not found.",
    });
  } 

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Configuration deleted successfully.",
    data: config,
  });
});