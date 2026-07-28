const bcrypt = require("bcryptjs");
const Admin = require("../models/adminModel");

/**
 * Sub-admin management.
 *
 * Every route here is SUPER_ADMIN only — see routes/subAdminRoutes.js. This
 * endpoint previously had no authentication at all, so anyone could POST an
 * admin account for themselves, and the list response returned the full Mongo
 * document including each bcrypt password hash.
 */

/**
 * Modules a sub-admin's permissions can cover.
 *
 * Covers both legacy vocabularies: the old `assignedWork` titles ("Question
 * Answer", "Contact Us", "Header Image"…) and the component-style names the
 * newer schema used ("EventManagement", "RevenueAnalytics"). See
 * scripts/migrateAdminRoles.js for the mapping.
 */
const MODULES = [
  "events",
  "attendees",
  "orders",
  "gallery",
  "users",
  "faq",
  "support",
  "founder",
  "partner",
  "reviews",
  "blogs",
  "siteContent",
  "finance",
  "revenue",
  "subadmin",
];

const ACCESS_LEVELS = ["NONE", "VIEW", "EDIT"];

/** Never return password hashes or tokens. */
const publicAdmin = (admin) => ({
  _id: admin._id,
  fullName: admin.fullName ?? null,
  email: admin.email,
  role: admin.role ?? "SUB_ADMIN",
  status: admin.status ?? "active",
  lastLoginAt: admin.lastLoginAt ?? null,
  createdAt: admin.createdAt ?? null,
  permissions: Array.isArray(admin.permissions)
    ? admin.permissions
        .filter((p) => p && p.module)
        .map((p) => ({ module: p.module, access: p.access ?? "NONE" }))
    : [],
});

/** Validates and normalises an incoming permissions array. */
const sanitisePermissions = (input) => {
  if (input === undefined) return { ok: true, value: undefined };
  if (!Array.isArray(input)) return { ok: false, error: "permissions must be an array" };

  const cleaned = [];
  for (const p of input) {
    if (!p || typeof p.module !== "string") {
      return { ok: false, error: "each permission needs a module" };
    }
    if (!MODULES.includes(p.module)) {
      return { ok: false, error: `unknown module "${p.module}"` };
    }
    if (!ACCESS_LEVELS.includes(p.access)) {
      return { ok: false, error: `access must be one of ${ACCESS_LEVELS.join(", ")}` };
    }
    cleaned.push({ module: p.module, access: p.access });
  }
  return { ok: true, value: cleaned };
};

const createSubAdmin = async (req, res) => {
  try {
    const { fullName, email, password, permissions } = req.body;

    if (!fullName || !email || !password) {
      return res
        .status(400)
        .json({ message: "fullName, email and password are required", statusCode: 400 });
    }
    if (String(password).length < 8) {
      return res
        .status(400)
        .json({ message: "Password must be at least 8 characters", statusCode: 400 });
    }

    const lowerEmail = String(email).toLowerCase().trim();
    if (await Admin.findOne({ email: lowerEmail })) {
      return res.status(409).json({ message: "Email already registered", statusCode: 409 });
    }

    const perms = sanitisePermissions(permissions);
    if (!perms.ok) return res.status(400).json({ message: perms.error, statusCode: 400 });

    const created = await Admin.create({
      fullName,
      email: lowerEmail,
      password: await bcrypt.hash(password, 10),
      // Role is forced — a request body must never be able to mint a SUPER_ADMIN.
      role: "SUB_ADMIN",
      status: "active",
      permissions: perms.value ?? [],
    });

    res.status(201).json({
      message: "Sub-admin created",
      data: publicAdmin(created),
      statusCode: 201,
    });
  } catch (error) {
    console.error("createSubAdmin error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

const getSubAdmins = async (req, res) => {
  try {
    const admins = await Admin.find({ role: "SUB_ADMIN" })
      .select("-password")
      .sort({ createdAt: -1 })
      .lean();

    res.status(200).json({
      message: "Sub-admins",
      data: admins.map(publicAdmin),
      modules: MODULES,
      statusCode: 200,
    });
  } catch (error) {
    console.error("getSubAdmins error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** PATCH /api/subadmin/:id — permissions, status, name, or password. */
const updateSubAdmin = async (req, res) => {
  try {
    const target = await Admin.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ message: "Sub-admin not found", statusCode: 404 });
    }
    if (target.role === "SUPER_ADMIN") {
      return res
        .status(403)
        .json({ message: "Super-admins cannot be edited here", statusCode: 403 });
    }

    const updates = {};

    if (req.body.fullName !== undefined) {
      if (!String(req.body.fullName).trim()) {
        return res.status(400).json({ message: "Name cannot be empty", statusCode: 400 });
      }
      updates.fullName = String(req.body.fullName).trim();
    }

    if (req.body.status !== undefined) {
      if (!["active", "suspended"].includes(req.body.status)) {
        return res
          .status(400)
          .json({ message: "status must be active or suspended", statusCode: 400 });
      }
      updates.status = req.body.status;
    }

    if (req.body.password !== undefined) {
      if (String(req.body.password).length < 8) {
        return res
          .status(400)
          .json({ message: "Password must be at least 8 characters", statusCode: 400 });
      }
      updates.password = await bcrypt.hash(req.body.password, 10);
    }

    const perms = sanitisePermissions(req.body.permissions);
    if (!perms.ok) return res.status(400).json({ message: perms.error, statusCode: 400 });
    if (perms.value !== undefined) updates.permissions = perms.value;

    // `role` is deliberately not updatable — promoting to SUPER_ADMIN must be a
    // conscious database action, not an API call.
    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "No editable fields provided", statusCode: 400 });
    }

    const updated = await Admin.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true }
    ).select("-password");

    res.status(200).json({
      message: "Sub-admin updated",
      data: publicAdmin(updated),
      statusCode: 200,
    });
  } catch (error) {
    console.error("updateSubAdmin error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

const deleteSubAdmin = async (req, res) => {
  try {
    const target = await Admin.findById(req.params.id);
    if (!target) {
      return res.status(404).json({ message: "Sub-admin not found", statusCode: 404 });
    }
    if (target.role === "SUPER_ADMIN") {
      return res
        .status(403)
        .json({ message: "Super-admins cannot be deleted here", statusCode: 403 });
    }
    if (String(target._id) === String(req.admin?._id)) {
      return res
        .status(400)
        .json({ message: "You cannot delete your own account", statusCode: 400 });
    }

    await Admin.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: "Sub-admin deleted", statusCode: 200 });
  } catch (error) {
    console.error("deleteSubAdmin error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

module.exports = {
  createSubAdmin,
  getSubAdmins,
  updateSubAdmin,
  deleteSubAdmin,
  MODULES,
};
