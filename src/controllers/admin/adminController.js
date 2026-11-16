const { Admin } = require("../../models/adminModel");
const { catchAsyncError } = require("../../utils/generateError");
const mongoose = require("mongoose");
const jwt = require("jsonwebtoken");
const { responseHandler } = require("../../utils/responseHandler");
const { generateAdminToken } = require("../../utils/tokenUtils");
const statusCode = require("../../utils/httpResponseCode");
const { verifyPassword } = require("../../utils/bcryption")
const nodemailer = require("nodemailer");
const bcrypt = require("bcrypt");

exports.adminLogin = catchAsyncError(async (req, res) => {
  const { email, password, deviceToken, deviceType } = req.body;

  if (!email || !password) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Email and password are required"
    });
  }

  const admin = await Admin.findOne({ email });
  if (!admin) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Admin not found"
    });
  }

  const isMatch = await verifyPassword(password, admin.password);
  if (!isMatch) {
    return responseHandler({
      res,
      code: statusCode.UNAUTHORIZED,
      message: "Invalid Password"
    });
  }

  const token = generateAdminToken(admin);
  admin.jwtToken = token;

  // Handle multiple device registration (web only as per schema)
  if (deviceToken) {
    if (!admin.devices) admin.devices = [];

    const existingDeviceIndex = admin.devices.findIndex(d => d.deviceToken === deviceToken);
    if (existingDeviceIndex !== -1) {
      admin.devices[existingDeviceIndex].accessToken = token;
      admin.devices[existingDeviceIndex].deviceType = deviceType || "web";
    } else {
      admin.devices.push({
        deviceType: deviceType || "web",
        deviceToken,
        accessToken: token
      });
    }
  }

  await admin.save();

  const adminObj = admin.toObject();

  // Return only the current device in the devices array for the response
  if (deviceToken) {
    adminObj.devices = adminObj.devices.filter(d => d.deviceToken === deviceToken);
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Login successful",
    data: {
      admin: adminObj,
      // jwtToken: token
    }
  });
});
exports.adminLogout = catchAsyncError(async (req, res) => {
  const adminId = req.admin._id;
  const admin = await Admin.findById(adminId);

  if (!admin) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "admin not found"
    });
  }

  const authHeader = req.header('Authorization');
  const token = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : authHeader;

  if (admin.devices && admin.devices.length > 0) {
    admin.devices = admin.devices.filter(device => device.accessToken !== token);
  }

  // Also clear root jwtToken if it matches (for legacy/fallback)
  if (admin.jwtToken === token) {
    admin.jwtToken = null;
  }

  await admin.save();

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "admin logout successful"
  });
});
exports.forgotPassword = catchAsyncError(async (req, res) => {
  const { email } = req.body

  if (!email) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Email is required",
    });
  }

  const admin = await Admin.findOne({ email })

  if (!admin) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Admin not found"
    });
  }

  // ✅ Generate Reset Token (valid for 15 mins)
  const resetToken = jwt.sign(
    {
      id: admin._id,
      email: admin.email
    },
    process.env.JWT_SECRET, // apni secret key env me rakho
    // { expiresIn: "15m" }
  );

  // ✅ Reset URL with token
  const resetUrl = `https://madanlalpansari.in/admin/reset-password?token=${resetToken}`;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: process.env.EMAIL_USER,
      pass: process.env.EMAIL_PASS,
    },
  });

   await transporter.verify();
   console.log("SMTP connected");
  await transporter.sendMail({
    from: `"Madan Lal Admin Support" <${process.env.EMAIL_USER}>`,
    to: email,
    subject: "Password Reset Link",
    text: `Click the link to reset your password: ${resetUrl}`,
  })

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Password reset link has been sent to your email",
    data: { resetToken },
  });
});

exports.resetPassword = catchAsyncError(async (req, res) => {
  const { email, newPassword } = req.body;

  if (!email || !newPassword) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Email and newPassword are required",
    });
  }

  const admin = await Admin.findOne({ email });
  if (!admin) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Admin not found",
    });
  }


  admin.password = await bcrypt.hash(newPassword, 10);
  await admin.save();

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Password reset successfully",
  });


})
exports.changePassword = catchAsyncError(async (req, res) => {
  const adminId = req.admin._id;
  const { oldPassword, newPassword } = req.body;



  if (!oldPassword || !newPassword) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: 'oldPassword, newPassword and  are required.',
    });
  }



  const admin = await Admin.findById(adminId)
  if (!admin) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: 'Admin not found.',
    });
  }

  const isMatch = await bcrypt.compare(oldPassword, admin.password);
  if (!isMatch) {
    return responseHandler({
      res,
      code: statusCode.UNAUTHORIZED,
      message: 'Incorrect old password.',
    });
  }

  const salt = await bcrypt.genSalt(10);
  admin.password = await bcrypt.hash(newPassword, salt);

  await admin.save();

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: 'Password changed successfully. Please login again.',

  });
});
exports.updateAdminProfile = catchAsyncError(async (req, res) => {
  const adminId = req.admin._id;
  const { name, email, adminImage, phone, driverAutoAssignmentStatus } = req.body;

  // Check if email is being updated and if it already exists
  if (email) {
    const existingAdmin = await Admin.findOne({
      email: email,
      _id: { $ne: adminId } // Exclude current admin from the search
    });

    if (existingAdmin) {
      return responseHandler({
        res,
        code: statusCode.CONFLICT,
        message: 'Email already exists. Please use a different email.'
      });
    }
  }

  const admin = await Admin.findById(adminId);
  if (!admin) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: 'Admin not found.'
    });
  }

  // Update only the fields that are provided
  const updateData = {};
  if (name) updateData.name = name;
  if (email) updateData.email = email;
  if (phone) updateData.phone = phone;
  if (adminImage) updateData.adminImage = adminImage;
  // ✅ AUTO ASSIGN TOGGLE UPDATE
  if (typeof driverAutoAssignmentStatus !== "undefined") {
    updateData.driverAutoAssignmentStatus = driverAutoAssignmentStatus;
  }

  const updatedAdmin = await Admin.findByIdAndUpdate(
    adminId,
    { $set: updateData },
    { new: true, runValidators: true }
  );

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: 'Admin profile updated successfully.',
    data: updatedAdmin
  });
});
exports.getAdminProfileDetails = catchAsyncError(async (req, res) => {
  const adminId = req.admin._id;

  const admin = await Admin.findById(adminId).select("-password");

  if (!admin) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Admin not found",
    });
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Admin profile fetched successfully",
    data: admin,
  });
});
