const jwt = require("jsonwebtoken");

//models
const DRIVER = require("../models/driverModel");

//utils
const { responseHandler } = require("../utils/responseHandler");
const statusCode = require("../utils/httpResponseCode");


exports.driverAuth = async (req, res, next) => {
    try {
        const authHeader = req.header('Authorization');
        if (!authHeader ) {
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
        if (!decoded || !decoded.driverId) {
                    return responseHandler({
                        res,
                        code: statusCode.UNAUTHORIZED,
                        message: "Invalid token payload"
                    });
                }
        const driver = await DRIVER.findById(decoded.driverId);

        if (!driver) {
            return responseHandler({
                res,
                code: statusCode.UNAUTHORIZED,
                message: "Access denied. Driver not found.",
            })
        }
        // Allow only active driver sessions.
        if (!["Active", "onDelivery"].includes(driver.status)) {
            return responseHandler({
                res,
                code: statusCode.UNAUTHORIZED,
                message: "Your account is not active. Please contact admin.",
            });
        }

        // Token must match either legacy accessToken or one of registered device sessions.
        const isLegacyTokenValid = driver.accessToken && driver.accessToken === token;
        const isDeviceTokenValid = Array.isArray(driver.devices)
            && driver.devices.some(device => device.accessToken === token);

        if (!isLegacyTokenValid && !isDeviceTokenValid) {
            return responseHandler({
                res,
                code: statusCode.UNAUTHORIZED,
                message: "Invalid token. Please log in again.",
            });
        }
        req.driver=driver;
        next();
    } catch (err) {
        console.log("Ayushhhh consoling error name", err.name);
        // Handle specific JWT verification errors
        if (err.name === 'JsonWebTokenError' || err.name === 'TokenExpiredError') {
            console.log("JWT Error:", err.message);
            return responseHandler({
                res,
                code: statusCode.UNAUTHORIZED,  // Unauthorized for invalid or expired tokens
                message: "Invalid or expired token. Please log in again.",
                error: err.message // Include the specific error message
            });
        }
        // Internal Server Error for unexpected errors
        console.log("Caught error:", err);
        return responseHandler({
            res,
            code: statusCode.ERROR,
            message: "Authentication failed",
            error: err.message
        })
    }
};
