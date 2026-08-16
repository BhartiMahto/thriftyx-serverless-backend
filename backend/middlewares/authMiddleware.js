const jwt = require("jsonwebtoken");
const Admin = require("../models/adminModel");

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

const ACCESS_RANK = { NONE: 0, VIEW: 1, EDIT: 2 };
/**
 * Allows a SUPER_ADMIN, or a sub-admin whose permissions grant `module` at the
 * required level or higher. Use "VIEW" for reads and "EDIT" for writes.
 * Assumes `protect` ran first (req.admin populated with role + permissions).
 */
const requireModule = (module, level = "VIEW") => (req, res, next) => {
  if (!req.admin) return res.status(401).json({ error: "Unauthorized" });
  if (req.admin.role === "SUPER_ADMIN") return next();
  const perm = (req.admin.permissions || []).find((p) => p && p.module === module);
  const have = ACCESS_RANK[perm?.access] || 0;
  if (have >= (ACCESS_RANK[level] || 1)) return next();
  return res.status(403).json({ error: "Access denied" });
};

module.exports = {
  protect,
  isSuperAdmin,
  requireModule,
};
