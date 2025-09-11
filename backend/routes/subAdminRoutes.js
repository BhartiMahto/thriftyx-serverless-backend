const express = require("express");
const router = express.Router();
const connectDB = require("../config/db");
const SubAdminController = require("../controllers/subAdminController");
// const { protect, isSuperAdmin } = require("../middleware/authMiddleware");

router.post(
  "/",
  async (req, res, next) => {
    connectDB();
    next();
  },
  SubAdminController.createSubAdmin
);

router.get(
  "/",
  async (req, res, next) => {
    connectDB();
    next();
  },
  SubAdminController.getSubAdmins
);

module.exports = router;
