const express = require("express");
const router = express.Router();
const connectDB = require("../config/db");
const paymentController = require("../controllers/paymentController");
const { protectUser } = require("../middlewares/userAuthMiddleware");

const withDb = async (req, res, next) => {
  await connectDB();
  next();
};

router.post("/create", withDb, protectUser, paymentController.createPayment);
router.post("/verify", withDb, protectUser, paymentController.verifyPayment);

module.exports = router;
