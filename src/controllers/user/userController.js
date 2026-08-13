//models
const User = require("../../models/userModel");
const DRIVER = require("../../models/driverModel");
const Category = require("../../models/categorySubCategoryModel");
const Product = require("../../models/productModel");
const Cart = require("../../models/cartModel");
const Issue = require("../../models/issueModel");
const FreeItemRule = require("../../models/freeItemRuleModel");
const DeliveryOrderConfig = require("../../models/deliveryConfigModel");
const Coupons = require("../../models/promotionsAndCouponModal");
const CouponUsage = require("../../models/couponUsageModel");
const Zone = require("../../models/deliveryZonesModel");
const Order = require("../../models/orderModel");
const { DeliverySlot } = require("../../models/deliverySlotModel");
const Banner = require("../../models/bannerModel");
const Notification = require("../../models/notificationModel");
const NotificationRead = require("../../models/notificationReadModel");
const SearchHistory = require("../../models/searchHistoryModel");
const notificationQueue = require("../../queues/notificationQueue");
const mongoose = require("mongoose");

//utils
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");
const { catchAsyncError } = require("../../utils/generateError");
const { generateOtp } = require("../../utils/otpGenerator");
const { generateUserToken } = require("../../utils/tokenUtils");
const msg91 = require("../../config/msg91");
const partyService = require("../../integrations/petpooja/services/partyService");
const {
  calculateExpectedDeliveryDate,
  getDeliveryTag,
} = require("../../utils/deliveryDateCalculator");
const { validateCartStockWithPetpooja } = require("../../helpers/stockSyncHelper");
const { getAutoApplicableCoupon } = require("../../helpers/autoCouponHelper");
const {
  restoreOrderItemsStock,
} = require("../../services/stockReservationService");
const { processFullOrderCancelRefund } = require("../../services/razorpayRefundService");
const {
  filterProductsForUser,
  filterBannerProducts,
  filterProductsByBannerVariation,
} = require("../../utils/productVariationFilter");

const TEST_USER_NUMBERS = ["9999999991"];
const TEST_OTP = "12345";

const sanitizePhone = (phone) => String(phone || "").replace(/\D/g, "");

const sendOtpViaMsg91IfConfigured = async (phone, otp) => {
  if (!msg91.isConfigured()) return;

  try {
    await msg91.sendOtp(phone, otp);
  } catch (error) {
    const upstreamMessage =
      error.response?.data?.message ||
      error.response?.data?.type ||
      error.message ||
      "Failed to send OTP";

    throw new Error(`MSG91 OTP failed: ${upstreamMessage}`);
  }
};

const syncUserToPetpooja = async (user) => {
  if (user.petpoojaCustomerId) {
    try {
      if (user.status === "Deleted") {
        await partyService.deleteCustomer(user.petpoojaCustomerId);
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

//limit sending otp btw expiry time is 2mins
exports.sendOtp = catchAsyncError(async (req, res) => {
  const normalizedPhone = sanitizePhone(req.body.phone);
  if (!normalizedPhone) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Phone number is required",
    });
  }

  // Generate OTP (5 digits or your preferred logic)
  // const otp = generateOtp();
  const otp = TEST_USER_NUMBERS.includes(normalizedPhone)
    ? "1234"
    : generateOtp();

  // Check Active user first
  let activeUser = await User.findOne({ phone: normalizedPhone, status: "Active" }).sort({
    createdAt: -1,
  });
  if (activeUser) {
    activeUser.otp = otp;
    await activeUser.save();

    // await sendOtpViaMsg91IfConfigured(normalizedPhone, otp);
    if (!TEST_USER_NUMBERS.includes(normalizedPhone)) {
      await sendOtpViaMsg91IfConfigured(normalizedPhone, otp);
    }

    return responseHandler({
      res,
      code: statusCode.SUCCESS,
      message: "OTP sent successfully",
      data: { phone: normalizedPhone },
    });
  }
  // 🚫 Case 2: User exists and status = "Blocked"
  let blockedUser = await User.findOne({ phone: normalizedPhone, status: "Blocked" });
  if (blockedUser) {
    return responseHandler({
      res,
      code: statusCode.FORBIDDEN,
      message: "Your account has been blocked. Please contact admin.",
    });
  }
  // 2️⃣ If no Active, check Deleted user → create new
  let deletedUser = await User.findOne({ phone: normalizedPhone, status: "Deleted" });
  if (deletedUser) {
    // Generate new shortId
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

    const newUser = new User({
      phone: normalizedPhone,
      shortId: newShortId,
      status: "Active",
      otp,
    });

    try {
      await newUser.save();
    } catch (dbError) {
      return responseHandler({
        res,
        code: statusCode.ERROR,
        message: "Database error during registration.",
      });
    }

    // await sendOtpViaMsg91IfConfigured(normalizedPhone, otp);
    if (!TEST_USER_NUMBERS.includes(normalizedPhone)) {
  await sendOtpViaMsg91IfConfigured(normalizedPhone, otp);
}

    return responseHandler({
      res,
      code: statusCode.SUCCESS,
      message: "OTP sent successfully.",
      data: { phone: normalizedPhone },
    });
  }

  // 🆕 Case 4: No user found → create new user and send OTP
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

  const newUser = new User({
    phone: normalizedPhone,
    shortId: newShortId,
    otp,
    status: "Active",
  });

  try {
    await newUser.save();
  } catch (dbError) {
    return responseHandler({
      res,
      code: statusCode.ERROR,
      message: "Database error during registration.",
    });
  }

  // await sendOtpViaMsg91IfConfigured(normalizedPhone, otp);
  if (!TEST_USER_NUMBERS.includes(normalizedPhone)) {
  await sendOtpViaMsg91IfConfigured(normalizedPhone, otp);
}

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "OTP sent successfully",
    data: { phone: normalizedPhone },
  });
});
exports.Login = catchAsyncError(async (req, res) => {
  console.log("Login request body:", req.body); // Debug log
  const { otp, deviceToken, deviceType } = req.body;
  const normalizedPhone = sanitizePhone(req.body.phone);
  if (!normalizedPhone || !otp) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Phone, OTP are required",
    });
  }

  const user = await User.findOne({ phone: normalizedPhone, status: "Active" });

  if (!user) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "User not found. Please request OTP again.",
    });
  }

  // 🚫 Blocked User
  if (user.status === "Blocked") {
    return responseHandler({
      res,
      code: statusCode.FORBIDDEN,
      message: "Your account has been blocked. Please contact admin.",
    });
  }

  // 🧹 Deleted User (should have recreated in sendOtp)
  if (user.status === "Deleted") {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message:
        "Account was deleted and recreated. Please verify using the new OTP sent to your phone.",
    });
  }

  // ✅ Active User → verify OTP
  if (user.status === "Active") {
    // if (msg91.isConfigured()) {
    //   try {
    //     await msg91.verifyOtp(normalizedPhone, otp);
    //   } catch (error) {
    //     return responseHandler({
    //       res,
    //       code: statusCode.DATAMISSING,
    //       message: "Invalid OTP",
    //       error: error.response?.data?.message || error.message,
    //     });
    //   }
    // } else if (user.otp !== otp) {
    //   return responseHandler({
    //     res,
    //     code: statusCode.DATAMISSING,
    //     message: "Invalid OTP",
    //   });
    // }
    const isTestUser = TEST_USER_NUMBERS.includes(normalizedPhone);

if (isTestUser) {
  if (otp !== TEST_OTP) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid OTP",
    });
  }
} else if (msg91.isConfigured()) {
  try {
    await msg91.verifyOtp(normalizedPhone, otp);
  } catch (error) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid OTP",
      error: error.response?.data?.message || error.message,
    });
  }
} else if (user.otp !== otp) {
  return responseHandler({
    res,
    code: statusCode.DATAMISSING,
    message: "Invalid OTP",
  });
}

    // OTP verified → clear OTP and generate token
    user.otp = null;
    const token = generateUserToken(user);

    let currentDevice = null;

    // Handle device registration/update
    if (deviceToken && deviceType) {
      // Initialize devices array if it doesn't exist
      if (!user.devices) {
        user.devices = [];
      }

      // Check if device already exists (by deviceToken)
      const existingDeviceIndex = user.devices.findIndex(
        (device) => device.deviceToken === deviceToken,
      );

      if (existingDeviceIndex !== -1) {
        // Update existing device
        user.devices[existingDeviceIndex].accessToken = token;
        user.devices[existingDeviceIndex].deviceType = deviceType;
        currentDevice = user.devices[existingDeviceIndex];
      } else {
        const newDevice = {
          deviceType: deviceType,
          deviceToken: deviceToken,
          accessToken: token,
        };
        // Add new device
        user.devices.push(newDevice);
        currentDevice = newDevice;
      }
    }

    await user.save();

    // Sync Customer on Login is no longer fire-and-forget here, 
    // it's handled synchronously in sendOtp when the user is created.
    // If we need to sync existing users who don't have an ID, we can do it here synchronously:
    if (!user.petpoojaCustomerId) {
      try {
        const petpoojaId = await partyService.createCustomer(user);
        user.petpoojaCustomerId = petpoojaId;
        await user.save();
      } catch (error) {
        // If it fails on login for an existing user, we might want to block login, or just log it.
        // Based on "if user creation failed on petpooja side then we send error and dont proceed",
        // we should probably block login here if they don't have an ID and we fail to create one.
        return responseHandler({
          res,
          code: statusCode.ERROR,
          message: "Failed to sync user to Petpooja during login.",
        });
      }
    }

    // Response: device with accessToken only when deviceToken was sent in payload (no separate accessToken)
    const responseData = user.toObject ? user.toObject() : { ...user };
    responseData.devices = currentDevice
      ? {
        deviceType: currentDevice.deviceType,
        deviceToken: currentDevice.deviceToken,
        accessToken: currentDevice.accessToken,
      }
      : null;
    responseData.accessToken = currentDevice
      ? currentDevice.accessToken
      : token;

    return responseHandler({
      res,
      code: statusCode.SUCCESS,
      message: "Login successful",
      data: responseData,
    });
  }
});
exports.mergeGuestCart = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const guestItems = req.body.items;
  let userCart = await Cart.findOne({ userId });
  if (!userCart) {
    userCart = new Cart({ userId, items: [] });
  }
  for (let i = 0; i < guestItems.length; i++) {
    const gItem = guestItems[i];

    const product = await Product.findById(gItem.productId).lean();

    // if (!product) continue;

    // const variation = product.productVariations.find(
    //   (v) => v._id.toString() === gItem.variationId
    // );

    if (!product || product.isDeleted) continue;

    const variation = product.productVariations.find(
      (v) => v._id.toString() === gItem.variationId && !v.isDeleted, // ✅ ADD THIS
    );

    if (!variation) continue;

    const price = variation.sellingPrice;
    const quantity = Number(gItem.quantity) || 0;
    const totalPrice = price * quantity;

    let existing = userCart.items.find(
      (it) =>
        it.productId.toString() === gItem.productId &&
        it.variationId.toString() === gItem.variationId,
    );

    if (existing) {
      existing.quantity += quantity;
      existing.totalPrice = existing.quantity * existing.price;
    } else {
      userCart.items.push({
        productId: gItem.productId,
        variationId: gItem.variationId,
        quantity,
        price,
        totalPrice,
      });
    }
  }
  // guestItems.forEach(gItem => {
  //   let existing = userCart.items.find(
  //     it => it.productId == gItem.productId && it.variationId == gItem.variationId
  //   );

  //   if (existing) {
  //     existing.quantity += gItem.quantity;
  //   } else {
  //     userCart.items.push(gItem);
  //   }
  // });
  await userCart.save();
  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Guest cart merged successfully",
    data: userCart,
  });
});
exports.addAddress = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const {
    fullName,
    area_building,
    houseFlatOfficeNo,
    location,
    callingCode,
    countryCode,
    phoneNumber,
    isDefault,
    deliveryInstructions,
    addressType,
  } = req.body;

  const requiredFields = {
    fullName,
    area_building,
    houseFlatOfficeNo,
    location,
    countryCode,
    phoneNumber,
    addressType,
  };

  // ✅ Check for missing fields dynamically
  const missing = Object.keys(requiredFields).filter(
    (key) => !requiredFields[key],
  );

  if (missing.length > 0) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: `Missing fields: ${missing.join(", ")}`,
    });
  }
  const userPincode = location?.pincode;
  if (!userPincode) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Pincode is required inside location",
    });
  }
  const zone = await Zone.findOne({
    "locations.pin": userPincode,
    status: "Active",
  });
  if (!zone) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: `We do not service the pincode ${userPincode}. Please try different pincode within Agra.`,
    });
  }
  const user = await User.findById(userId);
  if (!user) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "User not found",
    });
  }
  console.log("User found:", user);
  // If this is the user's first address, force it to be default.
  // Otherwise, respect incoming isDefault flag.
  let shouldSetDefault = isDefault;
  if (user.addresses.length === 0) {
    shouldSetDefault = true;
  } else if (isDefault) {
    user.addresses.forEach((addr) => {
      addr.isDefault = false;
      addr.isSelected = false;
    });
  }
  const newAddress = {
    fullName,
    area_building,
    houseFlatOfficeNo,
    location,
    callingCode,
    countryCode,
    phoneNumber,
    isDefault: shouldSetDefault,
    isSelected: shouldSetDefault,
    deliveryInstructions,
    addressType: addressType || "Home",
  };
  user.addresses.push(newAddress);
  await user.save();
  await syncUserToPetpooja(user);

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Address added successfully",
    data: { user },
  });
});
exports.editAddress = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const { addressId } = req.query;
  const {
    fullName,
    area_building,
    houseFlatOfficeNo,
    location,
    callingCode,
    countryCode,
    phoneNumber,
    isDefault,
    deliveryInstructions,
    addressType,
  } = req.body;

  const user = await User.findById(userId);
  if (!user) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "User not found",
    });
  }

  const targetAddress = user.addresses.find(
    (addr) => addr._id.toString() === addressId,
  );

  if (!targetAddress) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Address not found",
    });
  }

  if (isDefault) {
    user.addresses.forEach((addr) => {
      addr.isDefault = false;
      addr.isSelected = false;
    });
    targetAddress.isDefault = true;
    targetAddress.isSelected = true;
  }

  //  Update only provided fields
  if (fullName !== undefined) targetAddress.fullName = fullName;
  if (area_building !== undefined) targetAddress.area_building = area_building;
  if (houseFlatOfficeNo !== undefined)
    targetAddress.houseFlatOfficeNo = houseFlatOfficeNo;
  if (location !== undefined) targetAddress.location = location;
  if (callingCode !== undefined) targetAddress.callingCode = callingCode;
  if (countryCode !== undefined) targetAddress.countryCode = countryCode;
  if (phoneNumber !== undefined) targetAddress.phoneNumber = phoneNumber;
  if (deliveryInstructions !== undefined)
    targetAddress.deliveryInstructions = deliveryInstructions;
  if (addressType !== undefined) targetAddress.addressType = addressType;

  await user.save();
  await syncUserToPetpooja(user);

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Address updated successfully",
    data: targetAddress,
  });
});

