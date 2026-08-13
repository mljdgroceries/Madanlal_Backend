// optionalAuth.js
const jwt = require("jsonwebtoken");
const User = require("../models/userModel");

exports.optionalAuth = async (req, res, next) => {
  try {
    const authHeader = req.header("Authorization");
    if (!authHeader) return next(); // no token, proceed as guest

    const token = authHeader.startsWith("Bearer ")
      ? authHeader.split(" ")[1]
      : authHeader;

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded || !decoded.userId) return next();

    const user = await User.findById(decoded.userId);
    if (!user || user.status === "Blocked" || user.status === "Deleted") return next();

    req.user = user; // attach valid user
    next();
  } catch (err) {
    // ignore any errors, proceed as guest
    next();
  }
};