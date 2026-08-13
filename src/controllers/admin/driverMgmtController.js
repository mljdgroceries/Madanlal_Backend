const mongoose = require("mongoose");
const Driver = require("../../models/driverModel");
const Order= require("../../models/orderModel")
const Zone = require("../../models/deliveryZonesModel");
const { catchAsyncError } = require("../../utils/generateError");
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");
const { isExportRequest, createWorkbook, addSheet, sendWorkbook } = require("../../utils/excelExport");

exports.createDriver = catchAsyncError(async (req, res) => {
  const {
    fullName,
    mobileNumber,
    email,
    driverImage,
    assignedGeofenceAreas,
    vehicleType,
    idProof,
    status
  } = req.body;
  if (!fullName || !mobileNumber || !vehicleType) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Full name, mobile number, vehicle type and assignedGeofenceAreas are required.",
    });
  }

  const existing = await Driver.findOne({ mobileNumber });

  if (existing) {
    if (existing.status === "Deleted") {

      const lastDriver = await Driver.aggregate([
        { $match: { shortId: { $regex: /^D-\d+$/ } } },
        {
          $addFields: {
            numericShortId: { $toInt: { $substr: ["$shortId", 2, -1] } },
          },
        },
        { $sort: { numericShortId: -1 } },
        { $limit: 1 },
      ]);

      const newShortId =
        lastDriver.length > 0 ? `D-${lastDriver[0].numericShortId + 1}` : "D-1";

      const driver = await Driver.create({
        shortId: newShortId,
        fullName,
        mobileNumber,
        email,
        driverImage,
        assignedGeofenceAreas,
        vehicleType,
        idProof,
        status
      });

      return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Driver created successfully.",
        data: driver,
      });
    } else if (existing.status === "Inactive") {
      return responseHandler({
        res,
        code: statusCode.UNAUTHORIZED,
        message: "This driver account is inactive. Please contact admin.",
      });
    } else {
      return responseHandler({
        res,
        code: statusCode.CONFLICT,
        message: "Driver with this mobile number already exists.",
      });
    }
  }

  const lastDriver = await Driver.aggregate([
    { $match: { shortId: { $regex: /^D-\d+$/ } } },
    {
      $addFields: {
        numericShortId: { $toInt: { $substr: ["$shortId", 2, -1] } },
      },
    },
    { $sort: { numericShortId: -1 } },
    { $limit: 1 },
  ]);

  const newShortId =
    lastDriver.length > 0 ? `D-${lastDriver[0].numericShortId + 1}` : "D-1";

  const driver = await Driver.create({
    shortId: newShortId,
    fullName,
    mobileNumber,
    email,
    driverImage,
    assignedGeofenceAreas,
    vehicleType,
    idProof,
    status
  });

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Driver created successfully.",
    data: driver,
  });
});
exports.getAllDrivers = catchAsyncError(async (req, res) => {
  let { search, page, limit, status, zone } = req.query;

  page = parseInt(page);
  limit = parseInt(limit);
  const skip = (page - 1) * limit;
  let query = { status: { $ne: "Deleted" } };

  if (search) {
    const regex = new RegExp(search, "i");
    query.$or = [
      { fullName: regex },
      { mobileNumber: regex },
      { email: regex },
    ];
  }
 
  if (status) {
    query.status = status;
  }


  if (zone) {
    query.assignedGeofenceAreas = zone;
  }

  const total = await Driver.countDocuments(query);
  const drivers = await Driver.find(query)
    .populate({
      path: "assignedGeofenceAreas",
      select: "zoneName zoneCode",
    })
    .skip(skip)
    .limit(limit)
    .sort({ createdAt: -1 });

    const finalDrivers = [];

for (const d of drivers) {
  // count orders delivered by this driver
  const deliveryCount = await Order.countDocuments({
    orderAssignedTo: d._id, 
    status: "Delivered",
  });

  // average rating
  const averageRating = d.averageRating || 0;

  finalDrivers.push({
    ...d._doc,
    deliveryCount,
    averageRating,
  });
}


  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Driver list fetched successfully.",
    data: {
      drivers:finalDrivers,
      total,
      page,
      limit,
      totalPages: Math.ceil(total / limit),
    },
  });
});
exports.getDriverById = catchAsyncError(async (req, res) => {
  const { driverId } = req.query;

  if (!driverId || !mongoose.Types.ObjectId.isValid(driverId)) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Valid driverId is required.",
    });
  }

  const driver = await Driver.findById(driverId)
    .populate({
      path: "assignedGeofenceAreas",
      select: "zoneName zoneCode",
    });

  if (!driver) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Driver not found.",
    });
  }

  const deliveryCount = await Order.countDocuments({
    orderAssignedTo: driver._id,
    status: "Delivered",
  });

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Driver details fetched successfully.",
    data: {
      ...driver.toObject(),
      deliveryCount,
    },
  });
});
exports.getDriverEarnings = catchAsyncError(async (req, res) => {
  const { driverId, filter, startDate, endDate, page = 1, limit = 10 } = req.query;
  const isExport = isExportRequest(req);

  if (!driverId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "driverId is required",
    });
  }

  const driverObjectId = new mongoose.Types.ObjectId(driverId);
  const limitNum = Number(limit) || 10;
  const pageNum = Number(page) || 1;
  const skip = (pageNum - 1) * limitNum;
  const now = new Date();
  const normalizedFilter = String(filter || "").trim().toLowerCase();

  // ---------- DATE RANGES ----------
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);

  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);

  const yesterdayStart = new Date(todayStart);
  yesterdayStart.setDate(todayStart.getDate() - 1);

  const yesterdayEnd = new Date(todayEnd);
  yesterdayEnd.setDate(todayEnd.getDate() - 1);

  const weekStart = new Date(todayStart);
  const day = weekStart.getDay() || 7;
  weekStart.setDate(weekStart.getDate() - day + 1);

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);

  // ---------- BASE MATCH ----------
  const baseMatch = {
    orderAssignedTo: driverObjectId,
    status: "Delivered",
  };

  // ---------- SUMMARY (ALL DELIVERED ORDERS COUNTED) ----------
  const getSummary = (dateFilter) =>
    Order.aggregate([
      { $match: { ...baseMatch, ...dateFilter } },
      {
        $addFields: {
          normalizedAmount: {
            $let: {
              vars: {
                storedGrandTotal: { $ifNull: ["$grandTotal", 0] },
                computedFromComponents: {
                  $subtract: [
                    {
                      $add: [
                        { $ifNull: ["$subTotal", 0] },
                        { $ifNull: ["$deliveryCharge", 0] },
                        { $ifNull: ["$platformFee", 0] },
                      ],
                    },
                    { $ifNull: ["$couponDiscount", 0] },
                  ],
                },
              },
              in: {
                $cond: [
                  { $gt: ["$$storedGrandTotal", 0] },
                  "$$storedGrandTotal",
                  { $max: ["$$computedFromComponents", 0] },
                ],
              },
            },
          },
        },
      },
      {
        $group: {
          _id: null,
          total: {
            $sum: { $ifNull: ["$normalizedAmount", 0] },
          },
        },
      },
    ]);

  const [today, yesterday, weekly, monthly] = await Promise.all([
    getSummary({ "tracking.deliveredAt": { $gte: todayStart, $lte: todayEnd } }),
    getSummary({ "tracking.deliveredAt": { $gte: yesterdayStart, $lte: yesterdayEnd } }),
    getSummary({ "tracking.deliveredAt": { $gte: weekStart, $lte: todayEnd } }),
    getSummary({ "tracking.deliveredAt": { $gte: monthStart, $lte: todayEnd } }),
  ]);

  // ---------- TRANSACTION DATE FILTER ----------
  let transactionDateFilter = {};

  if (startDate && endDate) {
    const from = new Date(startDate);
    from.setHours(0, 0, 0, 0);

    const to = new Date(endDate);
    to.setHours(23, 59, 59, 999);

    transactionDateFilter["tracking.deliveredAt"] = { $gte: from, $lte: to };
  } else if (normalizedFilter === "today") {
    transactionDateFilter["tracking.deliveredAt"] = { $gte: todayStart, $lte: todayEnd };
  } else if (normalizedFilter === "yesterday") {
    transactionDateFilter["tracking.deliveredAt"] = {
      $gte: yesterdayStart,
      $lte: yesterdayEnd,
    };
  } else if (normalizedFilter === "weekly") {
    transactionDateFilter["tracking.deliveredAt"] = { $gte: weekStart, $lte: todayEnd };
  } else if (normalizedFilter === "monthly") {
    transactionDateFilter["tracking.deliveredAt"] = { $gte: monthStart, $lte: todayEnd };
  }

  // ---------- RECENT TRANSACTIONS ----------
  const [transactions, totalCount] = await Promise.all([
    Order.find({ ...baseMatch, ...transactionDateFilter })
      .select(
        "orderId grandTotal subTotal deliveryCharge platformFee couponDiscount paymentMethod codPaymentStatus tracking.deliveredAt createdAt",
      )
      .sort({ "tracking.deliveredAt": -1 })
      .skip(isExport ? 0 : skip)
      .limit(isExport ? 100000 : limitNum)
      .lean(),

    Order.countDocuments({ ...baseMatch, ...transactionDateFilter }),
  ]);

  // ---------- FORMAT TRANSACTIONS ----------
  const formattedTransactions = transactions.map((t) => {
    const storedGrandTotal = Number(t.grandTotal || 0);
    const computedFromComponents =
      Number(t.subTotal || 0) +
      Number(t.deliveryCharge || 0) +
      Number(t.platformFee || 0) -
      Number(t.couponDiscount || 0);
    const normalizedAmount =
      storedGrandTotal > 0 ? storedGrandTotal : Math.max(computedFromComponents, 0);

    return {
      ...t,
      grandTotal: Number(normalizedAmount.toFixed(2)),
    };
  });

  if (isExport) {
    const workbook = createWorkbook();

    addSheet(workbook, {
      name: "Summary",
      columns: [
        { header: "Metric", key: "metric" },
        { header: "Value", key: "value" },
      ],
      rows: [
        { metric: "Today", value: today[0]?.total || 0 },
        { metric: "Yesterday", value: yesterday[0]?.total || 0 },
        { metric: "Weekly", value: weekly[0]?.total || 0 },
        { metric: "Monthly", value: monthly[0]?.total || 0 },
      ],
    });

    addSheet(workbook, {
      name: "Transactions",
      columns: [
        { header: "Order ID", key: "orderId" },
        { header: "Delivered At", key: "deliveredAt" },
        { header: "Payment Method", key: "paymentMethod" },
        { header: "COD Payment Status", key: "codPaymentStatus" },
        { header: "Amount", key: "grandTotal" },
        { header: "Created At", key: "createdAt" },
      ],
      rows: (formattedTransactions || []).map((t) => ({
        orderId: t?.orderId || "",
        deliveredAt: t?.tracking?.deliveredAt ? new Date(t.tracking.deliveredAt) : "",
        paymentMethod: t?.paymentMethod || "",
        codPaymentStatus: t?.codPaymentStatus || "",
        grandTotal: t?.grandTotal || 0,
        createdAt: t?.createdAt ? new Date(t.createdAt) : "",
      })),
    });

    await sendWorkbook(res, workbook, {
      fileName: `driver_earnings_${driverId}_${new Date().toISOString().slice(0, 10)}.xlsx`,
    });
    return;
  }

  // ---------- RESPONSE ----------
  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Driver earnings fetched successfully",
    data: {
      summary: {
        today: today[0]?.total || 0,
        yesterday: yesterday[0]?.total || 0,
        weekly: weekly[0]?.total || 0,
        monthly: monthly[0]?.total || 0,
      },
      recentTransactions: formattedTransactions,
      pagination: {
        total: totalCount,
        page: pageNum,
        limit: limitNum,
        totalPages: Math.ceil(totalCount / limitNum),
      },
    },
  });
});
exports.updateDriver = catchAsyncError(async (req, res) => {
  const { driverId } = req.query;
  const updatedData = req.body;

  const driver = await Driver.findByIdAndUpdate(driverId, { $set: updatedData }, { new: true });

  if (!driver) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Driver not found.",
    });
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Driver updated successfully.",
    data: driver,
  });
});
exports.deleteDriver = catchAsyncError(async (req, res) => {
  const { driverId } = req.query;

  const driver = await Driver.findByIdAndUpdate(
    driverId,
    {
      status: "Deleted",
      accessToken: null,
      devices: [],
      deletedAt: new Date()
    },
    { new: true }
  );

  if (!driver) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Driver not found.",
    });
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Driver deleted successfully.",
    data: driver,
  });
});
exports.getDriverPerformance = catchAsyncError(async (req, res) => {
  const {
    startDate,
    endDate,
    geofenceArea = "all",
    reportType = "weekly"
  } = req.query;

  let start = startDate ? new Date(startDate) : null;
  let end = endDate ? new Date(endDate) : null;

  if (end) end.setHours(23, 59, 59, 999);

  const zoneId =
    geofenceArea !== "all"
      ? new mongoose.Types.ObjectId(geofenceArea)
      : null;


  // 🔹 ORDER FILTER
   const driverFilter = {
    ...(zoneId ? { assignedGeofenceAreas: { $in: [zoneId] } } : {})
  };

  const drivers = await Driver.find(
    driverFilter,
    "fullName mobileNumber driverImage assignedGeofenceAreas"
  ).populate("assignedGeofenceAreas", "zoneName zoneCode");

   const orderFilter = {
    ...(start && end ? { createdAt: { $gte: start, $lte: end } } : {}),
    orderAssignedTo: { $ne: null }
  };


  const orders = await Order.find(orderFilter);

  const performanceData = drivers.map((driver) => {
    const driverOrders = orders.filter(
      (o) => o.orderAssignedTo?.toString() === driver._id.toString()
    );

    const totalOrders = driverOrders.length;

    const deliveredOrders = driverOrders.filter(
      (o) => o.status === "Delivered"
    );

    const cancelledOrders = driverOrders.filter(
      (o) => o.status === "Cancelled"
    );

   const cancelRate =
  totalOrders > 0
    ? Number(((cancelledOrders.length / totalOrders) * 100).toFixed(1))
    : 0;

         const ratedOrders = deliveredOrders.filter(
      (o) => o.driverRating && o.driverRating > 0
    );

    const averageRating =
      ratedOrders.length > 0
        ? (
            ratedOrders.reduce((sum, o) => sum + o.driverRating, 0) /
            ratedOrders.length
          ).toFixed(1)
        : "0.0";

    return {
      driverId: driver._id,
      driverName: driver.fullName,
      phone: driver.mobileNumber,
      driverImage: driver.driverImage || "",
      zones: driver.assignedGeofenceAreas.map((z) => ({
        zoneId: z._id,
        zoneName: z.zoneName,
        zoneCode: z.zoneCode
      })),

      totalOrders,
      deliveredOrders:deliveredOrders.length,

      cancelledOrders: cancelledOrders.length,
      cancelRate ,

      
      averageRating,               

      reportType,
      dateRange:
        startDate && endDate ? `${startDate} - ${endDate}` : "All Time"
    };
  });

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Driver performance report fetched successfully",
    data: performanceData
  });
});