exports.deleteAddress = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const { addressId } = req.query; // e.g. DELETE /user/address/:addressId

  const user = await User.findById(userId);
  if (!user) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "User not found",
    });
  }

  // find the address manually
  const targetAddress = user.addresses.find(
    (addr) => addr._id.toString() === addressId,
  );

  if (!targetAddress) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Address not found",
    });
  }

  // ❌ Block deletion if it's default
  if (targetAddress.isDefault) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message:
        "Please set another address as default before deleting this one.",
    });
  }

  // ✅ Delete address manually
  user.addresses = user.addresses.filter(
    (addr) => addr._id.toString() !== addressId,
  );

  await user.save();
  await syncUserToPetpooja(user);

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Address deleted successfully",
    data: targetAddress,
  });
});
exports.setDefaultAddress = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const { addressId } = req.query;
  if (!addressId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "addressId is required",
    });
  }
  const user = await User.findById(userId);
  if (!user) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "User not found",
    });
  }
  const targetAddress = user.addresses.find(
    (addr) => addr._id.toString() === addressId,
  );
  if (!targetAddress) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Address not found",
    });
  }
  user.addresses.forEach((addr) => {
    addr.isDefault = false;
    addr.isSelected = false;
  });
  targetAddress.isDefault = true;
  targetAddress.isSelected = true;
  await user.save();
  await syncUserToPetpooja(user);
  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Default address updated successfully",
    data: targetAddress,
  });
});
exports.logout = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const user = await User.findById(userId);
  if (!user) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "User not found",
    });
  }
  const authHeader = req.header("Authorization");

  const token = authHeader?.startsWith("Bearer ")
    ? authHeader.split(" ")[1]
    : authHeader;

  if (user.devices && user.devices.length > 0) {
    user.devices = user.devices.filter(
      (device) => device.accessToken !== token,
    );
  }
  await user.save();

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Logout successful",
  });
});
exports.deleteAccount = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const user = await User.findById(userId);
  if (!user) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "User not found",
    });
  }
  // mark account deleted
  user.status = "Deleted";
  // remove all devices (logout from everywhere)
  user.devices = [];

  await user.save();
  await syncUserToPetpooja(user);

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Account deleted successfully",
    data: user,
  });
});
exports.getProfile = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const user = await User.findById(userId).select(
    "_id shortId phone notes status addresses createdAt updatedAt profileImage",
  );
  if (!user) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "User not found",
    });
  }
  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Profile fetched successfully",
    data: user,
  });
});
exports.getAllAddress = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const user = await User.findById(userId).select("addresses");
  if (!user) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "User not found",
    });
  }
  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Addresses fetched successfully",
    data: user ? user.addresses : [],
  });
});
exports.selectAddress = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const { addressId } = req.query;

  if (!addressId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "addressId is required",
    });
  }

  const user = await User.findById(userId);
  if (!user) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "User not found",
    });
  }

  const targetAddress = user.addresses.find(
    (addr) => addr._id.toString() === addressId,
  );

  if (!targetAddress) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Address not found",
    });
  }

  // Set all addresses isSelected to false
  user.addresses.forEach((addr) => {
    addr.isSelected = false;
  });

  // Set selected address isSelected to true (without changing isDefault)
  targetAddress.isSelected = true;

  await user.save();

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Address selected successfully",
    data: targetAddress,
  });
});
exports.getSubcategoriesByCategory = catchAsyncError(async (req, res) => {
  const { categoryId } = req.query;

  if (!categoryId || !mongoose.Types.ObjectId.isValid(categoryId)) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Valid categoryId is required",
    });
  }

  const category = await Category.findById(categoryId).select(
    "subCategories categoryName",
  );

  if (!category) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Category not found",
    });
  }

  // Filter subcategories that have products
  const subcategoriesWithProducts = [];

  const sortedSubCategories = category.subCategories
    .filter((sub) => sub.status === "Active")
    .sort((a, b) => a.sortOrder - b.sortOrder);

  for (const subCategory of sortedSubCategories) {
    if (subCategory.status === "Active") {
      const hasProducts = await Product.exists({
        categoryId: categoryId,
        subcategoryId: subCategory._id,
        isDeleted: { $ne: true },
        productVariations: {
          $elemMatch: { isDeleted: { $ne: true } }
        },
      });

      if (hasProducts) {
        subcategoriesWithProducts.push(subCategory);
      }
    }
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Subcategories fetched successfully",
    data: {
      categoryId,
      categoryName: category.categoryName,
      subCategories: subcategoriesWithProducts,
    },
  });
});
exports.getProductsByCategoryAndSubcategory = catchAsyncError(
  async (req, res) => {
    const { categoryId, subcategoryId } = req.query;

    if (!categoryId) {
      return responseHandler({
        res,
        code: statusCode.DATAMISSING,
        message: "categoryId is required",
      });
    }

    if (!mongoose.Types.ObjectId.isValid(categoryId)) {
      return responseHandler({
        res,
        code: statusCode.DATAMISSING,
        message: "Invalid category ID",
      });
    }

    // Check if subcategoryId is provided and valid
    if (subcategoryId && !mongoose.Types.ObjectId.isValid(subcategoryId)) {
      return responseHandler({
        res,
        code: statusCode.DATAMISSING,
        message: "Invalid subcategory ID",
      });
    }

    // Ensure category exists
    const category = await Category.findById(categoryId);
    if (!category) {
      return responseHandler({
        res,
        code: statusCode.RESULTNOTFOUND,
        message: "Category not found",
      });
    }

    // If subcategoryId is provided, validate it exists in this category
    let subcategoryName = null;
    if (subcategoryId) {
      const subcategory = category.subCategories.find(
        (sub) => sub._id.toString() === subcategoryId,
      );

      if (!subcategory) {
        return responseHandler({
          res,
          code: statusCode.RESULTNOTFOUND,
          message: "Subcategory not found in this category",
        });
      }
      subcategoryName = subcategory.subCategoryName;
    }
    // Build query based on provided parameters
    // Ensure we only fetch active (non-deleted) products
    let query = { categoryId, isDeleted: { $ne: true } };

    // Only add subcategoryId filter if it's provided
    if (subcategoryId) {
      query.subcategoryId = subcategoryId;
    }

    const products = await Product.find(query).sort({ createdAt: -1 });
    const filteredProducts = filterProductsForUser(products);

    return responseHandler({
      res,
      code: statusCode.SUCCESS,
      message: subcategoryId
        ? "Products fetched successfully for specific subcategory"
        : "Products fetched successfully for category",
      data: {
        categoryId,
        categoryName: category.categoryName,
        subcategoryId: subcategoryId || null,
        subcategoryName: subcategoryName || null,
        description: category.description,
        totalProducts: filteredProducts.length,
        products: filteredProducts,
      },
    });
  },
);
exports.getCategoriesWithSubcategoriesAndProducts = catchAsyncError(
  async (req, res) => {
    const {
      categoryIds, // multiple category IDs (comma-separated)
      subCategoryIds, // multiple subcategory IDs (comma-separated)
      availability, // multiple stockStatus values
      discounts, // e.g. "10,40"
      minPrice, // numeric
      maxPrice, // numeric
      sortBy,
    } = req.query;

    // 🔹 Prepare filters
    const categoryFilter = categoryIds
      ? categoryIds.split(",").map((id) => new mongoose.Types.ObjectId(id))
      : null;

    const subCategoryFilter = subCategoryIds
      ? subCategoryIds.split(",").map((id) => new mongoose.Types.ObjectId(id))
      : null;

    const availabilityFilter = availability ? availability.split(",") : null;

    const discountArray = discounts ? discounts.split(",").map(Number) : [];

    const priceMin = minPrice ? Number(minPrice) : null;
    const priceMax = maxPrice ? Number(maxPrice) : null;

    // 🔹 Run aggregation directly (no separate pipeline variable)
    const data = await Category.aggregate([
      ...(categoryFilter ? [{ $match: { _id: { $in: categoryFilter } } }] : []),

      { $unwind: { path: "$subCategories", preserveNullAndEmptyArrays: true } },

      // 🎯 NEW STAGE: Filter by Subcategory ID
      ...(subCategoryFilter
        ? [{ $match: { "subCategories._id": { $in: subCategoryFilter } } }]
        : []),

      {
        $lookup: {
          from: "products",
          let: { categoryId: "$_id", subcategoryId: "$subCategories._id" },
          pipeline: [
            {
              $match: {
                isDeleted: { $ne: true },
                $expr: {
                  $and: [
                    { $eq: ["$categoryId", "$$categoryId"] },
                    { $eq: ["$subcategoryId", "$$subcategoryId"] },
                  ],
                },
              },
            },
            {
              $project: {
                productName: 1,
                gst: 1,
                productVariations: 1,
              },
            },
            { $unwind: "$productVariations" },
            {
              $match: {
                "productVariations.isDeleted": { $ne: true },
                ...(availabilityFilter && {
                  "productVariations.stockStatus": { $in: availabilityFilter },
                }),
                ...(priceMin !== null &&
                  priceMax !== null && {
                  "productVariations.sellingPrice": {
                    $gte: priceMin,
                    $lte: priceMax,
                  },
                }),
                ...(discountArray.length > 0 && {
                  $or: discountArray.map((limit) => ({
                    "productVariations.discountPercent": { $lte: limit },
                  })),
                }),
              },
            },
            {
              $group: {
                _id: "$_id",
                productName: { $first: "$productName" },
                gst: { $first: "$gst" },
                productVariations: { $push: "$productVariations" },
              },
            },
            // 🧩 Apply sorting inside products before returning
            ...(sortBy === "priceLowToHigh"
              ? [{ $sort: { "productVariations.sellingPrice": 1 } }]
              : sortBy === "priceHighToLow"
                ? [{ $sort: { "productVariations.sellingPrice": -1 } }]
                : sortBy === "aToZ"
                  ? [{ $sort: { productName: 1 } }]
                  : sortBy === "zToA"
                    ? [{ $sort: { productName: -1 } }]
                    : sortBy === "newest"
                      ? [{ $sort: { createdAt: -1 } }]
                      : []),
          ],
          as: "subCategories.products",
        },
      },

      {
        $group: {
          _id: "$_id",
          categoryName: { $first: "$categoryName" },
          categoryCode: { $first: "$categoryCode" },
          sortOrder: { $first: "$sortOrder" },
          description: { $first: "$description" },
          categoryImage: { $first: "$categoryImage" },
          status: { $first: "$status" },
          visibility: { $first: "$visibility" },
          subCategories: { $push: "$subCategories" }, // Pushes filtered subcategories (with their products) back into the array
        },
      },

      { $match: { "subCategories.products.0": { $exists: true } } },
      { $sort: { sortOrder: 1 } },
    ]);

    return responseHandler({
      res,
      code: statusCode.SUCCESS,
      message: "Categories fetched successfully",
      data,
    });
  },
);
exports.getAllCategories = catchAsyncError(async (req, res) => {
  const categories = await Category.find().sort({ sortOrder: 1 });
  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Categories fetched successfully",
    data: categories,
  });
});
exports.updateUserImage = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const { profileImage } = req.body;

  const updateData = {};
  if (profileImage) updateData.profileImage = profileImage;

  const updatedUser = await User.findByIdAndUpdate(
    userId,
    { $set: updateData },
    { new: true, runValidators: true },
  );

  if (!updatedUser) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "User not found.",
    });
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "User profile updated successfully.",
    data: updatedUser,
  });
});
exports.addToCart = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const { productId, variationId, quantity } = req.body;
  if (!productId || !variationId || !quantity) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "productId, variationId, and quantity are required.",
    });
  }
  const qty = Number(quantity);
  if (isNaN(qty) || qty <= 0) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid quantity.",
    });
  }
  const user = await User.findById(userId);
  if (!user) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "User not found.",
    });
  }
  const product = await Product.findById(productId);
  // if (!product) {
  //   return responseHandler({
  //     res,
  //     code: statusCode.RESULTNOTFOUND,
  //     message: "Product not found.",
  //   });
  // }
  // const variation = product.productVariations.id(variationId);
  // if (!variation) {
  //   return responseHandler({
  //     res,
  //     code: statusCode.RESULTNOTFOUND,
  //     message: "Variation not found for this product.",
  //   });
  // }

  if (!product || product.isDeleted) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Product not available",
    });
  }

  const variation = product.productVariations.id(variationId);

  // ✅ ADD THIS
  if (!variation || variation.isDeleted) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Variation not available",
    });
  }

  if (qty > variation.stockQuantity) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: `Only ${variation.stockQuantity} items available in stock.`,
    });
  }
  const basePrice = Number(variation.sellingPrice); // Base price (with GST)
  if (isNaN(basePrice)) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Variation selling price is invalid.",
    });
  }
  const totalPrice = basePrice * qty;

  let cart = await Cart.findOne({ userId });
  if (!cart) {
    cart = new Cart({ userId, items: [] });
  }
  //Check if item already exists (same product + variation)
  const existingItem = cart.items.find(
    (item) =>
      item.productId.toString() === productId &&
      item.variationId.toString() === variationId,
  );
  if (existingItem) {
    existingItem.quantity = qty;
    existingItem.totalPrice = existingItem.price * existingItem.quantity;
  } else {
    cart.items.push({
      productId,
      variationId,
      quantity: qty,
      price: basePrice, // price with GST
      totalPrice,
    });
  }

  // Check if coupon should be removed after cart update
  if (cart.appliedCoupon) {
    const coupon = await Coupons.findById(cart.appliedCoupon);
    if (coupon && coupon.minOrderValue) {
      // Calculate new cart total
      let newCartTotal = 0;
      cart.items.forEach((item) => {
        newCartTotal += item.price * item.quantity;
      });

      // If cart total is below coupon's minimum order value, remove coupon
      if (newCartTotal < coupon.minOrderValue) {
        cart.appliedCoupon = null;
      }
    }
  }

  await cart.save();
  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Product added to cart successfully.",
    data: cart,
  });
});
exports.removeFromCart = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const { productId, variationId } = req.body;
  if (!productId || !variationId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "productId and variationId are required.",
    });
  }
  const cart = await Cart.findOne({ userId }).populate("appliedCoupon");
  if (!cart) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Cart not found.",
    });
  }
  const itemIndex = cart.items.findIndex(
    (item) =>
      item.productId.toString() === productId &&
      item.variationId.toString() === variationId,
  );
  if (itemIndex === -1) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Item not found in cart.",
    });
  }
  cart.items.splice(itemIndex, 1);

  // Check if coupon should be removed after item removal
  if (cart.appliedCoupon) {
    // Calculate new cart total
    let newCartTotal = 0;
    cart.items.forEach((item) => {
      newCartTotal += item.price * item.quantity;
    });

    // If cart total is below coupon's minimum order value, remove coupon
    if (
      cart.appliedCoupon.minOrderValue &&
      newCartTotal < cart.appliedCoupon.minOrderValue
    ) {
      cart.appliedCoupon = null;
    }
  }

  await cart.save();
  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Item removed from cart successfully.",
  });
});
exports.getCart = catchAsyncError(async (req, res) => {
  const userId = req.user._id;

  let cart = await Cart.findOne({ userId });
  if (!cart) {
    cart = new Cart({ userId, items: [] });
    await cart.save();
  }

  // 🧩 STEP 1: populate cart items with product + selected variation
  // const populatedItems = await Promise.all(
  //   cart.items.map(async (item) => {
  //     const product = await Product.findById(item.productId)
  //       .lean()
  //       .select("productName gst categoryId subcategoryId productVariations");

  //     if (!product) return null;

  //     const selectedVariation = product.productVariations.find(
  //       (v) => v._id.toString() === item.variationId.toString(),
  //     );

  //     const quantity = Number(item.quantity) || 0;
  //     // sellingPrice already includes GST; fall back to current variation if needed
  //     const price = Number(item.price);
  //     const lineTotal = price * quantity;

  //     return {
  //       _id: item._id,
  //       quantity,
  //       price, // already GST-inclusive
  //       totalPrice: lineTotal,
  //       product: {
  //         _id: product._id,
  //         productName: product.productName,
  //         gst: product.gst,
  //         categoryId: product.categoryId,
  //         subcategoryId: product.subcategoryId,
  //         selectedVariation: selectedVariation
  //           ? {
  //               _id: selectedVariation._id,
  //               productType: selectedVariation.productType,
  //               measurmentUnit: selectedVariation.measurmentUnit,
  //               measurmentValue: selectedVariation.measurmentValue,
  //               mrp: selectedVariation.mrp,
  //               sellingPrice: selectedVariation.sellingPrice, // GST inclusive
  //               discountPercent: selectedVariation.discountPercent,
  //               sku: selectedVariation.sku,
  //               stockQuantity: selectedVariation.stockQuantity,
  //               productImages: selectedVariation.productImages,
  //             }
  //           : null,
  //       },
  //     };
  //   }),
  // );

  const populatedItems = await Promise.all(
    cart.items.map(async (item) => {
      const product = await Product.findById(item.productId)
        .lean()
        .select("productName gst categoryId subcategoryId productVariations");

      // ❌ PRODUCT DELETED / NOT FOUND
      if (!product || product.isDeleted) return null;

      // ❌ VARIATION DELETED / NOT FOUND
      const selectedVariation = product.productVariations.find(
        (v) =>
          v._id.toString() === item.variationId.toString() &&
          !v.isDeleted // ✅ IMPORTANT
      );

      if (!selectedVariation) return null;

      const quantity = Number(item.quantity) || 0;
      const price = Number(item.price);
      const lineTotal = price * quantity;

      return {
        _id: item._id,
        quantity,
        price,
        totalPrice: lineTotal,
        product: {
          _id: product._id,
          productName: product.productName,
          gst: product.gst,
          categoryId: product.categoryId,
          subcategoryId: product.subcategoryId,
          selectedVariation: {
            _id: selectedVariation._id,
            productType: selectedVariation.productType,
            measurmentUnit: selectedVariation.measurmentUnit,
            measurmentValue: selectedVariation.measurmentValue,
            mrp: selectedVariation.mrp,
            sellingPrice: selectedVariation.sellingPrice,
            discountPercent: selectedVariation.discountPercent,
            sku: selectedVariation.sku,
            stockQuantity: selectedVariation.stockQuantity,
            productImages: selectedVariation.productImages,
          },
        },
      };
    })
  );

  const items = populatedItems.filter(Boolean);
  const totalItemsCount = items.reduce((acc, item) => acc + item.quantity, 0);
  // Cart totals are GST-inclusive because sellingPrice is GST-inclusive
  const cartTotal = items.reduce((sum, item) => sum + item.totalPrice, 0);

  // ------------------------------------
  // COUPON LOGIC
  // ------------------------------------
  let appliedCouponInfo = null;
  let couponDiscount = 0;

  if (cart.appliedCoupon) {
    const coupon = await Coupons.findById(cart.appliedCoupon);
    if (coupon && coupon.status === "Active") {
      const now = new Date();
      const validFrom = new Date(coupon.validFrom);
      const validTill = new Date(coupon.validTill);

      const usageRecord = await CouponUsage.findOne({
        userId,
        couponId: coupon._id,
      });
      const usedCountByThisUser = usageRecord ? usageRecord.usedCount : 0;

      if (now >= validFrom && now <= validTill) {
        if (coupon.usageLimit && coupon.usageUsed >= coupon.usageLimit) {
          appliedCouponInfo = {
            couponId: coupon._id,
            couponCode: coupon.couponCode,
            message: "Coupon usage limit reached.",
          };
        } else if (
          coupon.usagePerUser &&
          usedCountByThisUser >= coupon.usagePerUser
        ) {
          appliedCouponInfo = {
            couponId: coupon._id,
            couponCode: coupon.couponCode,
            message: "You have reached your limit for this coupon.",
          };
        } else if (!coupon.minOrderValue || cartTotal >= coupon.minOrderValue) {
          if (coupon.discountType === "Percentage") {
            couponDiscount = (cartTotal * coupon.discountValue) / 100;
            if (coupon.maxDiscount && couponDiscount > coupon.maxDiscount) {
              couponDiscount = coupon.maxDiscount;
            }
            // Never allow discount to exceed cart value.
            couponDiscount = Math.min(couponDiscount, cartTotal);
          } else if (coupon.discountType === "FixedAmount") {
            // Fixed discount is capped to cart value.
            couponDiscount = Math.min(coupon.discountValue, cartTotal);
          } else if (coupon.discountType === "FreeDelivery") {
            couponDiscount = 0;
          }

          appliedCouponInfo = {
            couponId: coupon._id,
            couponCode: coupon.couponCode,
            discountType: coupon.discountType,
            discountValue: parseFloat(couponDiscount.toFixed(2)),
            message: "Coupon applied successfully.",
          };
        } else {
          appliedCouponInfo = {
            couponId: coupon._id,
            couponCode: coupon.couponCode,
            message: `Minimum order value ₹${coupon.minOrderValue} required to use this coupon.`,
          };
        }
      } else {
        appliedCouponInfo = {
          couponId: coupon._id,
          couponCode: coupon.couponCode,
          message: "Coupon expired or not valid currently.",
        };
      }
    }
  } else {
    const { coupon, discount } = await getAutoApplicableCoupon(userId, cart, cartTotal);
    if (coupon && discount > 0) {
      couponDiscount = discount;
      appliedCouponInfo = {
        couponId: coupon._id,
        couponCode: coupon.couponCode,
        discountType: coupon.discountType,
        discountValue: parseFloat(couponDiscount.toFixed(2)),
        message: "Promotion coupon applied automatically.",
        autoApplied: true,
      };
    }
  }

  // -----------------------------
  // 🟢 STEP 4: Get Zone + Delivery Config
  // -----------------------------
  const user = await User.findById(userId).lean();
  let userPincode = null;
  if (user && user.addresses?.length > 0) {
    const selectedAddress =
      user.addresses.find((a) => a.isSelected) ||
      user.addresses.find((a) => a.isDefault);
    userPincode = selectedAddress?.location?.pincode;
  }
  // console.log("🟩 USER PINCODE USED FOR ZONE CHECK:", userPincode);

  let zone = null;
  if (userPincode) {
    zone = await Zone.findOne({
      "locations.pin": userPincode,
      status: "Active",
    }).lean();
  }

  let deliveryConfig = null;
  if (zone) {
    deliveryConfig = await DeliveryOrderConfig.findOne({
      zoneId: zone._id,
      deliveryChargesEnabled: true,
    }).lean();
  }
  // console.log("zone:", zone);

  // 🧾 Delivery Charge Logic
  let deliveryChargeInfo = null;
  let deliveryCharge = 0;

  if (items.length > 0) {
    if (zone && deliveryConfig && deliveryConfig.deliveryChargesEnabled) {
      const range = deliveryConfig.deliveryRanges.find((r) => {
        const minMatch = cartTotal >= r.minAmount;
        const maxMatch = r.maxAmount ? cartTotal <= r.maxAmount : true;
        return minMatch && maxMatch;
      });

      if (range) {
        deliveryCharge = range.deliveryCharge;
        // const maxAmountText = range.maxAmount ? `₹${range.maxAmount}` : "above";
        deliveryChargeInfo = {
          message: `Delivery charge ₹${range.deliveryCharge} applied for your order`,
          deliveryCharge: range.deliveryCharge,
        };
      } else {
        deliveryChargeInfo = {
          message:
            "No applicable delivery charge range found for your order value.",
          deliveryCharge: 0,
        };
      }
    } else {
      if (!zone) {
        deliveryChargeInfo = {
          message:
            "Delivery zone not found for your address pincode. Please add a valid address.",
          deliveryCharge: 0,
        };
      } else if (!deliveryConfig) {
        deliveryChargeInfo = {
          message: "",
          deliveryCharge: 0,
        };
      } else if (!deliveryConfig.deliveryChargesEnabled) {
        deliveryChargeInfo = {
          message: "Delivery charges are not enabled for your zone.",
          deliveryCharge: 0,
        };
      } else {
        deliveryChargeInfo = {
          message: "No delivery charge ranges configured for your zone.",
          deliveryCharge: 0,
        };
      }
    }
  }

  // 🚚 Handle Free Delivery Coupon override
  if (appliedCouponInfo && appliedCouponInfo.discountType === "FreeDelivery") {
    deliveryCharge = 0;
    if (deliveryChargeInfo) {
      deliveryChargeInfo.deliveryCharge = 0;
      deliveryChargeInfo.message = "Free delivery applied via coupon!";
    } else {
      deliveryChargeInfo = {
        message: "Free delivery applied via coupon!",
        deliveryCharge: 0,
      };
    }
  }
  // When cart is empty, deliveryChargeInfo remains null

  // -----------------------------
  // Minimum Order Value Check
  // -----------------------------
  let minOrderInfo = null;

  if (
    deliveryConfig &&
    deliveryConfig.minOrderEnabled &&
    deliveryConfig.minOrderValue
  ) {
    const minOrderValue = parseFloat(deliveryConfig.minOrderValue);
    // console.log("totalWithoutGST log:", totalWithoutGST);
    // console.log("minOrderValue log:", minOrderValue);
    if (cartTotal < minOrderValue) {
      //worked
      const amountToAdd = minOrderValue - cartTotal;
      // console.log("amountToAdd log:", amountToAdd);
      minOrderInfo = {
        message: `Add ₹${amountToAdd.toFixed(
          2,
        )} more to reach the minimum order value of ₹${minOrderValue.toFixed(
          2,
        )}.`,
        minOrderValue,
        amountToAdd: parseFloat(amountToAdd.toFixed(2)),
        zoneName: zone?.zoneName,
      };
    } else {
      minOrderInfo = {
        message: `Minimum order value of ₹${deliveryConfig.minOrderValue} achieved!`,
        minOrderValue: deliveryConfig.minOrderValue,
        zoneName: zone?.zoneName,
      };
    }
  } else {
    if (!zone) {
      minOrderInfo = {
        message:
          "Delivery zone not found for your address pincode. Please add a valid address.",
      };
    } else if (!deliveryConfig) {
      minOrderInfo = {
        message: "No delivery configuration found for your zone.",
      };
    } else if (!deliveryConfig.minOrderEnabled) {
      minOrderInfo = {
        message: "No minimum order limit. You can place order with any amount.",
      };
    } else {
      minOrderInfo = {
        message: "No minimum order limit. You can place order with any amount.",
      };
    }
  }

  // -----------------------------
  // 🟢 STEP 6: Free Item Rule
  // -----------------------------
  const currentDate = new Date();
  const activeRules = await FreeItemRule.find({
    status: "Active",
    validFrom: { $lte: currentDate },
    validUntil: { $gte: currentDate },
  }).populate("freeItems");

  let freeItemInfo = null;

  if (Array.isArray(activeRules) && activeRules.length > 0) {
    const normalizedRules = activeRules
      .map((r) => ({
        rule: r,
        minOrderValue: Number(r.minOrderValue),
        freeQty: Number(r.freeItemQuantity) || 1,
        stock: Number(r.freeItems?.stock ?? 0),
      }))
      .filter((r) => Number.isFinite(r.minOrderValue) && r.rule?.freeItems);

    // Remove rules where free item stock is insufficient
    const eligibleRulesByStock = normalizedRules.filter(
      (r) => r.stock >= r.freeQty,
    );

    // Enforce usage limit per customer (within rule validity window)
    const eligibleRules = await Promise.all(
      eligibleRulesByStock.map(async (r) => {
        const usageLimit = Number(r.rule.usageLimitPerCustomer) || 1;
        const usedCount = await Order.countDocuments({
          userId,
          status: { $nin: ["Cancelled", "PaymentPending"] },
          "freeItem.productId": r.rule.freeItems._id,
          createdAt: { $gte: r.rule.validFrom, $lte: r.rule.validUntil },
        });

        return {
          ...r,
          usageLimit,
          usedCount,
          remainingUses: Math.max(usageLimit - usedCount, 0),
        };
      }),
    );

    const eligibleRulesWithUsage = eligibleRules.filter(
      (r) => r.remainingUses > 0,
    );

    // Pick best unlocked rule (highest minOrderValue <= cartTotal)
    const unlocked = eligibleRulesWithUsage
      .filter((r) => cartTotal >= r.minOrderValue)
      .sort((a, b) => b.minOrderValue - a.minOrderValue);

    if (unlocked.length > 0) {
      const selected = unlocked[0];
      freeItemInfo = {
        message: `You have unlocked a free item!`,
        freeItem: {
          _id: selected.rule.freeItems._id,
          productName: selected.rule.freeItems.productName,
          productImage: selected.rule.freeItems.productImage,
          quantity: String(selected.freeQty),
        },
      };
    } else {
      // No rule unlocked yet: show nearest upcoming rule (lowest minOrderValue above cartTotal)
      const upcoming = eligibleRulesWithUsage
        .filter((r) => cartTotal < r.minOrderValue)
        .sort((a, b) => a.minOrderValue - b.minOrderValue);

      if (upcoming.length > 0) {
        const next = upcoming[0];
        const amountToAdd = Math.max(next.minOrderValue - cartTotal, 0);
        freeItemInfo = {
          message: `Add ₹${amountToAdd.toFixed(2)} more to get ${next.rule.freeItems.productName}`,
          minOrderValue: next.minOrderValue,
          amountToAdd,
        };
      }
    }
  }

  // -----------------------------
  // 🧮 STEP 7: Final total calculation
  // -----------------------------
  const platformFee = deliveryConfig?.platformFee || 0;
  const totalAmount = Math.max(
    cartTotal + deliveryCharge + platformFee - couponDiscount,
    0,
  );

  // Check if user can place order (minimum order validation)
  const canPlaceOrder =
    !minOrderInfo ||
    (minOrderInfo && !minOrderInfo.amountToAdd) ||
    (deliveryConfig &&
      (!deliveryConfig.minOrderEnabled || !deliveryConfig.minOrderValue));

  console.log("🟡 MIN ORDER INFO:", JSON.stringify(minOrderInfo, null, 2));

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Cart fetched successfully.",
    data: {
      _id: cart._id,
      userId: cart.userId,
      items,
      totalItemsCount,
      cartValue: parseFloat(cartTotal.toFixed(2)),
      // totalGSTAmount: parseFloat(totalGSTAmount.toFixed(2)),
      // totalGSTPercent: parseFloat(totalGSTPercent.toFixed(2)),
      deliveryRanges: deliveryConfig?.deliveryRanges || [],
      deliveryChargeInfo,
      appliedCoupon: appliedCouponInfo,
      couponDiscount: parseFloat(couponDiscount.toFixed(2)),
      platformFee: parseFloat(platformFee.toFixed(2)),
      totalAmount: parseFloat(totalAmount.toFixed(2)),
      minOrderInfo,
      freeItemInfo,
      canPlaceOrder,
      createdAt: cart.createdAt,
      updatedAt: cart.updatedAt,
    },
  });
});
exports.placeorder = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const { addressId, cartData, paymentType } = req.body;

  if (!addressId || !cartData || !paymentType) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Address ID, cart data and payment type are required.",
    });
  }

  const cart = await Cart.findOne({ userId }).populate("appliedCoupon");
  console.log("cart.items", cart);
  if (!cart || cart.items.length === 0) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Cart is empty.",
    });
  }

  const user = await User.findById(userId);
  console.log("USER PROFILE IMAGE --->", user.profileImage);
  const address = user.addresses.id(addressId);
  if (!address) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Address not found.",
    });
  }

  // Handle isSelected: If selected address is not default, set it as selected and unselect default
  const defaultAddress = user.addresses.find((addr) => addr.isDefault === true);
  if (!address.isDefault && defaultAddress) {
    // Selected address is not default, so set it as selected and unselect default
    address.isSelected = true;
    defaultAddress.isSelected = false;
    await user.save();
  } else if (address.isDefault) {
    // Selected address is default, ensure it's selected
    address.isSelected = true;
    user.addresses.forEach((addr) => {
      if (addr._id.toString() !== addressId) {
        addr.isSelected = false;
      }
    });
    await user.save();
  }
  const addressPincode = address?.location?.pincode;
  if (!addressPincode) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Address pincode is missing.",
    });
  }
  const activeZone = await Zone.findOne({
    "locations.pin": addressPincode,
    status: "Active",
  });
  if (!activeZone) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: `We currently do not service the pincode ${addressPincode}. Please select another address.`,
    });
  }

  // Build order items from cart and persist GST breakdown per item.
  const cartProductIds = [
    ...new Set(
      (cart.items || []).map((item) => item.productId?.toString()).filter(Boolean),
    ),
  ];
  const productsForOrder = await Product.find({
    _id: { $in: cartProductIds },
  })
    .select("gst productVariations")
    .lean();
  const productGSTMap = new Map(
    productsForOrder.map((product) => [product._id.toString(), Number(product.gst) || 0]),
  );

  const orderItems = cart.items.map((item) => {
    const quantity = Number(item.quantity) || 0;
    const priceWithGST = Number(item.price) || 0; // GST-inclusive unit price
    const gstPercent = productGSTMap.get(item.productId.toString()) || 0;
    const unitBasePrice =
      gstPercent > 0 ? (priceWithGST * 100) / (100 + gstPercent) : priceWithGST;
    const unitGSTAmount = priceWithGST - unitBasePrice;
    const subtotal = priceWithGST * quantity;
    const gstAmount = unitGSTAmount * quantity;

    const product = productsForOrder.find(p => p._id.toString() === item.productId.toString());
    const variation = product?.productVariations?.find(v => v._id.toString() === item.variationId.toString());

    return {
      productId: item.productId,
      variationId: item.variationId,
      quantity,
      basePrice: Number(unitBasePrice.toFixed(2)),
      gstPercent,
      gstAmount: Number(gstAmount.toFixed(2)),
      priceWithGST: Number(priceWithGST.toFixed(2)),
      subtotal: Number(subtotal.toFixed(2)),
      petpoojaItemId: variation?.petpoojaItemId || null,
    };
  });

  // get free item from cartData
  let freeItemData = null;
  if (cartData.freeItem) {
    const freeItem = cartData.freeItem;

    const currentDate = new Date();
    const cartTotal = Number(cartData.cartValue) || 0;

    const candidateRules = await FreeItemRule.find({
      status: "Active",
      validFrom: { $lte: currentDate },
      validUntil: { $gte: currentDate },
      freeItems: freeItem._id,
    }).populate("freeItems");

    const normalizedRules = candidateRules
      .map((r) => ({
        rule: r,
        minOrderValue: Number(r.minOrderValue),
        freeQty: Number(r.freeItemQuantity) || 1,
        stock: Number(r.freeItems?.stock ?? 0),
        usageLimit: Number(r.usageLimitPerCustomer) || 1,
      }))
      .filter(
        (r) =>
          Number.isFinite(r.minOrderValue) &&
          r.rule?.freeItems &&
          r.stock >= r.freeQty,
      );

    const rulesWithUsage = await Promise.all(
      normalizedRules.map(async (r) => {
        const usedCount = await Order.countDocuments({
          userId,
          status: { $nin: ["Cancelled", "PaymentPending"] },
          "freeItem.productId": r.rule.freeItems._id,
          createdAt: { $gte: r.rule.validFrom, $lte: r.rule.validUntil },
        });

        return {
          ...r,
          usedCount,
          remainingUses: Math.max(r.usageLimit - usedCount, 0),
        };
      }),
    );

    const selectedRule = rulesWithUsage
      .filter((r) => r.remainingUses > 0 && cartTotal >= r.minOrderValue)
      .sort((a, b) => b.minOrderValue - a.minOrderValue)[0];

    if (selectedRule) {
      freeItemData = {
        productId: selectedRule.rule.freeItems._id,
        productName: selectedRule.rule.freeItems.productName,
        productImage: selectedRule.rule.freeItems.productImage,
        quantity: selectedRule.freeQty,
      };
    }
  }

  // Generate custom order ID
  const currentYear = new Date().getFullYear();
  const lastOrder = await Order.findOne(
    { orderId: { $regex: `^ORD-${currentYear}-` } },
    {},
    { sort: { createdAt: -1 } },
  );

  let orderNumber = 1;
  if (lastOrder && lastOrder.orderId) {
    const lastNumber = parseInt(lastOrder.orderId.split("-")[2]);
    orderNumber = lastNumber + 1;
  }

  const customOrderId = `ORD-${currentYear}-${orderNumber}`;

  // Check stock availability for all cart items
  // const stockIssues = [];
  // for (const item of cart.items) {
  //   const product = await Product.findById(item.productId);
  //   if (!product) {
  //     stockIssues.push({
  //       productName: "Unknown Product",
  //       requestedQuantity: item.quantity,
  //       availableQuantity: 0,
  //       message: "Product not found",
  //     });
  //     continue;
  //   }

  //   const variation = product.productVariations.id(item.variationId);
  //   if (!variation) {
  //     stockIssues.push({
  //       productName: product.productName,
  //       requestedQuantity: item.quantity,
  //       availableQuantity: 0,
  //       message: "Variation not found",
  //     });
  //     continue;
  //   }

  //   if (item.quantity > variation.stockQuantity) {
  //     stockIssues.push({
  //       productName: product.productName,
  //       requestedQuantity: item.quantity,
  //       availableQuantity: variation.stockQuantity,
  //       message: `Only ${variation.stockQuantity} items available`,
  //     });
  //   }
  // }

  const stockResult = await validateCartStockWithPetpooja(cart.items);
  if (!stockResult.ok) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Some items in your cart have insufficient stock. Please review your cart and try again.",
      data: {
        stockIssues: stockResult.stockIssues,
        errorType: "INSUFFICIENT_STOCK",
      },
    });
  }

  // Calculate delivery date and tag based on order creation time
  const orderCreationTime = new Date();
  const { deliveryDate, deliveryTag, deliveryWindow } =
    await calculateExpectedDeliveryDate(orderCreationTime);

  const subTotalForOrder = Number(
    orderItems.reduce((sum, item) => sum + Number(item.subtotal || 0), 0).toFixed(2),
  );

  let couponDiscount = 0;
  let appliedCouponId = cart.appliedCoupon?._id || null;
  let appliedCouponCode = cart.appliedCoupon?.couponCode || null;

  if (cart.appliedCoupon) {
    const coupon = cart.appliedCoupon;
    if (coupon.discountType === "Percentage") {
      couponDiscount = Number(((coupon.discountValue / 100) * subTotalForOrder).toFixed(2));
      if (coupon.maxDiscount && couponDiscount > coupon.maxDiscount) {
        couponDiscount = coupon.maxDiscount;
      }
    } else if (coupon.discountType === "FixedAmount") {
      couponDiscount = Number(coupon.discountValue);
    }
  } else {
    const { coupon, discount } = await getAutoApplicableCoupon(userId, cart, subTotalForOrder);
    if (coupon) {
      appliedCouponId = coupon._id;
      appliedCouponCode = coupon.couponCode;
      couponDiscount = discount;
    }
  }

  const deliveryCharge = Number(cartData.deliveryCharge) || 0;
  const platformFee = Number(cartData.platformFee) || 0;
  const grandTotal = Number(
    Math.max(subTotalForOrder + deliveryCharge + platformFee - couponDiscount, 0).toFixed(2),
  );

  const order = await Order.create({
    orderId: customOrderId,
    userId,
    items: orderItems,
    deliveryAddress: {
      fullName: address.fullName,
      area_building: address.area_building,
      houseFlatOfficeNo: address.houseFlatOfficeNo,
      address: address.location.address,
      pincode: address.location.pincode,
      landmark: address.location.landmark,
      phoneNumber: address.phoneNumber,
      addressType: address.addressType,
      coordinates: address.location.coordinates,
    },
    appliedCoupon: appliedCouponId,
    couponCode: appliedCouponCode,
    couponDiscount,
    deliveryCharge,
    platformFee,
    freeItem: freeItemData,
    totalItems: orderItems.reduce((sum, i) => sum + i.quantity, 0),
    subTotal: subTotalForOrder,
    grandTotal,
    paymentMethod: paymentType,
    expectedDeliveryDate: deliveryDate,
    deliveryTag: deliveryTag,
    deliveryWindow: deliveryWindow,
    stockDeducted: false,
  });

  // 🔻 AFTER ORDER CREATED → Reduce Stock Variation Wise
  // for (const item of cart.items) {
  //   const product = await Product.findOne(
  //     {
  //       _id: item.productId,
  //       "productVariations._id": item.variationId,
  //     },
  //     {
  //       "productVariations.$": 1,
  //     },
  //   );
  const reservedStockItems = [];
  for (const item of cart.items) {
    const product = await Product.findOne(
      {
        _id: item.productId,
        isDeleted: { $ne: true }, // ✅ PRODUCT SOFT DELETE CHECK
        productVariations: {
          $elemMatch: {
            _id: item.variationId,
            isDeleted: { $ne: true }, // ✅ VARIATION SOFT DELETE CHECK
          },
        },
      },
      {
        "productVariations.$": 1,
      }
    );

    if (!product) {
      await restoreOrderItemsStock(reservedStockItems);
      await Order.deleteOne({ _id: order._id, stockDeducted: false });
      return responseHandler({
        res,
        code: statusCode.DATAMISSING,
        message: "A cart item is no longer available. Please review your cart.",
        data: { errorType: "INSUFFICIENT_STOCK" },
      });
    }

    const quantity = Number(item.quantity) || 0;
    if (quantity <= 0) continue;

    const updatedProduct = await Product.findOneAndUpdate(
      {
        _id: item.productId,
        isDeleted: { $ne: true },
        productVariations: {
          $elemMatch: {
            _id: item.variationId,
            isDeleted: { $ne: true },
            stockQuantity: { $gte: quantity },
          },
        },
      },
      { $inc: { "productVariations.$.stockQuantity": -quantity } },
      { new: true }
    );

    if (!updatedProduct) {
      await restoreOrderItemsStock(reservedStockItems);
      await Order.deleteOne({ _id: order._id, stockDeducted: false });
      return responseHandler({
        res,
        code: statusCode.DATAMISSING,
        message: "Some items no longer have sufficient stock. Please review your cart.",
        data: { errorType: "INSUFFICIENT_STOCK" },
      });
    }

    reservedStockItems.push({
      productId: item.productId,
      variationId: item.variationId,
      quantity,
    });

    const variation = updatedProduct.productVariations.find(
      (v) => v._id.toString() === item.variationId.toString()
    );
    if (!variation) continue;
    const newQty = Number(variation.stockQuantity) || 0;

    // stock status update logic
    let newStatus = "inStock";
    if (newQty <= 0) newStatus = "outOfStock";
    else if (newQty <= variation.minStock) newStatus = "lowStock";

    const shouldIncOutOfStockCount =
      variation.stockStatus !== "outOfStock" && newStatus === "outOfStock";

    const updateDoc = {
      $set: {
        "productVariations.$.stockStatus": newStatus,
      },
    };

    if (shouldIncOutOfStockCount) {
      updateDoc.$inc = { "productVariations.$.outOfStockCount": 1 };
    }

    await Product.updateOne(
      {
        _id: item.productId,
        "productVariations._id": item.variationId,
      },
      updateDoc,
    );
  }

  order.stockDeducted = true;
  order.stockDeductedAt = new Date();
  await order.save();

  // delete cart after order
  await Cart.findOneAndDelete({ userId });

  // coupon usage update
  if (appliedCouponId) {
    await Coupons.findByIdAndUpdate(appliedCouponId, {
      $inc: { usageUsed: 1 },
    });

    await CouponUsage.findOneAndUpdate(
      { userId, couponId: appliedCouponId },
      { $inc: { usedCount: 1 } },
      { upsert: true },
    );
  }

  // Reset isSelected: After order is placed, set default address isSelected back to true
  const updatedUser = await User.findById(userId);
  const defaultAddr = updatedUser.addresses.find(
    (addr) => addr.isDefault === true,
  );
  if (defaultAddr) {
    defaultAddr.isSelected = true;
    updatedUser.addresses.forEach((addr) => {
      if (addr._id.toString() !== defaultAddr._id.toString()) {
        addr.isSelected = false;
      }
    });
    await updatedUser.save();
  }

  // 🔔 Send Order Confirmation Notification
  try {
    const userForNotif = await User.findById(userId).select(
      "notificationPreferences",
    );
    const isOrderUpdateOn =
      userForNotif?.notificationPreferences?.orderUpdates !== false;

    if (isOrderUpdateOn) {
      const notificationPayload = {
        userId: userId,
        targetAudience: "specificUser",
        title: "Order Update: Placed! 🎉",
        message: `Your order #${order.orderId} has been successfully placed. We will deliver it soon!`,
        type: "push",
        category: "orderUpdates",
        scheduleOptions: "now",
        sentAt: new Date(),
      };

      const notification = await Notification.create(notificationPayload);

      // Add to queue
      await notificationQueue.add("send-notification", {
        notificationId: notification._id.toString(),
        targetAudience: "specificUser",
        userId: userId.toString(),
        category: "orderUpdates",
        title: notificationPayload.title,
        message: notificationPayload.message,
        type: "push",
      });
    }
  } catch (err) {
    console.error("❌ Error sending order placement notification:", err);
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Order placed successfully.",
    data: order,
  });
});
exports.redeemCoupon = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const { couponCode, orderAmount } = req.body;
  if (!couponCode || !orderAmount) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "couponCode and orderAmount are required.",
    });
  }
  const coupon = await Coupons.findOne({
    couponCode: couponCode.toUpperCase(),
  });
  if (!coupon) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Invalid coupon code.",
    });
  }
  if (coupon.status !== "Active") {
    return responseHandler({
      res,
      code: statusCode.FORBIDDEN,
      message: "This coupon is inactive.",
    });
  }
  // ✅ Validate date range
  const now = new Date();
  const validFrom = new Date(coupon.validFrom);
  const validTill = new Date(coupon.validTill);

  if (now < validFrom || now > validTill) {
    return responseHandler({
      res,
      code: statusCode.FORBIDDEN,
      message: "Coupon is not valid at this time.",
    });
  }
  // ✅ Global usage limit
  // 100 &&100>=100
  if (coupon.usageLimit && coupon.usageUsed >= coupon.usageLimit) {
    return responseHandler({
      res,
      code: statusCode.FORBIDDEN,
      message: "Coupon usage limit exceeded.",
    });
  }

  // ✅ Minimum order value check
  if (coupon.minOrderValue && orderAmount < coupon.minOrderValue) {
    return responseHandler({
      res,
      code: statusCode.FORBIDDEN,
      message: `Minimum order value to apply this coupon is ₹${coupon.minOrderValue}.`,
    });
  }
  // ✅ Check per-user usage
  let usageRecord = await CouponUsage.findOne({
    userId,
    couponId: coupon._id,
  });
  // If record doesn’t exist, create it with usedCount = 0 (not incremented yet)
  if (!usageRecord) {
    usageRecord = await CouponUsage.create({
      userId,
      couponId: coupon._id,
      usedCount: 0,
    });
  }
  if (coupon.usagePerUser && usageRecord.usedCount >= coupon.usagePerUser) {
    return responseHandler({
      res,
      code: statusCode.FORBIDDEN,
      message: "You have already used this coupon maximum allowed times.",
    });
  }
  // ✅ Discount calculation
  let discount = 0;
  if (coupon.discountType === "Percentage") {
    discount = (orderAmount * coupon.discountValue) / 100;
    if (coupon.maxDiscount && discount > coupon.maxDiscount) {
      discount = coupon.maxDiscount;
    }
    // Never allow discount to exceed order amount.
    discount = Math.min(discount, orderAmount);
  } else if (coupon.discountType === "FixedAmount") {
    // Fixed discount is capped to order amount.
    discount = Math.min(coupon.discountValue, orderAmount);
  } else if (coupon.discountType === "FreeDelivery") {
    discount = 0;
  }

  const finalAmount = Math.max(orderAmount - discount, 0);
  const cart = await Cart.findOneAndUpdate(
    { userId },
    { appliedCoupon: coupon._id },
    { new: true },
  );

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Coupon applied successfully.",
    data: {
      couponId: coupon._id,
      couponCode: coupon.couponCode,
      discountType: coupon.discountType,
      discountValue: discount,
      finalAmount,
      minOrderValue: coupon.minOrderValue,
      cartId: cart?._id,
    },
  });
});
exports.removeCouponFromCart = catchAsyncError(async (req, res) => {
  const userId = req.user._id;

  const cart = await Cart.findOne({ userId });
  if (!cart) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Cart not found.",
    });
  }

  if (!cart.appliedCoupon) {
    return responseHandler({
      res,
      code: statusCode.FORBIDDEN,
      message: "No coupon is applied.",
    });
  }

  cart.appliedCoupon = null;
  await cart.save();

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Coupon removed successfully.",
    data: cart,
  });
});
exports.getUserOrders = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const { status } = req.query;

  const query = { userId, status: { $ne: "PaymentPending" } };
  if (status) {
    if (status === "ongoing") {
      query.status = { $in: ["Pending", "Confirmed", "Packed", "Shipped"] };
      query.$or = [
        { paymentMethod: "COD" },
        { paymentMethod: "Prepaid", paymentStatus: "Paid" },
      ];
    } else if (status === "delivered") {
      query.status = "Delivered";
    } else if (status === "cancelled") {
      query.status = "Cancelled";
    } else if (status === "returned") {
      query.status = "Returned";
    }
  }

  // 🧩 Step 1: fetch orders with product populated
  const orders = await Order.find(query)
    .populate("items.productId", "productName productVariations hsnCode")
    .populate("appliedCoupon", "couponCode")
    .populate("orderAssignedTo", "fullName mobileNumber driverImage")
    .sort({ createdAt: -1 });
  // console.log("getuserorders>>>", orders);

  // 🧩 Step 2: manually attach correct variation images to each item and delivery info
  const formattedOrders = await Promise.all(
    orders.map(async (order) => {
      let totalGST = 0;
      const productHsnCodeMap = new Map(
        (order.items || []).map((item) => [
          item?.productId?._id?.toString?.() || item?.productId?.toString?.(),
          item?.productId?.hsnCode || "",
        ]),
      );
      const formattedItems = order.items.map((item) => {
        const product = item.productId;

        // find correct variation
        let variationData = null;
        if (product && product.productVariations) {
          // variationData = product.productVariations.find(
          //   (v) => v._id.toString() === item.variationId.toString(),
          //   !v.isDeleted // ✅ ADD THIS
          // );

          variationData = product.productVariations.find(v =>
            v._id.toString() === item.variationId.toString() &&
            !v.isDeleted // ✅ ADD THIS
          );
        }

        const gstPercent =
          item.gstPercent ?? variationData?.gst ?? product?.gst ?? 0;
        const rawUnitPriceWithGST = Number(item.priceWithGST ?? 0);
        const unitBasePrice = Number(item.basePrice) || 0;
        const quantity = Number(item.quantity || 0);
        const subtotal = Number(item.subtotal || 0);
        const computedUnitPriceWithGST = Number(
          (unitBasePrice + (unitBasePrice * Number(gstPercent || 0)) / 100).toFixed(2),
        );
        const fromSubtotal = quantity > 0 && subtotal > 0 ? Number((subtotal / quantity).toFixed(2)) : 0;
        const unitPriceWithGST =
          rawUnitPriceWithGST > 0 &&
            (Number(gstPercent || 0) <= 0 || rawUnitPriceWithGST > unitBasePrice)
            ? rawUnitPriceWithGST
            : fromSubtotal > 0 && (Number(gstPercent || 0) <= 0 || fromSubtotal > unitBasePrice)
              ? fromSubtotal
              : Number(gstPercent || 0) > 0
                ? computedUnitPriceWithGST
                : rawUnitPriceWithGST > 0
                  ? rawUnitPriceWithGST
                  : unitBasePrice;
        const itemGSTAmount =
          item.gstAmount ??
          (unitPriceWithGST - unitBasePrice) * (Number(item.quantity) || 0);
        totalGST += itemGSTAmount;

        return {
          _id: item._id,
          productId: product?._id,
          productName: product?.productName,
          hsnCode: product?.hsnCode || "",
          variationId: item.variationId,
          quantity: item.quantity,
          basePrice: unitBasePrice,
          priceWithGST: unitPriceWithGST,
          unitPrice: unitPriceWithGST,
          subtotal: Number((unitPriceWithGST * quantity).toFixed(2)),
          gstPercent,
          gstAmount: Number(itemGSTAmount.toFixed(2)),
          variationImages: variationData?.productImages || [],
        };
      });
      const formattedReturnedItems = (order.returnedItemsDetails || []).map(
        (returnedItem) => {
          const returnedItemObj = returnedItem?.toObject
            ? returnedItem.toObject()
            : returnedItem;
          const returnedProductId = returnedItemObj?.productId?.toString?.();
          const returnedQty = Number(returnedItemObj?.quantity || 0);
          const returnedRawUnitPriceWithGST = Number(returnedItemObj?.priceWithGST || 0);
          const returnedBasePrice = Number(returnedItemObj?.basePrice || 0);
          const returnedGstPercent = Number(returnedItemObj?.gstPercent || 0);
          const returnedSubtotal = Number(returnedItemObj?.subtotal || 0);
          const returnedComputedUnitPriceWithGST = Number(
            (returnedBasePrice + (returnedBasePrice * returnedGstPercent) / 100).toFixed(2),
          );
          const returnedFromSubtotal =
            returnedQty > 0 && returnedSubtotal > 0
              ? Number((returnedSubtotal / returnedQty).toFixed(2))
              : 0;
          const returnedUnitPrice =
            returnedRawUnitPriceWithGST > 0 &&
              (returnedGstPercent <= 0 || returnedRawUnitPriceWithGST > returnedBasePrice)
              ? returnedRawUnitPriceWithGST
              : returnedFromSubtotal > 0 &&
                (returnedGstPercent <= 0 || returnedFromSubtotal > returnedBasePrice)
                ? returnedFromSubtotal
                : returnedGstPercent > 0
                  ? returnedComputedUnitPriceWithGST
                  : returnedRawUnitPriceWithGST > 0
                    ? returnedRawUnitPriceWithGST
                    : returnedBasePrice;

          return {
            ...returnedItemObj,
            unitPrice: returnedUnitPrice,
            subtotal: Number((returnedUnitPrice * returnedQty).toFixed(2)),
            hsnCode: returnedProductId
              ? productHsnCodeMap.get(returnedProductId) || ""
              : "",
          };
        },
      );

      // Get delivery info for confirmed orders
      let deliveryWindow = null;
      if (order.status === "Confirmed" && order.expectedDeliveryDate) {
        const slotInfo = await getDeliverySlotInfo(order.expectedDeliveryDate);
        deliveryWindow = slotInfo?.deliveryWindow || null;
      }

      return {
        ...order.toObject(),
        items: formattedItems,
        returnedItemsDetails: formattedReturnedItems,
        totalGST: Number(totalGST.toFixed(2)),
        deliveryWindow,
      };
    }),
  );

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Orders fetched successfully.",
    data: {
      orders: formattedOrders,
    },
  });
});

