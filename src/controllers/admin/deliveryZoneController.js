const Zone = require("../../models/deliveryZonesModel");
const Order = require("../../models/orderModel");
const Driver = require("../../models/driverModel");
const { catchAsyncError } = require("../../utils/generateError");
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");

exports.createZone = catchAsyncError(async (req, res) => {
  const {
    zoneName,
    zoneCode,
    description,
    locations,
    // deliveryCharge,
    // freeDeliveryAbove,
    // deliveryTime,
    priorityLevel,
    assignedDrivers,
    status,
  } = req.body;

  if (!zoneName || !zoneCode || !locations) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Zone name, zone code, locations are required.",
    });
  }
  // Extract all pins from incoming locations
  const pins = locations.map((loc) => loc.pin);

  // Check if any of these pins already exist in another zone
  const duplicatePins = await Zone.find({
    "locations.pin": { $in: pins },
    status: { $ne: "Deleted" }, // Deleted zone ignore
  }).select("zoneName zoneCode locations");

  if (duplicatePins.length > 0) {
    return responseHandler({
      res,
      code: statusCode.CONFLICT,
      message: "Some pincodes are already assigned to another zone.",
      data: duplicatePins,
    });
  }

  const existingZone = await Zone.findOne({ zoneCode });
  if (existingZone) {
    return responseHandler({
      res,
      code: statusCode.CONFLICT,
      message: "Zone code already exists.",
    });
  }
  const newZone = await Zone.create({
    zoneName,
    zoneCode,
    description,
    locations,
    // deliveryCharge,
    // freeDeliveryAbove,
    // deliveryTime,
    priorityLevel,
    status,
  });
  // Assign zone to drivers (if any)
  if (assignedDrivers && assignedDrivers.length > 0) {
    await Driver.updateMany(
      { _id: { $in: assignedDrivers }, status: { $ne: "Deleted" } },
      { $addToSet: { assignedGeofenceAreas: newZone._id } }
    );
  }
  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message:
      assignedDrivers && assignedDrivers.length > 0
        ? "Zone created successfully and assigned to selected drivers."
        : "Zone created successfully.",
    data: newZone,
  });
});
exports.getAllZones = catchAsyncError(async (req, res) => {
  const zones = await Zone.find().lean();

  const zonesWithDrivers = await Promise.all(
    zones.map(async (zone) => {
      const assignedDrivers = await Driver.find({
        assignedGeofenceAreas: zone._id,
        status: { $ne: "Deleted" },
      }).select("fullName mobileNumber driverImage status availability");

      return {
        ...zone,
        assignedDrivers,
      };
    })
  );

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Zones with their respective drivers fetched successfully.",
    data: zonesWithDrivers,
  });
});
// exports.getAssignmentRules = catchAsyncError(async (req, res) => {

//   // ---------- DATE RANGES ----------
//   const todayStart = new Date();
//   todayStart.setHours(0, 0, 0, 0);

//   const todayEnd = new Date();
//   todayEnd.setHours(23, 59, 59, 999);

//   const yesterdayStart = new Date(todayStart);
//   yesterdayStart.setDate(todayStart.getDate() - 1);

//   const yesterdayEnd = new Date(todayEnd);
//   yesterdayEnd.setDate(todayEnd.getDate() - 1);

//   // ---------- FETCH ZONES ----------
//   const zones = await Zone.find({ status: "Active" }).lean();

//   const formattedZones = await Promise.all(
//     zones.map(async (zone) => {

//       // ---- ASSIGNED DRIVERS ----
//       const linkedDrivers = await Driver.find({
//         assignedGeofenceAreas: zone._id,
//         status: { $ne: "Deleted" },
//       }).select("_id fullName mobileNumber driverImage ");

//       // ---- ORDERS TODAY ----
//       const ordersToday = await Order.countDocuments({
//         zoneId: zone._id,
//         createdAt: { $gte: todayStart, $lte: todayEnd },
//       });

//       // ---- ORDERS YESTERDAY ----
//       const ordersYesterday = await Order.countDocuments({
//         zoneId: zone._id,
//         createdAt: { $gte: yesterdayStart, $lte: yesterdayEnd },
//       });

