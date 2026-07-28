const crypto = require("crypto");
const Order = require("../models/orderModel");

/**
 * ============================ MOCK PAYMENTS ============================
 *
 * This deliberately mimics the Razorpay two-step flow so switching to the real
 * SDK is a contained change:
 *
 *   1. POST /api/payment/create  -> server creates a payment order, returns an id
 *   2. browser completes payment -> Razorpay returns payment_id + signature
 *   3. POST /api/payment/verify  -> server verifies the signature, marks paid
 *
 * What is faked: step 1 returns a generated `mock_order_*` id instead of calling
 * Razorpay, and step 2 never happens — the client immediately calls verify.
 *
 * TO GO LIVE:
 *   - npm install razorpay
 *   - createPayment: replace the mock id with `razorpay.orders.create(...)`
 *   - verifyPayment: delete the MOCK branch below; the real HMAC check is
 *     already written and correct.
 * =======================================================================
 */

const MOCK_PAYMENTS = process.env.PAYMENTS_MODE !== "live";

/** POST /api/payment/create — starts checkout for an existing order. */
const createPayment = async (req, res) => {
  try {
    const { order_id } = req.body;

    if (!order_id) {
      return res.status(400).json({ message: "order_id is required", statusCode: 400 });
    }

    const order = await Order.findById(order_id);
    if (!order) {
      return res.status(404).json({ message: "Order not found", statusCode: 404 });
    }
    if (String(order.user_id) !== String(req.user._id)) {
      return res.status(403).json({ message: "This booking is not yours", statusCode: 403 });
    }
    if (order.status === "completed") {
      return res.status(409).json({ message: "Order is already paid", statusCode: 409 });
    }
    if (order.status === "cancelled") {
      return res.status(409).json({ message: "Order was cancelled", statusCode: 409 });
    }

    // Razorpay works in the smallest currency unit (paise).
    const amountInPaise = Math.round((order.grand_total ?? 0) * 100);

    const paymentOrderId = MOCK_PAYMENTS
      ? `mock_order_${crypto.randomBytes(8).toString("hex")}`
      : null; // replaced by razorpay.orders.create(...).id when live

    order.receipt_no = order.receipt_no || `RCPT${Date.now()}`;
    order.status = "pending";
    order.updatedBy = new Date();
    await order.save();

    return res.status(200).json({
      message: "Payment initiated",
      data: {
        paymentOrderId,
        amount: amountInPaise,
        currency: "INR",
        // Never expose RAZORPAY_SECRET — only the publishable key id.
        keyId: process.env.RAZORPAY_TEST_KEY || null,
        receipt: order.receipt_no,
        mock: MOCK_PAYMENTS,
      },
      statusCode: 200,
    });
  } catch (error) {
    console.error("createPayment error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** POST /api/payment/verify — confirms payment and marks the order completed. */
const verifyPayment = async (req, res) => {
  try {
    const { order_id, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

    if (!order_id) {
      return res.status(400).json({ message: "order_id is required", statusCode: 400 });
    }

    const order = await Order.findById(order_id);
    if (!order) {
      return res.status(404).json({ message: "Order not found", statusCode: 404 });
    }
    if (String(order.user_id) !== String(req.user._id)) {
      return res.status(403).json({ message: "This booking is not yours", statusCode: 403 });
    }
    if (order.status === "completed") {
      return res.status(409).json({ message: "Order is already paid", statusCode: 409 });
    }

    let paymentId;

    if (MOCK_PAYMENTS) {
      // ---- MOCK BRANCH: delete this whole block when going live ----
      paymentId = razorpay_payment_id || `mock_pay_${crypto.randomBytes(8).toString("hex")}`;
    } else {
      // ---- REAL VERIFICATION (already correct, just unused while mocking) ----
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
        return res
          .status(400)
          .json({ message: "Missing Razorpay verification fields", statusCode: 400 });
      }

      const expected = crypto
        .createHmac("sha256", process.env.RAZORPAY_SECRET)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest("hex");

      // Constant-time compare so the signature can't be guessed byte by byte.
      const valid =
        expected.length === razorpay_signature.length &&
        crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(razorpay_signature));

      if (!valid) {
        order.status = "failed";
        order.updatedBy = new Date();
        await order.save();
        return res.status(400).json({ message: "Payment verification failed", statusCode: 400 });
      }

      paymentId = razorpay_payment_id;
    }

    order.status = "completed";
    order.payment_id = paymentId;
    order.updatedBy = new Date();
    await order.save();

    // Issue the GST tax invoice now that payment is confirmed. Never let a
    // document/S3 failure break a successful payment — it's retried lazily
    // when the customer opens the invoice.
    try {
      const { ensureInvoice } = require("../utils/documents");
      await ensureInvoice(order);
    } catch (docErr) {
      console.error("Invoice generation failed for order", String(order._id), docErr.message);
    }

    return res.status(200).json({
      message: "Payment successful",
      data: {
        _id: order._id,
        order_id: order.order_id,
        status: order.status,
        payment_id: order.payment_id,
        mock: MOCK_PAYMENTS,
      },
      statusCode: 200,
    });
  } catch (error) {
    console.error("verifyPayment error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * Refunds a paid order. Mocked like the rest of payments — returns a synthetic
 * refund id/status. When live, replace the MOCK branch with
 * `razorpay.payments.refund(order.payment_id, { amount, speed })`.
 *
 * Returns { id, status, amount, at }. Safe to call only on a completed order.
 */
const refundOrderPayment = async (order) => {
  const amountPaise = Math.round((order.grand_total ?? 0) * 100);

  if (MOCK_PAYMENTS) {
    return {
      id: `mock_rfnd_${crypto.randomBytes(8).toString("hex")}`,
      status: "processed",
      amount: order.grand_total ?? 0,
      at: new Date(),
    };
  }

  // ---- LIVE (unused while mocking) ----
  const Razorpay = require("razorpay");
  const rp = new Razorpay({
    key_id: process.env.RAZORPAY_TEST_KEY,
    key_secret: process.env.RAZORPAY_SECRET,
  });
  const refund = await rp.payments.refund(order.payment_id, { amount: amountPaise, speed: "normal" });
  return {
    id: refund.id,
    status: refund.status,
    amount: (refund.amount ?? amountPaise) / 100,
    at: new Date(),
  };
};

/**
 * Fetches the current refund status from Razorpay. Mocked: echoes what's stored
 * on the order. When live, calls `razorpay.refunds.fetch(order.refund.id)`.
 */
const fetchRefundStatus = async (order) => {
  if (!order.refund?.id) return null;
  if (MOCK_PAYMENTS) return order.refund.status || "processed";

  const Razorpay = require("razorpay");
  const rp = new Razorpay({
    key_id: process.env.RAZORPAY_TEST_KEY,
    key_secret: process.env.RAZORPAY_SECRET,
  });
  const r = await rp.refunds.fetch(order.refund.id);
  return r.status;
};

module.exports = { createPayment, verifyPayment, refundOrderPayment, fetchRefundStatus };
