const express = require("express");
const router = express.Router();
const connectDB = require("../config/db");
const orderController = require("../controllers/orderController");
const { protectUser } = require("../middlewares/userAuthMiddleware");

router.post(
  "/",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  protectUser,
  orderController.createOrder
);

router.get(
  "/my",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  protectUser,
  orderController.getMyOrders
);

router.post(
  "/:id/rating",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  protectUser,
  orderController.rateOrder
);

router.patch(
  "/:id/cancel",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  protectUser,
  orderController.cancelOrder
);

router.patch(
  "/:id/reschedule",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  protectUser,
  orderController.rescheduleOrder
);

router.get(
  "/:id/refund-status",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  protectUser,
  orderController.getRefundStatus
);

router.get(
  "/:id/ticket",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  protectUser,
  orderController.getOrderTicket
);

// Generate-or-fetch the ticket / invoice PDF (returns { data: { url } }).
router.get(
  "/:id/ticket-pdf",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  protectUser,
  orderController.getTicketPdf
);

router.get(
  "/:id/invoice-pdf",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  protectUser,
  orderController.getInvoicePdf
);

module.exports = router;