//       // ---- % CHANGE FROM YESTERDAY ----
//       const changeFromYesterday =
//         ordersYesterday > 0
//           ? (((ordersToday - ordersYesterday) / ordersYesterday) * 100).toFixed(1)
//           : ordersToday > 0
//           ? 100
//           : 0;

//       return {
//         zoneId: zone._id,
//         zoneName: zone.zoneName,
//         priorityLevel: zone.priorityLevel,
//         locations: zone.locations,
//         linkedDriversCount: linkedDrivers.length,
//         linkedDrivers,
//         ordersToday,
//         changeFromYesterday: Number(changeFromYesterday),
//       };
//     })
//   );

//   return responseHandler({
//     res,
//     code: statusCode.SUCCESS,
//     message: "Assignment rules fetched successfully",
//     data: {
//       zones: formattedZones,
//     },
//   });
// });
exports.getAssignmentRules = catchAsyncError(async (req, res) => {
  // ---------- DATE RANGES ----------
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(todayStart.getDate() - 1);

  const yesterdayEnd = new Date(todayEnd);
  yesterdayEnd.setDate(todayEnd.getDate() - 1);

  // ---------- FETCH ACTIVE ZONES ----------
  const zones = await Zone.find({ status: "Active" }).lean();

  const formattedZones = await Promise.all(
    zones.map(async (zone) => {
      // 🔑 Zone ke saare pincodes
      const zonePins = zone.locations.map((loc) => loc.pin);

      const latitude = zone.locations?.[0]?.lat || null;
      const longitude = zone.locations?.[0]?.lng || null;

      const drivers = await Driver.find({
        assignedGeofenceAreas: zone._id,
        status: { $ne: "Deleted" },
      }).select(
        "_id fullName mobileNumber driverImage availability status vehicleType"
      );

      // ---- ORDERS TODAY (PINCODE MATCH) ----
      const ordersToday = await Order.countDocuments({
        "deliveryAddress.pincode": { $in: zonePins },
        createdAt: { $gte: todayStart, $lte: todayEnd },
      });

      // ---- ORDERS YESTERDAY ----
      const ordersYesterday = await Order.countDocuments({
        "deliveryAddress.pincode": { $in: zonePins },
        createdAt: { $gte: yesterdayStart, $lte: yesterdayEnd },
      });

      // ---- % CHANGE FROM YESTERDAY ----
      const changeFromYesterday =
        ordersYesterday > 0
          ? (((ordersToday - ordersYesterday) / ordersYesterday) * 100).toFixed(
              1
            )
          : ordersToday > 0
          ? 100
          : 0;

      return {
        zoneId: zone._id,
        zoneName: zone.zoneName,
        latitude,
        longitude,
        driversCount: drivers.length,
        drivers,
        pincodes: zonePins,
        ordersToday,
        changeFromYesterday: Number(changeFromYesterday),
      };
    })
  );

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Assignment rules fetched successfully",
    data: {
      zones: formattedZones,
    },
  });
});

