const Warehouse = require("../../models/warehouseModel");
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");
const { catchAsyncError } = require("../../utils/generateError");

// Create a new warehouse address
exports.createWarehouse = catchAsyncError(async (req, res) => {
  const { address, isDefault, email, phone } = req.body;

  if (!address || !address.trim()) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Address is required.",
    });
  }

  // If this is set as default, unset any existing default
  if (isDefault) {
    await Warehouse.updateMany({ isDefault: true }, { isDefault: false });
  }

  // If this is the first warehouse, make it default automatically
  const count = await Warehouse.countDocuments({ isActive: true });
  const shouldBeDefault = isDefault || count === 0;

  const warehouse = await Warehouse.create({
    address: address.trim(),
    email: email ? email.trim() : undefined,
    phone: phone ? phone.trim() : undefined,
    isDefault: shouldBeDefault,
    isActive: true,
  });

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Warehouse address added successfully.",
    data: warehouse,
  });
});

// Get all active warehouse addresses
exports.getAllWarehouses = catchAsyncError(async (req, res) => {
  const warehouses = await Warehouse.find({ isActive: true }).sort({ isDefault: -1, createdAt: -1 });

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Warehouses fetched successfully.",
    data: warehouses,
  });
});

// Update a warehouse address
exports.updateWarehouse = catchAsyncError(async (req, res) => {
  const { warehouseId } = req.params;
  const { address, email, phone } = req.body;

  if (!warehouseId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "warehouseId is required.",
    });
  }

  if (!address || !address.trim()) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Address is required.",
    });
  }

  const updateFields = {
    address: address.trim(),
  };

  if (email !== undefined) updateFields.email = email ? email.trim() : "";
  if (phone !== undefined) updateFields.phone = phone ? phone.trim() : "";

  const warehouse = await Warehouse.findOneAndUpdate(
    { _id: warehouseId, isActive: true },
    updateFields,
    { new: true }
  );

  if (!warehouse) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Warehouse not found.",
    });
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Warehouse address updated successfully.",
    data: warehouse,
  });
});

// Delete (soft delete) a warehouse address
exports.deleteWarehouse = catchAsyncError(async (req, res) => {
  const { warehouseId } = req.params;

  if (!warehouseId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "warehouseId is required.",
    });
  }

  const warehouse = await Warehouse.findOneAndUpdate(
    { _id: warehouseId, isActive: true },
    { isActive: false, isDefault: false },
    { new: true }
  );

  if (!warehouse) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Warehouse not found.",
    });
  }

  // If deleted warehouse was default, make another one default
  const defaultExists = await Warehouse.findOne({ isDefault: true, isActive: true });
  if (!defaultExists) {
    const nextWarehouse = await Warehouse.findOne({ isActive: true }).sort({ createdAt: 1 });
    if (nextWarehouse) {
      nextWarehouse.isDefault = true;
      await nextWarehouse.save();
    }
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Warehouse address deleted successfully.",
  });
});

// Set a warehouse as default
exports.setDefaultWarehouse = catchAsyncError(async (req, res) => {
  const { warehouseId } = req.params;

  if (!warehouseId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "warehouseId is required.",
    });
  }

  const warehouse = await Warehouse.findOne({ _id: warehouseId, isActive: true });
  if (!warehouse) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Warehouse not found.",
    });
  }

  // Unset all defaults, then set this one
  await Warehouse.updateMany({ isDefault: true }, { isDefault: false });
  warehouse.isDefault = true;
  await warehouse.save();

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Default warehouse updated successfully.",
    data: warehouse,
  });
});
