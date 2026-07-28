const express = require("express");
const router = express.Router();
const connectDB = require("../config/db");
const SubAdminController = require("../controllers/subAdminController");
const { protect, isSuperAdmin } = require("../middlewares/authMiddleware");

const withDb = async (req, res, next) => {
  await connectDB();
  next();
};

/**
 * Managing admin accounts is SUPER_ADMIN only.
 *
 * These routes previously had no authentication at all — the import was
 * commented out — so anyone on the internet could POST themselves an admin
 * account and then read every order and customer record.
 */
router.use(withDb, protect, isSuperAdmin);

router.get("/", SubAdminController.getSubAdmins);
router.post("/", SubAdminController.createSubAdmin);
router.patch("/:id", SubAdminController.updateSubAdmin);
router.delete("/:id", SubAdminController.deleteSubAdmin);

module.exports = router;
