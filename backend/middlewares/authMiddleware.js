const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");

const protect = async (req, res, next) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];
    if (!token) {
      return res.status(401).json({ error: "No token provided" });
    }

    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.admin = await Admin.findById(decoded.id);

    if (!req.admin) {
      return res.status(401).json({ error: "Invalid token" });
    }

    next();
  } catch (error) {
    res.status(401).json({ error: "Unauthorized" });
  }
};

const isSuperAdmin = (req, res, next) => {
  if (req.admin.role !== "SUPER_ADMIN") {
    return res.status(403).json({ error: "Access denied" });
  }
  next();
};

module.exports = {
  protect,
  isSuperAdmin,
};