exports.updateZone = catchAsyncError(async (req, res) => {
  const { zoneId } = req.query;
  const {
    zoneName,
    zoneCode,
    description,
    locations,
    // deliveryCharge,
    // freeDeliveryAbove,
    // deliveryTime,
    priorityLevel,
    status,
    assignedDrivers = [],
  } = req.body;

  if (!zoneId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Zone ID is required.",
    });
  }
  // ⚠ Extract PINs from new incoming locations
  let incomingPins = [];
  if (locations && locations.length > 0) {
    incomingPins = locations.map((loc) => loc.pin);
  }
  if (incomingPins.length > 0) {
    const conflictingZones = await Zone.find({
      _id: { $ne: zoneId }, // THIS IS IMPORTANT
      "locations.pin": { $in: incomingPins },
      status: { $ne: "Deleted" },
    }).select("zoneName zoneCode locations");

    if (conflictingZones.length > 0) {
      return responseHandler({
        res,
        code: statusCode.CONFLICT,
        message: "Some pincodes are already assigned to another zone.",
        data: conflictingZones,
      });
    }
  }

  // ✅ Step 1: Update zone basic details
  const updatedZone = await Zone.findByIdAndUpdate(
    zoneId,
    {
      $set: {
        zoneName,
        zoneCode,
        description,
        locations,
        // deliveryCharge,
        // freeDeliveryAbove,
        // deliveryTime,
        priorityLevel,
        status,
      },
    },
    { new: true }
  );

  if (!updatedZone) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Zone not found.",
    });
  }

  // ✅ Step 2: Fetch currently assigned drivers from Driver model
  const currentlyAssignedDrivers = await Driver.find({
    assignedGeofenceAreas: zoneId,
    status: { $ne: "Deleted" },
  }).select("_id");

  const currentlyAssignedDriverIds = currentlyAssignedDrivers.map((d) =>
    d._id.toString()
  );

  // ✅ Step 3: Identify new & removed drivers
  const newAssignedDrivers = assignedDrivers.filter(
    (id) => !currentlyAssignedDriverIds.includes(id)
  );
  const removedDrivers = currentlyAssignedDriverIds.filter(
    (id) => !assignedDrivers.includes(id)
  );

  // ✅ Step 4: Add zone to newly assigned drivers
  if (newAssignedDrivers.length > 0) {
    await Driver.updateMany(
      { _id: { $in: newAssignedDrivers }, status: { $ne: "Deleted" } },
      { $addToSet: { assignedGeofenceAreas: zoneId } }
    );
  }

  // ✅ Step 5: Remove zone from deassigned drivers
  if (removedDrivers.length > 0) {
    await Driver.updateMany(
      { _id: { $in: removedDrivers } },
      { $pull: { assignedGeofenceAreas: zoneId } }
    );
  }

  // ✅ Step 6: Fetch updated assigned drivers (for response)
  const assignedDriverDetails = await Driver.find({
    assignedGeofenceAreas: zoneId,
    status: { $ne: "Deleted" },
  }).select("_id fullName mobileNumber driverImage vehicleType status");

  // ✅ Step 7: Return zone and assigned drivers separately
  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Zone updated successfully.",
    data: {
      ...updatedZone.toObject(),
      assignedDrivers: assignedDriverDetails,
    },
  });
});
exports.deleteZone = catchAsyncError(async (req, res) => {
  const { zoneId } = req.query;

  const zone = await Zone.findByIdAndDelete(zoneId);

  if (!zone) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "zone not found.",
    });
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "zone deleted successfully.",
    data: zone,
  });
});
exports.getZoneById = catchAsyncError(async (req, res) => {
  const { zoneId } = req.query;

  if (!zoneId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Zone ID is required.",
    });
  }

  // 🟢 Fetch zone
  const zone = await Zone.findById(zoneId).lean();

  if (!zone || zone.status === "Deleted") {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Zone not found.",
    });
  }

  // 🟢 Fetch assigned drivers for this zone
  const assignedDrivers = await Driver.find({
    assignedGeofenceAreas: zone._id,
    status: { $ne: "Deleted" },
  }).select("_id fullName mobileNumber driverImage vehicleType status");

  // // 🟢 Attach drivers inside the zone object
  // zone.assignedDrivers = assignedDrivers;

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Zone details fetched successfully",
    data: {
      ...zone,
      assignedDrivers,
    },
  });
});
exports.updateMultipleDriverAvailability = catchAsyncError(async (req, res) => {
  const { drivers } = req.body;

  if (!drivers || !Array.isArray(drivers) || drivers.length === 0) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Drivers array is required.",
    });
  }

  const bulkOps = drivers.map((d) => ({
    updateOne: {
      filter: { _id: d.driverId, status: { $ne: "Deleted" } },
      update: { $set: { availability: d.availability } },
    },
  }));

  await Driver.bulkWrite(bulkOps);

  const updatedDrivers = await Driver.find({
    _id: { $in: drivers.map((d) => d.driverId) },
  }).select("_id fullName mobileNumber availability status");

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Driver availability updated successfully.",
    data: updatedDrivers,
  });
});
