const User = require("../../models/userModel");
const Order = require("../../models/orderModel");
const { catchAsyncError } = require("../../utils/generateError");
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");
const getPagination = require("../../utils/getPagination");
const partyService = require("../../integrations/petpooja/services/partyService");

const syncUserToPetpooja = async (user) => {
  if (user.petpoojaCustomerId) {
    try {
      if (user.status === "Deleted") {
        await partyService.deleteCustomer(user.petpoojaCustomerId);
        // Clear the ID after successful deletion from Petpooja
        user.petpoojaCustomerId = null;
        await user.save();
        console.log(`[PETPOOJA] Successfully deleted User: ${user._id} from Petpooja`);
      } else {
        await partyService.updateCustomer(user.petpoojaCustomerId, user);
        console.log(`[PETPOOJA] Successfully synced updates for User: ${user._id}`);
      }
    } catch (error) {
      console.error(`[PETPOOJA] Failed to sync/delete User: ${user._id}. Error: ${error.message}`);
    }
  }
};



exports.addUserByAdmin = catchAsyncError(async (req, res) => {
  const { phone, status, notes } = req.body;

  // Validation: Phone required
  if (!phone) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Phone number is required",
    });
  }

  // Check if user already exists
  const existingUser = await User.findOne({ phone });

  if (existingUser) {
    if (existingUser.status === "Deleted") {
      // Purana user deleted hai -> naya user create karenge

      // ShortId generate karo (aggregation se)
      const lastUser = await User.aggregate([
        { $match: { shortId: { $regex: /^U-\d+$/ } } },
        {
          $addFields: {
            numericShortId: { $toInt: { $substr: ["$shortId", 2, -1] } },
          },
        },
        { $sort: { numericShortId: -1 } },
        { $limit: 1 },
      ]);

      const newShortId =
        lastUser.length > 0
          ? `U-${lastUser[0].numericShortId + 1}`
          : "U-1";

      const user = new User({
        shortId: newShortId,
        phone,
        status,
        notes,
      });

      let petpoojaId;
      try {
        petpoojaId = await partyService.createCustomer(user);
        user.petpoojaCustomerId = petpoojaId;
      } catch (petpoojaError) {
        return responseHandler({
          res,
          code: statusCode.ERROR,
          message: "Failed to create user in Petpooja. Aborting registration.",
        });
      }

      try {
        await user.save();
      } catch (dbError) {
        await partyService.rollbackCustomerCreation(petpoojaId);
        return responseHandler({
          res,
          code: statusCode.ERROR,
          message: "Database error during registration. Petpooja creation rolled back.",
        });
      }

      return responseHandler({
        res,
        code: statusCode.CREATED,
        message: "User recreated successfully",
        data: { user },
      });
    } else if (existingUser.status === "Blocked") {
      //  User blocked hai -> naya user create nahi hoga
      return responseHandler({
        res,
        code: statusCode.FORBIDDEN,
        message: "Your account is blocked, please contact support",
      });
    } else {
      //  Active user already exists
      return responseHandler({
        res,
        code: statusCode.CONFLICT,
        message: "Phone number already registered with an active user",
      });
    }
  }

  //  Agar user DB me nahi hai -> naya user create karenge
  const lastUser = await User.aggregate([
    { $match: { shortId: { $regex: /^U-\d+$/ } } },
    {
      $addFields: {
        numericShortId: { $toInt: { $substr: ["$shortId", 2, -1] } },
      },
    },
    { $sort: { numericShortId: -1 } },
    { $limit: 1 },
  ]);

  const newShortId =
    lastUser.length > 0 ? `U-${lastUser[0].numericShortId + 1}` : "U-1";

  const user = new User({
    shortId: newShortId,
    phone,
    status,
    notes,
  });

  let petpoojaId;
  try {
    petpoojaId = await partyService.createCustomer(user);
    user.petpoojaCustomerId = petpoojaId;
  } catch (petpoojaError) {
    return responseHandler({
      res,
      code: statusCode.ERROR,
      message: "Failed to create user in Petpooja. Aborting registration.",
    });
  }

  try {
    await user.save();
  } catch (dbError) {
    await partyService.rollbackCustomerCreation(petpoojaId);
    return responseHandler({
      res,
      code: statusCode.ERROR,
      message: "Database error during registration. Petpooja creation rolled back.",
    });
  }

  return responseHandler({
    res,
    code: statusCode.CREATED,
    message: "User created successfully",
    data: { user },
  });
});

