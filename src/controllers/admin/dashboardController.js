const User = require("../../models/userModel");
const Order = require("../../models/orderModel");
const statusCode = require("../../utils/httpResponseCode");
const { responseHandler } = require("../../utils/responseHandler");
const { catchAsyncError } = require("../../utils/generateError");

exports.getDashboard = catchAsyncError(async (req, res) => {
  const {
    revenueFilter = "today",
    orderFilter = "today",
    salesOverviewFilter = "7d"
  } = req.query;

  const now = new Date();

  /* =========================
     HELPER (IST DATE FORMAT)
  ========================= */
  const formatLocalDate = (date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  };

  /* =========================
     USERS
  ========================= */
  const totalUsers = await User.countDocuments();

  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

  const prevMonthStart = new Date(now.getFullYear(), now.getMonth() - 2, 1);
  const prevMonthEnd = new Date(now.getFullYear(), now.getMonth() - 1, 0, 23, 59, 59);

  const lastMonthUsers = await User.countDocuments({
    createdAt: { $gte: lastMonthStart, $lte: lastMonthEnd }
  });

  const prevMonthUsers = await User.countDocuments({
    createdAt: { $gte: prevMonthStart, $lte: prevMonthEnd }
  });

  let userGrowthPercent = 0;
  if (prevMonthUsers > 0) {
    userGrowthPercent = Math.round(
      ((lastMonthUsers - prevMonthUsers) / prevMonthUsers) * 100
    );
  }

  /* =========================
     ORDERS
  ========================= */
  const liveOrders = await Order.countDocuments({
    status: { $in: ["Pending", "Confirmed", "Packed"] }
  });

  const pendingDelivery = await Order.countDocuments({
    status: "Shipped"
  });

  /* =========================
     REVENUE FILTER
  ========================= */
  let currentStart, currentEnd, previousStart, previousEnd;

  if (revenueFilter === "today") {
    currentStart = new Date();
    currentStart.setHours(0, 0, 0, 0);

    currentEnd = new Date();
    currentEnd.setHours(23, 59, 59, 999);

    previousStart = new Date(currentStart);
    previousStart.setDate(previousStart.getDate() - 1);

    previousEnd = new Date(currentStart);
  }

  else if (revenueFilter === "lastWeek") {
    currentEnd = new Date();
    currentEnd.setHours(23, 59, 59, 999);

    currentStart = new Date();
    currentStart.setHours(0, 0, 0, 0);
    currentStart.setDate(currentStart.getDate() - 6);

    previousEnd = new Date(currentStart);

    previousStart = new Date(previousEnd);
    previousStart.setDate(previousStart.getDate() - 7);
  }

  else if (revenueFilter === "lastMonth") {
    currentEnd = new Date();
    currentEnd.setHours(23, 59, 59, 999);

    currentStart = new Date();
    currentStart.setHours(0, 0, 0, 0);
    currentStart.setMonth(currentStart.getMonth() - 1);

    previousEnd = new Date(currentStart);

    previousStart = new Date(previousEnd);
    previousStart.setMonth(previousStart.getMonth() - 1);
  }

  /* =========================
     CURRENT REVENUE
  ========================= */
  const currentRevenueAgg = await Order.aggregate([
    {
      $match: {
        status: "Delivered",
        updatedAt: { $gte: currentStart, $lte: currentEnd }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: "$grandTotal" }
      }
    }
  ]);

  const revenue = currentRevenueAgg[0]?.total || 0;

  /* =========================
     PREVIOUS REVENUE
  ========================= */
  const previousRevenueAgg = await Order.aggregate([
    {
      $match: {
        status: "Delivered",
        updatedAt: {
          $gte: previousStart,
          $lt: previousEnd
        }
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: "$grandTotal" }
      }
    }
  ]);

  const previousRevenue = previousRevenueAgg[0]?.total || 0;

  let revenueChangePercent = 0;
  if (previousRevenue > 0) {
    revenueChangePercent = Math.round(
      ((revenue - previousRevenue) / previousRevenue) * 100
    );
  }

  /* =========================
     ORDER STATUS DISTRIBUTION
  ========================= */
  let orderStart;

  if (orderFilter === "today") {
    orderStart = new Date();
    orderStart.setHours(0, 0, 0, 0);
  } else if (orderFilter === "weekly") {
    orderStart = new Date();
    orderStart.setDate(orderStart.getDate() - 7);
  } else if (orderFilter === "monthly") {
    orderStart = new Date();
    orderStart.setMonth(orderStart.getMonth() - 1);
  }

  const orderStatusDistribution = await Order.aggregate([
    {
      $match: {
        createdAt: { $gte: orderStart }
      }
    },
    {
      $group: {
        _id: "$status",
        count: { $sum: 1 }
      }
    },
    {
      $project: {
        _id: 0,
        status: "$_id",
        count: 1
      }
    }
  ]);

  /* =========================
     SALES OVERVIEW (FINAL FIX)
  ========================= */

  let daysBack;
  if (salesOverviewFilter === "7d") daysBack = 7;
  else if (salesOverviewFilter === "30d") daysBack = 30;
  else if (salesOverviewFilter === "90d") daysBack = 90;
  else daysBack = 7;

  const salesOverviewEnd = new Date();
  salesOverviewEnd.setHours(23, 59, 59, 999); // ✅ full today

  const salesOverviewStart = new Date();
  salesOverviewStart.setHours(0, 0, 0, 0);
  salesOverviewStart.setDate(salesOverviewStart.getDate() - (daysBack - 1));

  const salesOverviewAgg = await Order.aggregate([
    {
      $match: {
        status: "Delivered",
        createdAt: { $gte: salesOverviewStart, $lte: salesOverviewEnd }
      }
    },
    {
      $group: {
        _id: {
          $dateToString: {
            format: "%Y-%m-%d",
            date: "$createdAt",
            timezone: "Asia/Kolkata"
          }
        },
        revenue: { $sum: "$grandTotal" },
        orders: { $sum: 1 }
      }
    },
    { $sort: { _id: 1 } }
  ]);

  const salesMap = (salesOverviewAgg || []).reduce((acc, row) => {
    acc[row._id] = {
      revenue: row.revenue || 0,
      orders: row.orders || 0
    };
    return acc;
  }, {});

  const salesOverviewChart = [];

  for (
    let d = new Date(salesOverviewStart);
    d <= salesOverviewEnd;
    d.setDate(d.getDate() + 1)
  ) {
    const key = formatLocalDate(d);

    salesOverviewChart.push({
      _id: key,
      revenue: salesMap[key]?.revenue || 0,
      orders: salesMap[key]?.orders || 0
    });
  }

  /* =========================
     FINAL RESPONSE
  ========================= */
  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Dashboard data fetched successfully",
    data: {
      totalUsers,
      userGrowthPercent,
      liveOrders,
      pendingDelivery,
      revenue,
      revenueChangePercent,
      orderStatusDistribution,
      salesOverviewChart
    }
  });
});