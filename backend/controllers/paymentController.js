const crypto = require("crypto");
const Order = require("../models/orderModel");
const sendMail = require("../utils/sendMail");
const { niceDate, SUPPORT, sendWaTemplate, firstName } = require("../utils/notify");

/**
 * Emails the customer that their payment landed and their spot is pending host
 * confirmation (bookings are curated, so a paid booking starts on the waitlist).
 * Skipped for already-confirmed bookings. Email-only + best-effort.
 */
const notifyWaitlisted = async (order) => {
  try {
    if (order.applicationStatus === "confirmed") return;
    await order.populate("user_id", "email phone name");
    await order.populate("event_id", "name date start_time end_time venue_name venue city");
    const to = order.attendee_details?.email || order.user_id?.email;
    const phone = order.attendee_details?.phone || order.user_id?.phone;
    const who = firstName(order.attendee_details?.name || order.user_id?.name);
    const ev = order.event_id || {};
    const name = ev.name || "your event";

    // WhatsApp (approved Utility template) — reaches people who don't check email.
    await sendWaTemplate(phone, "TWILIO_WA_BOOKING_PENDING_SID", { 1: who, 2: name });

    if (!to) return;
    const when = ev.date ? niceDate(ev.date) : "";
    const time = [ev.start_time, ev.end_time].filter(Boolean).join(" - ");
    const where = [ev.venue_name || ev.venue, order.event_city || ev.city].filter(Boolean).join(", ");
    const body = [
      `Thanks for booking "${name}" — your payment has been received. 🎟`,
      "",
      ...(when ? [`Date: ${when}${time ? ` (${time})` : ""}`] : []),
      ...(where ? [`Venue: ${where}`] : []),
      "",
      "Your spot is now with our host team for confirmation — we curate every gathering to keep the group balanced. You'll get a confirmation email with your entry ticket as soon as you're approved.",
      "",
      "No action needed from you for now.",
      `Questions? ${SUPPORT}`,
      "— IRL Social Hive",
    ].join("\n");
    await sendMail(to, `Booking received — pending confirmation — ${name}`, body);
  } catch (e) {
    console.error("waitlisted email:", e.message);
  }
};

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

/**
 * PAYMENTS_MODE: "mock" (fake, default) | "test" (real Razorpay, test keys) |
 * "live" (real Razorpay, live keys). "test" and "live" both use the real SDK;
 * "test" charges nothing (test cards).
 *
 * Environment rule: only the DEPLOYED backend (Lambda) is allowed to run live —
 * locally we always force "test" so a dev run can never take a real payment,
 * regardless of what PAYMENTS_MODE says in .env.
 */
const { isDeployed } = require("../utils/runtimeEnv");
const MODE = isDeployed
  ? (process.env.PAYMENTS_MODE || "mock").toLowerCase()
  : "test";
const MOCK_PAYMENTS = MODE !== "test" && MODE !== "live";

// Publishable key id (safe to send to the browser) + secret for the active mode.
const RZP_KEY_ID = MODE === "live" ? process.env.RAZORPAY_LIVE_KEY : process.env.RAZORPAY_TEST_KEY;
const RZP_SECRET = MODE === "live" ? process.env.RAZORPAY_SECRET : process.env.RAZORPAY_TEST_SECRET;