exports.updateUserStatus = catchAsyncError(async (req, res) => {
  const { userId } = req.params;
  const { status } = req.body
  if (!["Active", "Blocked", "Deleted"].includes(status)) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid status. Valid status are Active, Blocked, Deleted",
    });
  }

  const user = await User.findById(userId);
  if (!user) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "User not found",
    });
  }

  // Step 2: Check if already in same status
  if (user.status === status) {
    return responseHandler({
      res,
      code: statusCode.SUCCESS,
      message: `User is already in status '${status}'`,
      // data: user,
    });
  }

  // Step 3: Update only if status different
  user.status = status;
  await user.save();
  await syncUserToPetpooja(user);

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: `User status updated to ${status}`,
    data: user,
  });
});

exports.getActiveBlockedUsers = catchAsyncError(async (req, res) => {
  const { status, search, page = 1, limit = 10 } = req.query;

  let filter = {};

  // Status filter
  if (status === "Active") {
    filter.status = "Active";
  } else if (status === "Blocked") {
    filter.status = "Blocked";
  } else {
    filter.status = { $in: ["Active", "Blocked"] };
  }

  // Search filter
  if (search) {
    filter.phone = { $regex: search, $options: "i" };
  }

  // ✅ Count all users (without search) → Total users always same
  const overallCounts = await User.aggregate([
    { $match: { status: { $in: ["Active", "Blocked"] } } },
    { $group: { _id: "$status", count: { $sum: 1 } } }
  ]);

  // Calculate percentages + growth from last month
  const now = new Date();
  const lastMonthStart = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  lastMonthStart.setHours(0, 0, 0, 0);
  const lastMonthEnd = new Date(now.getFullYear(), now.getMonth(), 0);
  lastMonthEnd.setHours(23, 59, 59, 999);

  const lastMonthCounts = await User.aggregate([
    {
      $match: {
        status: { $in: ["Active", "Blocked"] },
        createdAt: { $lte: lastMonthEnd }
      }
    },
    { $group: { _id: "$status", count: { $sum: 1 } } }
  ]);



  let activeUsers = 0;
  let blockedUsers = 0;
  let totalUsers = 0;
  let lastMonthActiveUsers = 0;
  let lastMonthBlockedUsers = 0;
  let lastMonthTotalUsers = 0;

  overallCounts.forEach(c => {
    if (c._id === "Active") activeUsers = c.count;
    if (c._id === "Blocked") blockedUsers = c.count;
  });
  lastMonthCounts.forEach(c => {
    if (c._id === "Active") lastMonthActiveUsers = c.count;
    if (c._id === "Blocked") lastMonthBlockedUsers = c.count;
  });

  totalUsers = activeUsers + blockedUsers;
  lastMonthTotalUsers = lastMonthActiveUsers + lastMonthBlockedUsers;
  
  const totalGrowth = totalUsers - lastMonthTotalUsers;
  const activeGrowth = activeUsers - lastMonthActiveUsers;
  const blockedGrowth = blockedUsers - lastMonthBlockedUsers;

  const totalGrowthPercentage = lastMonthTotalUsers > 0 ? parseFloat(((totalGrowth / lastMonthTotalUsers) * 100).toFixed(2)) : 0;
  const activeGrowthPercentage = lastMonthActiveUsers > 0 ? parseFloat(((activeGrowth / lastMonthActiveUsers) * 100).toFixed(2)) : 0;
  const blockedGrowthPercentage = lastMonthBlockedUsers > 0 ? parseFloat(((blockedGrowth / lastMonthBlockedUsers) * 100).toFixed(2)) : 0;

  // Calculate new users this month
  const thisMonthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  thisMonthStart.setHours(0, 0, 0, 0);
  const newUsersThisMonth = await User.countDocuments({
    status: { $in: ["Active", "Blocked"] },
    createdAt: { $gte: thisMonthStart }
  });

  const newUsersLastMonth = await User.countDocuments({
    status: { $in: ["Active", "Blocked"] },
    createdAt: { $gte: lastMonthStart, $lte: lastMonthEnd }
  });

  const newUsersGrowthPercentage =
    newUsersLastMonth === 0
      ? (newUsersThisMonth > 0 ? 100 : 0)
      : parseFloat((((newUsersThisMonth - newUsersLastMonth) / newUsersLastMonth) * 100).toFixed(2));

  const activeRatePercentage =
    totalUsers > 0 ? parseFloat(((activeUsers / totalUsers) * 100).toFixed(2)) : 0;
  const blockedRatePercentage =
    totalUsers > 0 ? parseFloat(((blockedUsers / totalUsers) * 100).toFixed(2)) : 0;

  // ✅ Count based on search/filter
  const filteredCounts = await User.countDocuments(filter);

  // ✅ Pagination applied on search/filter result
  const { skip, limitNum } = getPagination(page, limit);

  let users = await User.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(limitNum);

  // Add delivered orders count for each user  
  const usersWithOrderCount = await Promise.all(
    users.map(async (user) => {
      const deliveredOrdersCount = await Order.countDocuments({
        userId: user._id,
        status: "Delivered"
      });
      const lastOrder = await Order.findOne({
        userId: user._id
      }).sort({ createdAt: -1 }).select('createdAt');

      return {
        ...user.toObject(),
        deliveredOrdersCount,
        lastOrderDate: lastOrder ? lastOrder.createdAt : null
      };
    })
  );

  // ✅ If search result is less than limit → force page=1
  let currentPage = parseInt(page);
  let totalPages = Math.ceil(filteredCounts / limitNum) || 1;

  if (search && filteredCounts <= limitNum) {
    currentPage = 1;
    totalPages = 1;
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Users fetched successfully",
    data: {
      counts: {
        Total: totalUsers,
        Active: activeUsers,
        Blocked: blockedUsers,
        growth: {
          // Cards-friendly percentages
          total: totalGrowthPercentage,   // "from last month" (total users growth)
          active: activeRatePercentage,   // "active rate"
          blocked: blockedRatePercentage, // "% of total users"
          newUsers: newUsersGrowthPercentage,

          // Extra (if needed elsewhere)
          activeFromLastMonth: activeGrowthPercentage,
          blockedFromLastMonth: blockedGrowthPercentage
        },
        newUsersThisMonth,
        newUsersLastMonth,
        searchResultCount: filteredCounts, // 👈 search ke result ka count
        totalPages,
        currentPage,
        limit: limitNum,
      },
      users: usersWithOrderCount,
    },
  });
});