const getDeliverySlotInfo = async (expectedDeliveryDate) => {
  if (!expectedDeliveryDate) return null;

  const deliveryTag = getDeliveryTag(expectedDeliveryDate);
  const slotName =
    deliveryTag === "SAME_DAY"
      ? "Same Day Evening Delivery"
      : "Next Day Morning Delivery";

  const slot = await DeliverySlot.findOne({
    slotName,
    enabled: true,
    // isSpecialSlot: false,
  });

  if (slot) {
    return {
      // slotName: slot.slotName,
      // description: slot.description,
      deliveryWindow: slot.deliveryWindow,
      // expectedDate: deliveryDate.toDateString(),
      // expectedTimeWindow: `${slot.deliveryWindow.startTime} - ${slot.deliveryWindow.endTime}`
    };
  }

  return null;
};
exports.getOrderDetails = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const { orderId } = req.query;

  // 🧩 Step 1: Find the order with product and coupon populated
  const order = await Order.findOne({ _id: orderId, userId })
    .populate("items.productId", "productName productVariations")
    .populate("appliedCoupon", "couponCode")
    .populate("orderAssignedTo", "fullName mobileNumber driverImage");
  // console.log("order>>>>",order)
  if (!order) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Order not found.",
    });
  }
  let totalItems = 0;
  // let totalGST = 0;

  // 🧩 Step 2: Attach correct variation images and product details
  const formattedItems = order.items.map((item) => {
    const product = item.productId;

    // find correct variation
    let variationData = null;
    if (product && product.productVariations) {
      // variationData = product.productVariations.find(
      //   (v) => v._id.toString() === item.variationId.toString(),
      // );

      variationData = product.productVariations.find(
        (v) =>
          v._id.toString() === item.variationId.toString() &&
          !v.isDeleted // ✅ ADD THIS
      );
    }
    totalItems += item.quantity;
    // totalGST += (item.priceWithGST - item.basePrice) * item.quantity;

    const unitBasePrice = Number(item.basePrice ?? 0);
    const gstPercent = Number(item.gstPercent ?? variationData?.gst ?? product?.gst ?? 0);
    const rawPriceWithGST = Number(item.priceWithGST ?? 0);
    const quantity = Number(item.quantity || 0);
    const subtotal = Number(item.subtotal || 0);
    const computedUnitPriceWithGST = Number(
      (unitBasePrice + (unitBasePrice * gstPercent) / 100).toFixed(2),
    );
    const fromSubtotal = quantity > 0 && subtotal > 0 ? Number((subtotal / quantity).toFixed(2)) : 0;
    const unitPriceWithGST =
      rawPriceWithGST > 0 && (gstPercent <= 0 || rawPriceWithGST > unitBasePrice)
        ? rawPriceWithGST
        : fromSubtotal > 0 && (gstPercent <= 0 || fromSubtotal > unitBasePrice)
          ? fromSubtotal
          : gstPercent > 0
            ? computedUnitPriceWithGST
            : rawPriceWithGST > 0
              ? rawPriceWithGST
              : unitBasePrice;

    return {
      _id: item._id,
      productId: product?._id,
      productName: product?.productName,
      variationId: item.variationId,
      quantity: item.quantity,
      basePrice: unitBasePrice,
      priceWithGST: unitPriceWithGST,
      unitPrice: unitPriceWithGST,
      subtotal: Number((unitPriceWithGST * quantity).toFixed(2)),
      gstPercent,
      gstAmount: Number(item.gstAmount ?? 0),
      variationImages: variationData?.productImages || [],
      measurmentUnit: variationData?.measurmentUnit,
      measurmentValue: variationData?.measurmentValue,
    };
  });
  const subTotal = Number(
    formattedItems
      .reduce((sum, item) => sum + Number(item.subtotal || 0), 0)
      .toFixed(2),
  );
  const grandTotal =
    subTotal +
    (order.deliveryCharge || 0) +
    (order.platformFee || 0) -
    (order.couponDiscount || 0);

  let deliveryRanges = [];

  const user = await User.findById(userId).lean();
  let userPincode = null;

  // Prefer order's saved delivery address (selected at checkout time),
  // then fallback to currently selected user address.
  const orderPincode =
    order?.deliveryAddress?.pincode || order?.deliveryAddress?.location?.pincode;

  if (orderPincode) {
    userPincode = orderPincode;
  } else if (user && user.addresses?.length > 0) {
    const selectedAddress = user.addresses.find((a) => a.isSelected);
    userPincode = selectedAddress?.location?.pincode || selectedAddress?.pincode;
  }

  let zone = null;
  if (userPincode) {
    zone = await Zone.findOne({
      "locations.pin": userPincode,
      status: "Active",
    }).lean();
  }

  let deliveryConfig = null;
  if (zone) {
    deliveryConfig = await DeliveryOrderConfig.findOne({
      zoneId: zone._id,
      deliveryChargesEnabled: true,
    }).lean();
  }

  if (deliveryConfig?.deliveryRanges?.length > 0) {
    deliveryRanges = deliveryConfig.deliveryRanges;
  }

  // 🧩 Step 3: Get delivery slot information if order is confirmed
  let deliveryWindow = null;
  if (order.status === "Confirmed" && order.expectedDeliveryDate) {
    const slotInfo = await getDeliverySlotInfo(order.expectedDeliveryDate);
    deliveryWindow = slotInfo?.deliveryWindow || null;
  }

  const returnedItemsTotal = Number(
    (order.returnedItemsDetails || [])
      .reduce((sum, item) => sum + Number(item?.subtotal || 0), 0)
      .toFixed(2),
  );

  // 🧩 Step 4: Combine everything
  const formattedOrder = {
    ...order.toObject(),
    items: formattedItems,
    totalItems,
    // totalGST,
    subTotal,
    grandTotal,
    deliveryWindow,
    deliveryRanges,
    returnedItemsTotal,
  };

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Order details fetched successfully.",
    data: formattedOrder,
  });
});
exports.cancelOrder = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const { orderId } = req.query;
  if (!orderId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Order ID is required.",
    });
  }
  const order = await Order.findOne({ _id: orderId, userId });
  if (!order) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Order not found.",
    });
  }
  if (order.status !== "Pending") {
    return responseHandler({
      res,
      code: statusCode.FORBIDDEN,
      message: "Order cannot be cancelled. It has already been processed.",
    });
  }
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
  if (order.createdAt < oneHourAgo) {
    return responseHandler({
      res,
      code: statusCode.FORBIDDEN,
      message:
        "Order cannot be cancelled. The 1-hour cancellation window has expired.",
    });
  }
  const cancelledOrder = await Order.findOneAndUpdate(
    { _id: order._id, userId, status: "Pending" },
    {
      $set: {
        status: "Cancelled",
        stockDeducted: false,
        "tracking.isCancelled": true,
        "tracking.cancelledAt": new Date(),
      },
      $unset: { stockDeductedAt: 1 },
    },
    { new: false },
  );

  if (!cancelledOrder) {
    return responseHandler({
      res,
      code: statusCode.FORBIDDEN,
      message: "Order is already cancelled or has been processed.",
    });
  }

  if (cancelledOrder.stockDeducted) {
    try {
      await restoreOrderItemsStock(cancelledOrder.items);
    } catch (stockError) {
      await Order.updateOne(
        { _id: cancelledOrder._id, status: "Cancelled" },
        {
          $set: {
            status: "Pending",
            stockDeducted: true,
            stockDeductedAt: cancelledOrder.stockDeductedAt || new Date(),
          },
          $unset: {
            "tracking.isCancelled": 1,
            "tracking.cancelledAt": 1,
          },
        },
      );
      throw stockError;
    }
  }

  try {
    const orderForRefund = await Order.findById(order._id);
    await processFullOrderCancelRefund({
      order: orderForRefund,
      cancelledBy: "user",
      actorId: userId,
    });
  } catch (refundError) {
    console.error("[USER-CANCEL-REFUND] Failed to process refund:", refundError.message);
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Order cancelled successfully.",
  });
});
exports.getBannerProducts = catchAsyncError(async (req, res) => {
  const { bannerId } = req.query;

  if (!bannerId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "bannerId is required",
    });
  }

  const banner = await Banner.findById(bannerId).populate(
    "festivalPromotionId",
    "name",
  );

  if (!banner) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Banner not found",
    });
  }

  // Now fetch all mapped products
  // const products = await Product.find({
  //   "productVariations.bannerId": bannerId,
  //   "productVariations.bannerStatusPerSku": "Active",
  // }).select("productName productVariations");

  let products = [];

  if (Array.isArray(banner.selectedVariations) && banner.selectedVariations.length > 0) {
    const productIds = [
      ...new Set(
        banner.selectedVariations
          .map((sv) => sv.productId?.toString?.() || sv.productId)
          .filter(Boolean),
      ),
    ];
    products = await Product.find({
      _id: { $in: productIds },
      isDeleted: { $ne: true },
      "productVariations.isDeleted": { $ne: true },
    }).select("productName productVariations");
  } else {
    products = await Product.find({
      isDeleted: { $ne: true },
      "productVariations.bannerId": bannerId,
      "productVariations.bannerStatusPerSku": "Active",
      "productVariations.isDeleted": { $ne: true },
    }).select("productName productVariations");
  }

  const filteredProducts =
    Array.isArray(banner.selectedVariations) && banner.selectedVariations.length > 0
      ? filterBannerProducts(products, banner.selectedVariations)
      : filterProductsByBannerVariation(products, bannerId);

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Banner products fetched successfully",
    data: filteredProducts,
  });
});
exports.reorderFromHistory = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const { orderId } = req.query;

  if (!orderId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "orderId is required.",
    });
  }

  const order = await Order.findOne({ _id: orderId, userId });
  if (!order) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Order not found.",
    });
  }

  let cart = await Cart.findOne({ userId });
  if (!cart) {
    cart = new Cart({ userId, items: [] });
  }

  let unavailableItems = [];
  let addedItems = [];

  for (const orderItem of order.items) {
    // const product = await Product.findById(orderItem.productId);
    // if (!product) {
    //   unavailableItems.push({
    //     productName: "Product not found",
    //     reason: "Product discontinued",
    //   });
    //   continue;
    // }

    // const variation = product.productVariations.id(orderItem.variationId);
    // if (!variation) {
    //   unavailableItems.push({
    //     productName: product.productName,
    //     reason: "Variation not available",
    //   });
    //   continue;
    // }

    const product = await Product.findById(orderItem.productId);

    // ✅ ADD THIS
    if (!product || product.isDeleted) {
      unavailableItems.push({
        productName: "Product deleted",
        reason: "Product no longer available",
      });
      continue;
    }

    const variation = product.productVariations.id(orderItem.variationId);

    // ✅ ADD THIS
    if (!variation || variation.isDeleted) {
      unavailableItems.push({
        productName: product.productName,
        reason: "Variation no longer available",
      });
      continue;
    }

    const gstPercent = product.gst || 0;
    const basePrice = variation.sellingPrice;
    const priceWithGST = basePrice + (basePrice * gstPercent) / 100;
    const totalPrice = priceWithGST * orderItem.quantity;

    const existingItem = cart.items.find(
      (item) =>
        item.productId.toString() === orderItem.productId.toString() &&
        item.variationId.toString() === orderItem.variationId.toString(),
    );

    if (existingItem) {
      existingItem.quantity = orderItem.quantity;
      existingItem.totalPrice =
        existingItem.priceWithGST * existingItem.quantity;
    } else {
      cart.items.push({
        productId: orderItem.productId,
        variationId: orderItem.variationId,
        quantity: orderItem.quantity,
        price: basePrice,
        gstPercent,
        priceWithGST,
        totalPrice,
      });
    }
    addedItems.push(product.productName);
  }

  if (cart.appliedCoupon) {
    const coupon = await Coupons.findById(cart.appliedCoupon);
    if (coupon && coupon.minOrderValue) {
      let newCartTotal = 0;
      cart.items.forEach((item) => {
        newCartTotal += item.priceWithGST * item.quantity;
      });
      if (newCartTotal < coupon.minOrderValue) {
        cart.appliedCoupon = null;
      }
    }
  }

  await cart.save();

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Items added to cart successfully.",
    data: {
      cart,
      addedItems: addedItems.length,
      unavailableItems,
    },
  });
});
exports.rateOrderAndDriver = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const { orderId, orderRating, orderReview, driverRating } = req.body;

  if (!orderId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "orderId is required",
    });
  }

  if (!mongoose.Types.ObjectId.isValid(orderId)) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Invalid orderId",
    });
  }

  const order = await Order.findOne({ _id: orderId, userId });
  if (!order) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Order not found.",
    });
  }

  if (order.status !== "Delivered") {
    return responseHandler({
      res,
      code: statusCode.FORBIDDEN,
      message: "You can only rate Delivered orders",
    });
  }
  if (orderRating) {
    if (orderRating < 1 || orderRating > 5) {
      return responseHandler({
        res,
        code: statusCode.DATAMISSING,
        message: "Order rating must be between 1 and 5",
      });
    }

    order.orderRating = orderRating;
    order.orderReview = orderReview || "";
  }
  let updatedDriver = null;

  if (driverRating) {
    if (driverRating < 1 || driverRating > 5) {
      return responseHandler({
        res,
        code: statusCode.DATAMISSING,
        message: "Driver rating must be between 1 and 5",
      });
    }

    const driver = await DRIVER.findById(order.orderAssignedTo);

    if (driver) {
      driver.ratingCount++;
      driver.ratingSum += driverRating;
      driver.driverRating = driverRating;

      driver.averageRating = Number(
        (driver.ratingSum / driver.ratingCount).toFixed(2),
      );

      updatedDriver = await driver.save();
    }

    order.driverRating = driverRating;
  }

  await order.save();

  const deliveryCount = await Order.countDocuments({
    orderAssignedTo: order.orderAssignedTo,
    status: "Delivered",
  });

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Ratings submitted successfully",
    data: {
      order: {
        orderId: order._id,
        orderRating: order.orderRating,
        orderReview: order.orderReview,
      },
      driver: updatedDriver
        ? {
          driverId: updatedDriver._id,
          driverRating: updatedDriver.driverRating,
          ratingCount: updatedDriver.ratingCount,
          ratingSum: updatedDriver.ratingSum,
          averageRating: updatedDriver.averageRating,
          deliveryCount,
        }
        : null,
    },
  });
});

