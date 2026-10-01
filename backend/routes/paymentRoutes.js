const express = require("express");
const router = express.Router();
const connectDB = require("../config/db");
const paymentController = require("../controllers/paymentController");
const { razorpayWebhook } = require("../controllers/webhookController");
const { protectUser } = require("../middlewares/userAuthMiddleware");

const withDb = async (req, res, next) => {
  await connectDB();
  next();
};

router.post("/create", withDb, protectUser, paymentController.createPayment);
router.post("/verify", withDb, protectUser, paymentController.verifyPayment);
// Razorpay server-to-server webhook (no auth; verified by HMAC signature).
router.post("/webhook", withDb, razorpayWebhook);

module.exports = router;