let _rzp = null;
function razorpay() {
  if (_rzp) return _rzp;
  const Razorpay = require("razorpay");
  _rzp = new Razorpay({ key_id: RZP_KEY_ID, key_secret: RZP_SECRET });
  return _rzp;
}

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
    order.receipt_no = order.receipt_no || `RCPT${Date.now()}`;

    // Create the payment order: a real Razorpay order in test/live mode, or a
    // synthetic id while mocking.
    let paymentOrderId;
    if (MOCK_PAYMENTS) {
      paymentOrderId = `mock_order_${crypto.randomBytes(8).toString("hex")}`;
    } else {
      const rzpOrder = await razorpay().orders.create({
        amount: amountInPaise,
        currency: "INR",
        receipt: order.receipt_no,
      });
      paymentOrderId = rzpOrder.id;
    }

    order.status = "pending";
    order.updatedBy = new Date();
    await order.save();

    return res.status(200).json({
      message: "Payment initiated",
      data: {
        paymentOrderId,
        amount: amountInPaise,
        currency: "INR",
        // Never expose the secret — only the publishable key id.
        keyId: RZP_KEY_ID || null,
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
        .createHmac("sha256", RZP_SECRET)
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

    // Payment landed → tell the customer their spot is pending confirmation.
    await notifyWaitlisted(order);

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
const refundOrderPayment = async (order, amountRupeesOverride) => {
  // Full refund by default; a partial amount (e.g. a reschedule price drop) may
  // be passed explicitly.
  const amountRupees = amountRupeesOverride != null ? amountRupeesOverride : (order.grand_total ?? 0);
  const amountPaise = Math.round(amountRupees * 100);

  if (MOCK_PAYMENTS) {
    return {
      id: `mock_rfnd_${crypto.randomBytes(8).toString("hex")}`,
      status: "processed",
      amount: amountRupees,
      // A fake RRN so the mock flow exercises the same fields as live.
      rrn: `MOCK${crypto.randomBytes(5).toString("hex").toUpperCase()}`,
      at: new Date(),
    };
  }

  // ---- Real refund (test/live) ----
  const refund = await razorpay().payments.refund(order.payment_id, { amount: amountPaise, speed: "normal" });
  // The bank reference (RRN/UTR/ARN) lives under acquirer_data; it may only
  // appear once the refund is processed, so it can be null at creation time.
  const acq = refund.acquirer_data || {};
  return {
    id: refund.id,
    status: refund.status,
    amount: (refund.amount ?? amountPaise) / 100,
    rrn: acq.rrn || acq.utr || acq.arn || null,
    at: new Date(),
  };
};

/**
 * Fetches the current refund status from Razorpay. Mocked: echoes what's stored
 * on the order. When live, calls `razorpay.refunds.fetch(order.refund.id)`.
 */
/**
 * Live refund status + bank reference (RRN/UTR/ARN) from Razorpay. The RRN is
 * assigned by the bank after the refund is processed, so it's often null at
 * creation and only appears on a later fetch — which is why we re-query here.
 * Returns { status, rrn } (or null when there's no refund).
 */
const fetchRefundStatus = async (order) => {
  if (!order.refund?.id) return null;
  if (MOCK_PAYMENTS) {
    return { status: order.refund.status || "processed", rrn: order.refund.rrn || null };
  }

  const r = await razorpay().refunds.fetch(order.refund.id);
  const acq = r.acquirer_data || {};
  return { status: r.status, rrn: acq.rrn || acq.utr || acq.arn || null };
};

/**
 * Reusable gateway helpers so other flows (e.g. Golden Pass) can charge via the
 * same Razorpay setup without duplicating key/mode logic.
 */
async function createGatewayOrder(amountPaise, receipt) {
  if (MOCK_PAYMENTS) {
    return { paymentOrderId: `mock_order_${crypto.randomBytes(8).toString("hex")}`, mock: true };
  }
  // payment_capture: 1 → Razorpay auto-captures on success, so the payment is
  // immediately captured (and therefore refundable). Without it a payment can
  // sit "authorized" and a refund attempted right after would fail.
  const rzpOrder = await razorpay().orders.create({ amount: amountPaise, currency: "INR", receipt, payment_capture: 1 });
  return { paymentOrderId: rzpOrder.id, mock: false };
}

/** Constant-time HMAC check of a Razorpay callback. */
function verifyGatewaySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature }) {
  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) return false;
  const expected = crypto
    .createHmac("sha256", RZP_SECRET)
    .update(`${razorpay_order_id}|${razorpay_payment_id}`)
    .digest("hex");
  return (
    expected.length === razorpay_signature.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(razorpay_signature))
  );
}

module.exports = {
  createPayment,
  verifyPayment,
  refundOrderPayment,
  fetchRefundStatus,
  createGatewayOrder,
  verifyGatewaySignature,
  MOCK_PAYMENTS,
  RZP_KEY_ID,
};