//new code for search products(but response according to 1st time searchproducts api)
exports.searchProducts = catchAsyncError(async (req, res) => {
  const { query, categoryIds, availability, discount, minPrice, maxPrice } =
    req.query;

  const page = Number(req.query.page) || 1;
  const limit = Number(req.query.limit) || 10;
  const skip = (page - 1) * limit;

  /* =========================
     COMMON MATCH (BASE)
  ========================= */
  // let match = {
  //   productVariations: { $exists: true, $ne: [] },
  // };

  let match = {
    isDeleted: { $ne: true }, // ✅ ADD THIS
    productVariations: { $exists: true, $ne: [] }
  };

  if (query && query.trim() !== "") {
    const regex = new RegExp(query.trim(), "i");
    match.$or = [
      { productName: { $regex: regex } },
      { keywords: { $in: [regex] } },
    ];
  }

  if (categoryIds) {
    match.categoryId = {
      $in: categoryIds.split(",").map((id) => new mongoose.Types.ObjectId(id)),
    };
  }

  if (availability === "inStock") {
    match["productVariations.stockQuantity"] = { $gt: 0 };
  }

  if (availability === "outOfStock") {
    match["productVariations.stockQuantity"] = { $eq: 0 };
  }

  /* =========================
     TOTAL COUNT
  ========================= */
  const totalCountAgg = await Product.aggregate([
    { $match: match },
    {
      $addFields: {
        productVariations: {
          $filter: {
            input: "$productVariations",
            as: "v",
            cond: {
              $and: [
                { $ne: ["$$v.isDeleted", true] },
                ...(minPrice
                  ? [{ $gte: ["$$v.sellingPrice", Number(minPrice)] }]
                  : []),
                ...(maxPrice
                  ? [{ $lte: ["$$v.sellingPrice", Number(maxPrice)] }]
                  : []),

                ...(discount === "upto10"
                  ? [{ $lte: ["$$v.discountPercent", 10] }]
                  : []),
                ...(discount === "upto20"
                  ? [{ $lte: ["$$v.discountPercent", 20] }]
                  : []),
                ...(discount === "upto30"
                  ? [{ $lte: ["$$v.discountPercent", 30] }]
                  : []),
                ...(discount === "upto40"
                  ? [{ $lte: ["$$v.discountPercent", 40] }]
                  : []),
                ...(discount === "upto50"
                  ? [{ $lte: ["$$v.discountPercent", 50] }]
                  : []),
                ...(discount === "morethan50"
                  ? [{ $gt: ["$$v.discountPercent", 50] }]
                  : []),
              ],
            },
          },
        },
      },
    },
    { $match: { "productVariations.0": { $exists: true } } },
    { $count: "total" },
  ]);

  const totalResults = totalCountAgg[0]?.total || 0;

  // Record search history for analytics
  if (query && query.trim() !== "") {
    try {
      await SearchHistory.create({
        query: query.trim(),
        userId: req.user ? req.user._id : null,
        resultsCount: totalResults,
        isProductAvailable: totalResults > 0,
        deviceType: req.headers["device-type"] || "web",
      });
    } catch (err) {
      console.error("Error recording search history:", err);
    }
  }

  /* =========================
     PRODUCTS
  ========================= */
  const products = await Product.aggregate([
    { $match: match },

    {
      $addFields: {
        productVariations: {
          $filter: {
            input: "$productVariations",
            as: "v",
            cond: {
              $and: [
                { $ne: ["$$v.isDeleted", true] },
                ...(minPrice
                  ? [{ $gte: ["$$v.sellingPrice", Number(minPrice)] }]
                  : []),
                ...(maxPrice
                  ? [{ $lte: ["$$v.sellingPrice", Number(maxPrice)] }]
                  : []),

                ...(discount === "upto10"
                  ? [{ $lte: ["$$v.discountPercent", 10] }]
                  : []),
                ...(discount === "upto20"
                  ? [{ $lte: ["$$v.discountPercent", 20] }]
                  : []),
                ...(discount === "upto30"
                  ? [{ $lte: ["$$v.discountPercent", 30] }]
                  : []),
                ...(discount === "upto40"
                  ? [{ $lte: ["$$v.discountPercent", 40] }]
                  : []),
                ...(discount === "upto50"
                  ? [{ $lte: ["$$v.discountPercent", 50] }]
                  : []),
                ...(discount === "morethan50"
                  ? [{ $gt: ["$$v.discountPercent", 50] }]
                  : []),
              ],
            },
          },
        },
      },
    },
    {
      $match: {
        "productVariations.0": { $exists: true },
      },
    },
    {
      $lookup: {
        from: "categories",
        localField: "categoryId",
        foreignField: "_id",
        as: "categoryData",
      },
    },
    { $unwind: "$categoryData" },

    {
      $addFields: {
        subcategoryData: {
          $filter: {
            input: "$categoryData.subCategories",
            as: "sub",
            cond: { $eq: ["$$sub._id", "$subcategoryId"] },
          },
        },
      },
    },
    {
      $addFields: {
        subcategoryData: { $arrayElemAt: ["$subcategoryData", 0] },
      },
    },

    {
      $project: {
        productName: 1,
        keywords: 1,
        productVariations: 1,
        createdAt: 1,

        categoryId: {
          _id: "$categoryData._id",
          categoryName: "$categoryData.categoryName",
        },

        subcategoryId: {
          _id: "$subcategoryData._id",
          subCategoryName: "$subcategoryData.subCategoryName",
        },
      },
    },

    { $sort: { createdAt: -1 } },
    { $skip: skip },
    { $limit: limit },
  ]);

  /* =========================
     DYNAMIC FILTERS (BASED ON RESULT)
  ========================= */

  // 🔹 Categories filter (Show all active categories)
  const categories = await Category.find({ status: "Active" })
    .select("_id categoryName")
    .lean();
  // 🔹 Price Range
  const priceAgg = await Product.aggregate([
    { $match: match },
    { $unwind: "$productVariations" },
    {
      $group: {
        _id: null,
        min: { $min: "$productVariations.sellingPrice" },
        max: { $max: "$productVariations.sellingPrice" },
      },
    },
  ]);

  const priceRange = priceAgg.length
    ? { min: priceAgg[0].min, max: priceAgg[0].max }
    : { min: 0, max: 0 };

  // 🔹 Discount filters (Static list)
  const discountFilters = [
    "upto10",
    "upto20",
    "upto30",
    "upto40",
    "upto50",
    "morethan50",
  ];

  /* =========================
     FINAL RESPONSE (OLD STRUCTURE)
  ========================= */
  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Products searched successfully",
    data: {
      searchQuery: query || null,
      categoryFilter: categoryIds || null,
      totalproducts: totalResults,
      totalOnPage: products.length,
      totalPages: Math.ceil(totalResults / limit),
      page,
      limit,
      products,
      filters: {
        categories,
        availability: ["inStock", "outOfStock"],
        discount: discountFilters,
        priceRange,
      },
    },
  });
});
exports.guestGetCart = catchAsyncError(async (req, res) => {
  const { items } = req.body;

  if (!items || !Array.isArray(items) || items.length === 0) {
    return responseHandler({
      res,
      code: statusCode.SUCCESS,
      message: "Guest cart is empty.",
      // data: {
      //   items: [],
      //   totalItemsCount: 0,
      //   cartValueWithoutGST: 0,
      //   totalGSTAmount: 0,
      //   totalGSTPercent: 0,
      //   deliveryChargeInfo: null,
      //   appliedCoupon: null,
      //   couponDiscount: 0,
      //   totalAmount: 0,
      //   minOrderInfo: null,
      //   freeItemInfo: null,
      //   canPlaceOrder: false,
      // },
    });
  }

  const populatedItems = await Promise.all(
    items.map(async (item) => {
      const product = await Product.findById(item.productId)
        .lean()
        .select("productName gst categoryId subcategoryId productVariations");

      if (!product) return null;

      const selectedVariation = product.productVariations.find(
        (v) => v._id.toString() === item.variationId.toString(),
      );

      // const gstPercent = product.gst || 0;
      const price = selectedVariation?.sellingPrice || 0;
      // const priceWithGST = basePrice + (basePrice * gstPercent) / 100;
      const totalPrice = price * item.quantity;

      return {
        // _id: item.productId + item.variationId,
        quantity: item.quantity,
        price,
        // gstPercent,
        totalPrice,
        // priceWithGST,
        product: {
          _id: product._id,
          productName: product.productName,
          gst: product.gst,
          categoryId: product.categoryId,
          subcategoryId: product.subcategoryId,
          selectedVariation: selectedVariation
            ? {
              _id: selectedVariation._id,
              productType: selectedVariation.productType,
              measurmentUnit: selectedVariation.measurmentUnit,
              measurmentValue: selectedVariation.measurmentValue,
              mrp: selectedVariation.mrp,
              sellingPrice: selectedVariation.sellingPrice,
              discountPercent: selectedVariation.discountPercent,
              sku: selectedVariation.sku,
              stockQuantity: selectedVariation.stockQuantity,
              productImages: selectedVariation.productImages,
            }
            : null,
        },
      };
    }),
  );

  const filteredItems = populatedItems.filter(Boolean);
  const totalItemsCount = filteredItems.reduce(
    (acc, item) => acc + item.quantity,
    0,
  );
  const totalCartValue = filteredItems.reduce(
    (sum, item) => sum + item.totalPrice,
    0,
  );

  // let totalWithoutGST = 0;
  // let totalGSTAmount = 0;
  // let totalCartValue = 0;

  // filteredItems.forEach((item) => {
  //   const basePrice = item.price * item.quantity;
  //   const gstAmount = basePrice * (item.gstPercent / 100);
  //   const totalPrice = basePrice + gstAmount;
  //   totalWithoutGST += basePrice;
  //   totalGSTAmount += gstAmount;
  //   totalCartValue += totalPrice;
  // });
  // // Calculate GST %
  // const totalGSTPercent = totalWithoutGST
  //   ? (totalGSTAmount / totalWithoutGST) * 100
  //   : 0;

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Guest cart fetched successfully.",
    data: {
      items: filteredItems,
      totalItemsCount,
      // cartValueWithoutGST: parseFloat(totalWithoutGST.toFixed(2)),
      // totalGSTAmount: parseFloat(totalGSTAmount.toFixed(2)),
      // totalGSTPercent: parseFloat(totalGSTPercent.toFixed(2)),
      totalAmount: parseFloat(totalCartValue.toFixed(2)),
      canPlaceOrder: false,
    },
  });
});
exports.getAllCoupons = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const currentDate = new Date();

  // Get user's cart
  const cart = await Cart.findOne({ userId });
  let cartCategories = [];
  let cartSubTotal = 0;

  if (cart && cart.items.length > 0) {
    const cartItems = await Promise.all(
      cart.items.map(async (item) => {
        const product = await Product.findById(item.productId)
          .lean()
          .select("categoryId");

        if (!product) return null;

        return {
          categoryId: product.categoryId,
          totalPrice: item.price * item.quantity,
        };
      }),
    );

    const validCartItems = cartItems.filter(Boolean);

    cartCategories = [
      ...new Set(validCartItems.map((item) => item.categoryId.toString())),
    ];

    cartSubTotal = validCartItems.reduce(
      (sum, item) => sum + item.totalPrice,
      0,
    );
  }

  // Get user's coupon usage
  const userUsage = await CouponUsage.find({ userId }).lean();
  const usageMap = userUsage.reduce((acc, usage) => {
    acc[usage.couponId.toString()] = usage.usedCount;
    return acc;
  }, {});

  // Get all active coupons - simplified query first
  const coupons = await Coupons.find({
    status: "Active",
  }).populate("categoryId", "categoryName");

  // Filter and process each coupon
  const processedCoupons = coupons
    .filter((coupon) => {
      // 1. Date range check
      const validFrom = new Date(coupon.validFrom);
      const validTill = new Date(coupon.validTill);
      if (currentDate < validFrom || currentDate > validTill) return false;

      // 2. Global usage limit check
      if (coupon.usageLimit && coupon.usageUsed >= coupon.usageLimit)
        return false;

      // 3. Per-user usage limit check
      const usedCountByThisUser = usageMap[coupon._id.toString()] || 0;
      if (coupon.usagePerUser && usedCountByThisUser >= coupon.usagePerUser)
        return false;

      return true;
    })
    .map((coupon) => {
      let canApply = true;

      // ❌ empty cart safety
      if (cartSubTotal <= 0) {
        canApply = false;
      }

      // ❌ min order check
      if (
        canApply &&
        coupon.minOrderValue &&
        cartSubTotal < coupon.minOrderValue
      ) {
        canApply = false;
      }

      // ❌ category restriction check
      if (canApply && coupon.categoryId && coupon.categoryId.length > 0) {
        const couponCategories = coupon.categoryId.map((cat) =>
          cat._id.toString(),
        );
        const hasMatchingCategory = cartCategories.some((cat) =>
          couponCategories.includes(cat),
        );
        if (!hasMatchingCategory) {
          canApply = false;
        }
      }

      // if (coupon.categoryId && coupon.categoryId.length > 0) {
      //   const couponCategories = coupon.categoryId.map(cat => cat._id.toString());

      //   const hasMatchingCategory = cartCategories.some(cartCat =>
      //     couponCategories.includes(cartCat)
      //   );

      //   if (hasMatchingCategory) {
      //     if (coupon.minOrderValue) {
      //       canApply = cartSubTotal >= coupon.minOrderValue;
      //     } else {
      //       canApply = true;
      //     }
      //   } else {
      //     canApply = false;
      //   }
      // } else {
      //   if (coupon.minOrderValue) {
      //     canApply = cartSubTotal >= coupon.minOrderValue;
      //   } else {
      //     canApply = cartSubTotal > 0;
      //   }
      // }

      return {
        _id: coupon._id,
        couponCode: coupon.couponCode,
        title: coupon.title,
        description: coupon.description,
        discountType: coupon.discountType,
        discountValue: coupon.discountValue,
        maxDiscount: coupon.maxDiscount,
        minOrderValue: coupon.minOrderValue,
        usageLimit: coupon.usageLimit,
        usageUsed: coupon.usageUsed,
        validFrom: coupon.validFrom,
        validTill: coupon.validTill,
        userType: coupon.userType,
        usagePerUser: coupon.usagePerUser,
        status: coupon.status,
        autoApplyForEligibleOrders: coupon.autoApplyForEligibleOrders,
        isNotifyUsers: coupon.isNotifyUsers,
        // categories: coupon.categoryId,//for cecking which catgory lies in these coupons
        canApply,
      };
    });

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "User coupons fetched successfully",
    data: processedCoupons,
  });
});
exports.getAllIssues = catchAsyncError(async (req, res) => {
  const issues = await Issue.find().sort({ createdAt: -1 });

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    data: issues,
  });
});

