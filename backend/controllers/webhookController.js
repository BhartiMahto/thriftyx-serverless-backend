const crypto = require("crypto");
const { finalizeOrderPaid } = require("./paymentController");
const { finalizeApplicationPaid } = require("./eventApplicationController");
const { finalizeTripPaid } = require("./tripController");

/**
 * Razorpay webhook — the AUTHORITATIVE way a payment becomes a confirmed booking.
 *
 * The browser's /verify call can be missed (user closes the page after a UPI
 * payment, network drop…), leaving a captured payment with a stuck booking. This
 * endpoint is called by Razorpay server-to-server whenever a payment is captured,
 * so the booking is finalized regardless of the client.
 *
 * Signature: Razorpay signs the RAW request body with the webhook secret
 * (X-Razorpay-Signature). We verify it against RAZORPAY_WEBHOOK_SECRET.
 *
 * Always replies 200 (after verifying) so Razorpay doesn't retry-storm; the
 * finalization itself is best-effort + idempotent and logged.
 */
const razorpayWebhook = async (req, res) => {
  try {
    const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) {
      console.error("razorpayWebhook: RAZORPAY_WEBHOOK_SECRET not set — rejecting");
      return res.status(500).json({ message: "Webhook not configured" });
    }
    const signature = req.headers["x-razorpay-signature"];
    const raw = req.rawBody || Buffer.from(JSON.stringify(req.body || {}));
    const expected = crypto.createHmac("sha256", secret).update(raw).digest("hex");
    const ok =
      signature &&
      expected.length === String(signature).length &&
      crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(signature)));
    if (!ok) {
      console.error("razorpayWebhook: bad signature");
      return res.status(400).json({ message: "Invalid signature" });
    }

    const event = req.body?.event;
    const payment = req.body?.payload?.payment?.entity;

    if ((event === "payment.captured" || event === "order.paid") && payment) {
      const rzpOrderId = payment.order_id;
      const paymentId = payment.id;
      // Try each booking type; the first that matches this gateway order wins.
      let result = await finalizeOrderPaid(rzpOrderId, paymentId);
      if (!result.matched) result = await finalizeApplicationPaid(rzpOrderId, paymentId);
      if (!result.matched) result = await finalizeTripPaid(rzpOrderId, paymentId);
      console.log(`razorpayWebhook ${event} ${rzpOrderId} ${paymentId}:`, JSON.stringify(result));
    } else {
      console.log("razorpayWebhook: ignored event", event);
    }

    return res.status(200).json({ ok: true });
  } catch (e) {
    // 200 so Razorpay doesn't keep retrying; the error is logged for follow-up.
    console.error("razorpayWebhook error:", e.message);
    return res.status(200).json({ ok: true });
  }
};

module.exports = { razorpayWebhook };
