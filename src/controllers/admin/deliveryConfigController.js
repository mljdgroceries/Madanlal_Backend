const DeliveryOrderConfig = require("../../models/deliveryConfigModel");
const DistanceConfig = require("../../models/distanceDeliveryConfigModel");
const Warehouse = require("../../models/warehouseModel");
const { validateConfig } = require("../../helpers/distanceDeliveryHelper");
const { catchAsyncError } = require("../../utils/generateError");
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");


const withWarehouse = async (config) => {
  const warehouse = await Warehouse.findOne({ isDefault: true, isActive: true }).lean();
  return {
    ...(typeof config.toObject === "function" ? config.toObject() : config),
    warehouse: warehouse ? {
      _id: warehouse._id,
      warehouseName: warehouse.warehouseName || "",
      address: warehouse.address,
      coordinates: warehouse.coordinates || null,
      latitude: warehouse.coordinates?.[1] ?? null,
      longitude: warehouse.coordinates?.[0] ?? null,
      isDefault: warehouse.isDefault,
      isActive: warehouse.isActive,
    } : null,
  };
};

exports.saveDeliveryConfig = catchAsyncError(async (req, res) => {
  if (req.body.distanceRanges !== undefined || req.body.pricingMode === "distance" || !req.body.zoneId) {
    try {
      const payload = {
        distanceCalculationMode: req.body.distanceCalculationMode,
        platformFee: req.body.platformFee,
        distanceRanges: req.body.distanceRanges,
      };
      if (req.body.deliveryChargesEnabled !== undefined) payload.deliveryChargesEnabled = req.body.deliveryChargesEnabled;
      payload.distanceRanges = validateConfig(payload);
      const config = await DistanceConfig.findByIdAndUpdate("global", { $set: payload },
        { new: true, upsert: true, runValidators: true });
      return responseHandler({ res, code: statusCode.SUCCESS,
        message: "Distance delivery configuration saved successfully.", data: await withWarehouse(config) });
    } catch (error) {
      return responseHandler({ res, code: statusCode.DATAMISSING, message: error.message });
    }
  }
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
  if (!req.query.zoneId || req.query.pricingMode === "distance") {
    const config = await DistanceConfig.findById("global").lean();
    const data = config ? await withWarehouse(config) : null;
    return responseHandler({ res, code: config ? statusCode.SUCCESS : statusCode.RESULTNOTFOUND,
      message: config ? "Distance delivery configuration fetched successfully." : "Distance delivery configuration is not set.",
      data });
  }
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
