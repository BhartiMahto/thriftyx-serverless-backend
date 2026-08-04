const jwt = require("jsonwebtoken");
const User = require("../models/userModel");

/**
 * Verifies a *customer* JWT (issued by authController.verifyCode) and attaches
 * the user document to req.user.
 *
 * Note: customer tokens carry { _id }, whereas admin tokens carry { id, role }.
 * They are deliberately handled by separate middlewares.
 */
const protectUser = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(401).json({ message: "No token provided", statusCode: 401 });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded._id).select("-password -otp -forgotCode");

    if (!user) {
      return res.status(401).json({ message: "Invalid token", statusCode: 401 });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({ message: "Unauthorized", statusCode: 401 });
  }
};

/**
 * Soft auth: attaches req.user when a valid customer token is present, but never
 * blocks the request. Used on public endpoints (e.g. coupon preview) that
 * personalise results for signed-in shoppers yet still work for guests.
 */
const optionalUser = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded._id).select("-password -otp -forgotCode");
      if (user) req.user = user;
    }
  } catch {
    /* ignore — treat as guest */
  }
  next();
};

module.exports = { protectUser, optionalUser };
