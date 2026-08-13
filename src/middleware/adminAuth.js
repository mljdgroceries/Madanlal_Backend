const jwt = require("jsonwebtoken");

// models
const { Admin } = require("../models/adminModel");

// utils
const { responseHandler } = require("../utils/responseHandler");
const statusCode = require("../utils/httpResponseCode");

exports.adminAuth = async (req, res, next) => {
  try {
    const authHeader = req.header("Authorization");
    if (!authHeader) {
      return responseHandler({
        res,
        code: statusCode.UNAUTHORIZED,
        message: "Authorization header missing or invalid",
      });
    }

    const token = authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : authHeader;
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded || !decoded.adminId) {
      return responseHandler({
        res,
        code: statusCode.UNAUTHORIZED,
        message: "Invalid token payload",
      });
    }
    const admin = await Admin.findById(decoded.adminId);
    // console.log("Admin found =>", admin);

    if (!admin) {
      return responseHandler({
        res,
        code: statusCode.UNAUTHORIZED,
        message: "Access denied. Admin not found.",
      });
    }
    // Optional: single-session auth
    // if (admin.jwtToken !== token) {
    //     console.log("Invalid token. Please log in again");
    //     return responseHandler({
    //         res,
    //         code: statusCode.UNAUTHORIZED,
    //         message: "Invalid token. Please log in again.",
    //     });
    // }

    // 👇 future checks agar required ho (status, block, delete)
    if (admin.status === "Inactive") {
      return responseHandler({
        res,
        code: statusCode.UNAUTHORIZED,
        message: "Your account is inactive. Please contact support.",
      });
    }
    // if (admin.isBlocked) {
    //   return responseHandler({
    //     res,
    //     code: statusCode.UNAUTHORIZED,
    //     message: "Your account is blocked. Please contact support.",
    //   });
    // }
    // if (admin.isDeleted) {
    //   return responseHandler({
    //     res,
    //     code: statusCode.UNAUTHORIZED,
    //     message: "Your account has been deleted. Please contact support.",
    //   });
    // }

    req.admin = admin;
    next();
  } catch (err) {
    console.log("AdminAuth error:", err.name);
    if (err.name === "JsonWebTokenError") {
      return responseHandler({
        res,
        code: statusCode.UNAUTHORIZED,
        message: "Invalid token. Please log in again.",
        error: err.message,
      });
    }
    if (err.name === "TokenExpiredError") {
      return responseHandler({
        res,
        code: statusCode.UNAUTHORIZED,
        message: "Session expired. Please log in again.",
      });
    }

    console.log("Caught error:", err);
    return responseHandler({
      res,
      code: statusCode.ERROR,
      message: "Authentication failed",
      error: err.message,
    });
  }
};