exports.editUserByAdmin = catchAsyncError(async (req, res) => {
  const { id } = req.query;
  const { phone, status, notes } = req.body;

  if (!id) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "User id is required",
    });
  }

  const user = await User.findOne({ _id: id });

  if (!user) {
    return responseHandler({
      res,
      code: statusCode.NOTFOUND,
      message: "User not found",
    });
  }


  if (phone) user.phone = phone;
  if (status) user.status = status;
  if (notes) user.notes = notes;


  await user.save();
  await syncUserToPetpooja(user);

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "User updated successfully",
    data: {
      user
      // userId: user.shortId,
      // phone: user.phone,
      // status: user.status,
      // notes: user.notes,
      // registrationDate: user.createdAt,
      // lastOrder: user.lastOrderDate,
      // totalOrders: user.totalOrders,
    },
  });
});

exports.viewUserByAdmin = catchAsyncError(async (req, res) => {
  const { id } = req.query;

  const user = await User.findOne({ _id: id });

  if (!user) {
    return responseHandler({
      res,
      code: statusCode.NOTFOUND,
      message: "User not found",
    });
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "User details fetched",
    data: {
      user
      // userId: user.shortId,
      // phone: user.phone,
      // status: user.status,
      // notes: user.notes,
      // registrationDate: user.createdAt,
      // lastOrder: user.lastOrderDate,
      // totalOrders: user.totalOrders,
    },
  });
});

exports.softDeleteUserByAdmin = catchAsyncError(async (req, res) => {
  const { userId } = req.query

  const user = await User.findById(userId);

  if (!user) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "User not found",
    });
  }

  // Mark account as deleted
  user.status = "Deleted";
  // Remove all devices (logout from everywhere)
  user.devices = [];

  await user.save();
  await syncUserToPetpooja(user);

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "User deleted successfully by admin",
    data: { user },
  });
});