// Notification Preferences
exports.getNotificationPreferences = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const user = await User.findById(userId).select("notificationPreferences");

  if (!user) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "User not found",
    });
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Notification preferences fetched successfully",
    data: user.notificationPreferences,
  });
});

exports.updateNotificationPreferences = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const { orderUpdates, promotions, deliveryAlerts } = req.body;

  const user = await User.findById(userId);
  if (!user) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "User not found",
    });
  }

  if (orderUpdates !== undefined)
    user.notificationPreferences.orderUpdates = orderUpdates;
  if (promotions !== undefined)
    user.notificationPreferences.promotions = promotions;
  if (deliveryAlerts !== undefined)
    user.notificationPreferences.deliveryAlerts = deliveryAlerts;

  await user.save();

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Notification preferences updated successfully",
    data: user.notificationPreferences,
  });
});

exports.getNotificationHistory = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const userCreatedAt = req.user.createdAt;

  // Find notifications where:
  // 1. Target criteria matches (Personal or relevant Broadcast)
  // 2. Already sent
  const notifications = await Notification.find({
    $or: [
      { userId: userId },
      {
        targetAudience: {
          $in: [
            "all",
            "activeLast30Days",
            "newUsersLast7Days",
            "userInactive30Days",
          ],
        },
        sentAt: { $gte: userCreatedAt },
      },
    ],
    sentAt: { $exists: true },
  }).sort({ sentAt: -1 });

  // Mark as opened once per user-notification pair
  if (notifications.length > 0) {
    const notificationIds = notifications.map((n) => n._id);
    const existingReads = await NotificationRead.find({
      userId,
      notificationId: { $in: notificationIds },
    }).select("notificationId");

    const existingReadIds = new Set(
      existingReads.map((read) => read.notificationId.toString()),
    );
    const unreadIds = notificationIds.filter(
      (id) => !existingReadIds.has(id.toString()),
    );

    if (unreadIds.length > 0) {
      try {
        await NotificationRead.insertMany(
          unreadIds.map((notificationId) => ({ notificationId, userId })),
          { ordered: false },
        );
      } catch (err) {
        // Ignore duplicate key errors for races; log other insert errors
        if (err?.code !== 11000) {
          console.error("Error inserting notification read records:", err);
        }
      }

      Notification.updateMany(
        { _id: { $in: unreadIds } },
        { $inc: { openedCount: 1 } },
      ).catch((err) =>
        console.error("Error updating notification openedCount:", err),
      );
    }
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Notification history fetched successfully",
    data: notifications,
  });
});

exports.getUserUnreadNotificationCount = catchAsyncError(async (req, res) => {
  const userId = req.user._id;
  const userCreatedAt = req.user.createdAt;

  const readCollection = NotificationRead.collection.name;

  const result = await Notification.aggregate([
    {
      $match: {
        sentAt: { $exists: true },
        $or: [
          { userId: userId },
          {
            targetAudience: {
              $in: [
                "all",
                "activeLast30Days",
                "newUsersLast7Days",
                "userInactive30Days",
              ],
            },
            sentAt: { $gte: userCreatedAt },
          },
        ],
      },
    },
    {
      $lookup: {
        from: readCollection,
        let: { notificationId: "$_id" },
        pipeline: [
          {
            $match: {
              $expr: {
                $and: [
                  { $eq: ["$notificationId", "$$notificationId"] },
                  { $eq: ["$userId", userId] },
                ],
              },
            },
          },
          { $limit: 1 },
        ],
        as: "reads",
      },
    },
    { $match: { reads: { $size: 0 } } },
    { $count: "unreadCount" },
  ]);

  const unreadCount = result[0]?.unreadCount || 0;

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "User unread notifications count fetched successfully",
    data: { unreadCount },
  });
});
