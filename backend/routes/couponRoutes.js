const express = require("express");
const router = express.Router();
const connectDB = require("../config/db");
const couponController = require("../controllers/couponController");

// Public: preview a discount at checkout. No usage is recorded here — the real
// application and usage tracking happen in orderController when the order is placed.
router.post(
  "/validate",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  couponController.validate
);

// Public: coupons the customer can browse and pick at checkout.
router.get(
  "/available",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  couponController.listAvailable
);

module.exports = router;
