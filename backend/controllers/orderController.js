const Order = require("../models/orderModel");
const Cart = require("../models/cartModel");
const Event = require("../models/EventModel");
const Coupon = require("../models/couponModel");
const { evaluateCoupon } = require("./couponController");
const { refundOrderPayment, fetchRefundStatus } = require("./paymentController");
const { ensureTicket, ensureInvoice } = require("../utils/documents");
const { verifyTicket } = require("../utils/ticketToken");
const { consumeCredit, refundCredit } = require("./membershipController");

/**
 * Maps an Order (with user_id/event_id populated) to the flat `Attendee` shape
 * the admin panel renders. Kept in one place so the contract can't drift.
 */
const toAttendee = (order) => {
  const ticketNames = Array.isArray(order.tickets)
    ? order.tickets.map((t) => t?.name).filter(Boolean)
    : [];

  // Prefer what was entered at checkout; fall back to the account profile.
  const details = order.attendee_details || {};

  return {
    id: String(order._id),
    orderId: order.order_id || null,
    name: details.name || order.user_id?.name || null,
    email: details.email || order.user_id?.email || null,
    phone: details.phone || order.user_id?.phone || null,
    gender: details.gender || order.user_id?.gender || null,
    age: details.age ?? null,
    maritalStatus: details.maritalStatus || order.user_id?.maritalStatus || null,
    reasonToJoin: details.reasonToJoin || order.user_id?.reasonToJoin || null,
    ticketType: ticketNames.join(", ") || "—",
    // Admin shows a binary paid/unpaid; backend tracks a 4-state order status.
    paymentStatus: order.status === "completed" ? "paid" : "unpaid",
    orderStatus: order.status,
    registrationDate: order.createdBy || null,
    checkedIn: Boolean(order.checkedIn),
    checkedInAt: order.checkedInAt || null,
    city: order.event_id?.city || order.user_id?.city || null,
    venue: order.event_id?.venue_name || order.event_id?.venue || null,
    grandTotal: order.grand_total ?? 0,
  };
};

/** POST /api/order — customer places an order from a cart item. */
const createOrder = async (req, res) => {
  // Held outside the try so the catch can hand a spent pass credit back.
  let claimedPass = null;
  try {
    const { cart_item_id, isTnC_accepted, attendee_details, couponCode } = req.body;

    if (!cart_item_id) {
      return res.status(400).json({ message: "cart_item_id is required", statusCode: 400 });
    }
    if (!isTnC_accepted) {
      return res
        .status(400)
        .json({ message: "Terms and conditions must be accepted", statusCode: 400 });
    }

    const cart = await Cart.findById(cart_item_id);
    if (!cart) {
      return res.status(404).json({ message: "Cart item not found", statusCode: 404 });
    }

    // The cart is anonymous until checkout; bind it to the authenticated user.
    if (cart.user_id && String(cart.user_id) !== String(req.user._id)) {
      return res.status(403).json({ message: "Cart does not belong to user", statusCode: 403 });
    }

    const event = await Event.findById(cart.event_id);
    if (!event) {
      return res.status(404).json({ message: "Event not found", statusCode: 404 });
    }

    // Golden Pass: if the customer has a usable credit, this booking is FREE and
    // auto-confirmed (skips the waitlist). Claimed atomically so concurrent
    // bookings can't overspend the pass. Coupons are ignored when a pass covers.
    claimedPass = await consumeCredit(req.user._id);

    // Coupon is re-validated and the discount recomputed HERE from the cart's
    // own subtotal — a client-sent discount is never trusted. Usage is recorded
    // atomically so a coupon can't be over-redeemed by concurrent requests.
    let discount = 0;
    let appliedCode = null;
    if (!claimedPass && couponCode) {
      const result = await evaluateCoupon(couponCode, cart.total_price, req.user._id);
      if (!result.ok) {
        return res.status(400).json({ message: result.reason, statusCode: 400 });
      }
      discount = result.discount;
      appliedCode = result.coupon.code;

      // Atomic guard against the total usage limit: only "claim" a slot if
      // usedCount is still below the limit (or the limit is unset).
      const claim = await Coupon.updateOne(
        {
          _id: result.coupon._id,
          $or: [
            { usageLimit: null },
            { $expr: { $lt: ["$usedCount", "$usageLimit"] } },
          ],
        },
        { $inc: { usedCount: 1 } }
      );
      if (claim.modifiedCount === 0) {
        return res.status(400).json({ message: "This coupon has reached its usage limit", statusCode: 400 });
      }
    }

    // Pass-covered bookings cost nothing and are confirmed immediately; all
    // others follow the normal pay-then-waitlist flow.
    const grandTotal = claimedPass
      ? 0
      : Math.max(0, Math.round((cart.grand_total - discount) * 100) / 100);

    const order = await Order.create({
      user_id: req.user._id,
      event_id: cart.event_id,
      tickets: cart.tickets,
      total_price: claimedPass ? 0 : cart.total_price,
      booking_fee: claimedPass ? 0 : cart.booking_fee,
      gst: claimedPass ? 0 : cart.gst,
      coupon_code: appliedCode,
      discount,
      grand_total: grandTotal,
      membership_id: claimedPass ? claimedPass._id : null,
      paidByPass: Boolean(claimedPass),
      status: claimedPass ? "completed" : "in_progress",
      applicationStatus: claimedPass ? "confirmed" : "waitlist",
      isTnC_accepted: true,
      attendee_details: attendee_details
        ? {
            name: attendee_details.name ?? null,
            email: attendee_details.email ?? null,
            phone: attendee_details.phone ?? null,
            gender: attendee_details.gender ?? null,
            age: attendee_details.age ?? null,
            DOB: attendee_details.DOB ?? null,
            city: attendee_details.city ?? null,
            maritalStatus: attendee_details.maritalStatus ?? null,
            reasonToJoin: attendee_details.reasonToJoin
              ? String(attendee_details.reasonToJoin).trim().slice(0, 1000)
              : null,
          }
        : undefined,
      order_id: `THX${Date.now()}${Math.floor(Math.random() * 1000)}`,
      createdBy: new Date(),
      updatedBy: new Date(),
    });

    await Cart.findByIdAndDelete(cart_item_id);

    // A free pass booking is already paid + confirmed → issue the ticket now.
    if (claimedPass) {
      try {
        await ensureTicket(order);
      } catch (docErr) {
        console.error("Pass ticket generation failed:", docErr.message);
      }
    }

    return res.status(201).json({
      message: claimedPass ? "Booking confirmed with your Golden Pass" : "Order Created",
      data: {
        _id: order._id,
        order_id: order.order_id,
        status: order.status,
        paidByPass: Boolean(claimedPass),
        applicationStatus: order.applicationStatus,
        ticket_url: order.ticket_url || null,
      },
      statusCode: 201,
    });
  } catch (error) {
    console.error("createOrder error:", error);
    // Booking failed after a credit was claimed — return it to the pass.
    if (claimedPass) {
      try { await refundCredit(claimedPass._id); } catch (e) { console.error("credit refund failed:", e.message); }
    }
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** GET /api/order/my — orders belonging to the authenticated customer. */
const getMyOrders = async (req, res) => {
  try {
    const orders = await Order.find({ user_id: req.user._id })
      .populate("event_id", "name type city venue venue_name date image start_time")
      .sort({ createdBy: -1 });

    return res.status(200).json({ message: "Orders", data: orders, statusCode: 200 });
  } catch (error) {
    console.error("getMyOrders error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * POST /api/order/:id/rating — attendee rates the event after it has happened.
 *
 * Only allowed for the customer's own paid booking, once the event date has
 * passed ("successful event"). Re-rating overwrites the previous value.
 */
const rateOrder = async (req, res) => {
  try {
    const rating = Number(req.body.rating);
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ message: "Rating must be 1 to 5", statusCode: 400 });
    }

    const order = await Order.findById(req.params.id).populate("event_id", "date name");
    if (!order) {
      return res.status(404).json({ message: "Booking not found", statusCode: 404 });
    }
    if (String(order.user_id) !== String(req.user._id)) {
      return res.status(403).json({ message: "This booking is not yours", statusCode: 403 });
    }
    if (order.status !== "completed") {
      return res.status(400).json({ message: "Only paid bookings can be rated", statusCode: 400 });
    }

    // The event must be over. An event with no date can't be confirmed as past.
    const eventDate = order.event_id?.date ? new Date(order.event_id.date).getTime() : null;
    if (!eventDate || eventDate > Date.now()) {
      return res
        .status(400)
        .json({ message: "You can rate this once the event is over", statusCode: 400 });
    }

    order.rating = rating;
    order.ratingComment = req.body.comment ? String(req.body.comment).trim().slice(0, 1000) : null;
    order.ratedAt = new Date();
    await order.save();

    return res.status(200).json({
      message: "Thanks for rating",
      data: { _id: order._id, rating: order.rating, ratingComment: order.ratingComment },
      statusCode: 200,
    });
  } catch (error) {
    console.error("rateOrder error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** PATCH /api/order/:id/cancel — customer cancels their own booking. */
const cancelOrder = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);

    if (!order) {
      return res.status(404).json({ message: "Order not found", statusCode: 404 });
    }

    if (String(order.user_id) !== String(req.user._id)) {
      return res.status(403).json({ message: "This booking is not yours", statusCode: 403 });
    }

    if (order.status === "cancelled") {
      return res.status(409).json({ message: "Booking is already cancelled", statusCode: 409 });
    }

    if (order.checkedIn) {
      return res
        .status(409)
        .json({ message: "Cannot cancel after check-in", statusCode: 409 });
    }

    order.status = "cancelled";
    order.cancelledAt = new Date();
    order.updatedBy = new Date();
    await order.save();

    // Pass-covered booking → hand the credit back to the membership.
    if (order.paidByPass && order.membership_id) {
      try { await refundCredit(order.membership_id); } catch (e) { console.error("credit refund failed:", e.message); }
    }

    // NOTE: for paid (money) bookings no refund is issued here — payments are
    // mocked. Wire a real Razorpay refund call when live payments are added.
    return res.status(200).json({
      message: "Booking cancelled",
      data: { _id: order._id, status: order.status, cancelledAt: order.cancelledAt },
      statusCode: 200,
    });
  } catch (error) {
    console.error("cancelOrder error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** GET /api/order/:id/ticket — ticket payload for the customer's own booking. */
const getOrderTicket = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id).populate(
      "event_id",
      "name type city venue venue_name date start_time end_time image"
    );

    if (!order) {
      return res.status(404).json({ message: "Order not found", statusCode: 404 });
    }

    if (String(order.user_id) !== String(req.user._id)) {
      return res.status(403).json({ message: "This booking is not yours", statusCode: 403 });
    }

    if (order.status === "cancelled") {
      return res.status(409).json({ message: "Booking was cancelled", statusCode: 409 });
    }

    const event = order.event_id || {};
    const details = order.attendee_details || {};

    // Lazily generate the PDFs if they're eligible but not yet built (covers
    // orders paid/confirmed before this feature existed). Non-fatal.
    try { await ensureInvoice(order); } catch (e) { console.error("lazy invoice:", e.message); }
    try { await ensureTicket(order); } catch (e) { console.error("lazy ticket:", e.message); }

    return res.status(200).json({
      message: "Ticket",
      data: {
        orderId: order.order_id,
        // Stable per-order string the venue can scan or type in.
        checkInCode: String(order._id).slice(-8).toUpperCase(),
        status: order.status,
        applicationStatus: order.applicationStatus,
        checkedIn: Boolean(order.checkedIn),
        ticketUrl: order.ticket_url || null,
        invoiceNo: order.invoice_no || null,
        attendee: {
          name: details.name || req.user.name || null,
          email: details.email || req.user.email || null,
          phone: details.phone || req.user.phone || null,
        },
        event: {
          name: event.name || null,
          date: event.date || null,
          startTime: event.start_time || null,
          endTime: event.end_time || null,
          venue: event.venue_name || event.venue || null,
          city: event.city || null,
          image: event.image || null,
        },
        tickets: order.tickets || [],
        grandTotal: order.grand_total ?? 0,
        paidByPass: Boolean(order.paidByPass),
        invoiceUrl: order.invoice_url || null,
      },
      statusCode: 200,
    });
  } catch (error) {
    console.error("getOrderTicket error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * Shared loader for the two PDF endpoints: finds the customer's own order,
 * generates the document if missing, and returns its URL. `kind` is
 * 'ticket' | 'invoice'.
 */
const getOrderDocument = (kind) => async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found", statusCode: 404 });
    if (String(order.user_id) !== String(req.user._id)) {
      return res.status(403).json({ message: "This booking is not yours", statusCode: 403 });
    }

    const url = kind === "ticket" ? await ensureTicket(order) : await ensureInvoice(order);
    if (!url) {
      const why =
        kind === "ticket"
          ? "Ticket is available once your booking is paid and confirmed"
          : "Invoice is available once your booking is paid";
      return res.status(409).json({ message: why, statusCode: 409 });
    }
    return res.status(200).json({ message: "Document", data: { url }, statusCode: 200 });
  } catch (error) {
    console.error(`get ${kind} error:`, error);
    return res.status(500).json({ message: "Could not generate the document", statusCode: 500 });
  }
};

const getTicketPdf = getOrderDocument("ticket");
const getInvoicePdf = getOrderDocument("invoice");

/**
 * POST /api/admin/tickets/verify — door staff scan a ticket QR (a signed
 * token). Verifies the signature, checks the booking is paid + confirmed, and
 * marks the attendee checked in. Returns who they are and whether this was a
 * duplicate scan.
 * Body: { token }
 */
const verifyTicketScan = async (req, res) => {
  try {
    const decoded = verifyTicket(req.body.token);
    if (!decoded) {
      return res.status(400).json({ message: "Invalid or expired ticket", valid: false, statusCode: 400 });
    }

    const order = await Order.findById(decoded.oid).populate("event_id", "name date venue venue_name city");
    if (!order) {
      return res.status(404).json({ message: "Ticket not found", valid: false, statusCode: 404 });
    }
    if (order.status !== "completed" || order.applicationStatus !== "confirmed") {
      return res.status(409).json({ message: "Ticket is not valid for entry", valid: false, statusCode: 409 });
    }

    const alreadyIn = Boolean(order.checkedIn);
    if (!alreadyIn) {
      order.checkedIn = true;
      order.checkedInAt = new Date();
      order.updatedBy = new Date();
      await order.save();
    }

    const details = order.attendee_details || {};
    return res.status(200).json({
      message: alreadyIn ? "Already checked in" : "Checked in",
      valid: true,
      alreadyCheckedIn: alreadyIn,
      data: {
        orderId: order.order_id,
        attendee: { name: details.name || null, phone: details.phone || null },
        ticket: Array.isArray(order.tickets) ? order.tickets.map((t) => t?.name).filter(Boolean).join(", ") : "",
        event: order.event_id?.name || null,
        checkedInAt: order.checkedInAt,
      },
      statusCode: 200,
    });
  } catch (error) {
    console.error("verifyTicketScan error:", error);
    return res.status(500).json({ message: "Server Error", valid: false, statusCode: 500 });
  }
};

/**
 * PATCH /api/admin/bookings/:id/decision — admin confirms or rejects a
 * waitlisted application. Rejecting a paid application auto-refunds via Razorpay.
 * Body: { decision: 'confirmed' | 'rejected', reason? }
 */
const decideApplication = async (req, res) => {
  try {
    const { decision, reason } = req.body;
    if (!["confirmed", "rejected"].includes(decision)) {
      return res.status(400).json({ message: "decision must be confirmed or rejected", statusCode: 400 });
    }

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Booking not found", statusCode: 404 });

    if (order.applicationStatus === decision) {
      return res.status(409).json({ message: `Already ${decision}`, statusCode: 409 });
    }

    if (decision === "confirmed") {
      order.applicationStatus = "confirmed";
      order.reviewedAt = new Date();
      order.rejectionReason = null;
      await order.save();

      // Now paid + confirmed → issue the scannable ticket. Non-fatal on failure.
      let ticketUrl = null;
      try {
        ticketUrl = await ensureTicket(order);
      } catch (docErr) {
        console.error("Ticket generation failed for order", String(order._id), docErr.message);
      }

      return res.status(200).json({
        message: "Application confirmed",
        data: { _id: order._id, applicationStatus: "confirmed", ticket_url: ticketUrl },
        statusCode: 200,
      });
    }

    // decision === 'rejected'
    order.applicationStatus = "rejected";
    order.reviewedAt = new Date();
    order.rejectionReason = reason ? String(reason).trim().slice(0, 500) : null;

    // Pass-covered booking → return the credit rather than refunding money.
    if (order.paidByPass && order.membership_id) {
      try { await refundCredit(order.membership_id); } catch (e) { console.error("credit refund failed:", e.message); }
      order.refund = { id: null, status: "credit_returned", amount: 0, at: new Date() };
    } else if (order.status === "completed" && !order.refund?.id) {
      // Auto-refund a paid application. Unpaid ones just get rejected.
      try {
        const refund = await refundOrderPayment(order);
        order.refund = refund;
      } catch (err) {
        console.error("Refund failed for order", order._id, err.message);
        // Reject stands, but flag the refund as failed so the admin can retry.
        order.refund = { id: null, status: "failed", amount: order.grand_total ?? 0, at: new Date() };
      }
    }

    await order.save();
    return res.status(200).json({
      message: "Application rejected",
      data: {
        _id: order._id,
        applicationStatus: "rejected",
        refund: order.refund,
      },
      statusCode: 200,
    });
  } catch (error) {
    console.error("decideApplication error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** GET /api/order/:id/refund-status — customer checks their refund (from Razorpay). */
const getRefundStatus = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Booking not found", statusCode: 404 });
    if (String(order.user_id) !== String(req.user._id)) {
      return res.status(403).json({ message: "This booking is not yours", statusCode: 403 });
    }

    if (!order.refund?.id && order.applicationStatus !== "rejected") {
      return res.status(200).json({ message: "No refund", data: { refunded: false }, statusCode: 200 });
    }

    // Pull the live status from Razorpay (mock echoes the stored value), and
    // keep the stored copy fresh.
    let liveStatus = order.refund?.status ?? null;
    try {
      const s = await fetchRefundStatus(order);
      if (s && s !== order.refund?.status) {
        order.refund.status = s;
        await order.save();
      }
      liveStatus = s ?? liveStatus;
    } catch (err) {
      console.error("fetchRefundStatus error:", err.message);
    }

    return res.status(200).json({
      message: "Refund status",
      data: {
        refunded: Boolean(order.refund?.id),
        refundId: order.refund?.id ?? null,
        status: liveStatus,
        amount: order.refund?.amount ?? null,
        at: order.refund?.at ?? null,
      },
      statusCode: 200,
    });
  } catch (error) {
    console.error("getRefundStatus error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** GET /api/admin/events/:eventId/attendees — admin attendee list for one event. */
const getEventAttendees = async (req, res) => {
  try {
    const orders = await Order.find({ event_id: req.params.eventId })
      .populate("user_id", "name email city phone")
      .populate("event_id", "name type city venue venue_name")
      .sort({ createdBy: -1 });

    return res.status(200).json({
      message: "Attendees",
      data: orders.map(toAttendee),
      statusCode: 200,
    });
  } catch (error) {
    console.error("getEventAttendees error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** PATCH /api/admin/attendees/:orderId/check-in — flips check-in state. */
const toggleCheckIn = async (req, res) => {
  try {
    const { checkedIn } = req.body;
    const order = await Order.findById(req.params.orderId);

    if (!order) {
      return res.status(404).json({ message: "Order not found", statusCode: 404 });
    }

    order.checkedIn = typeof checkedIn === "boolean" ? checkedIn : !order.checkedIn;
    order.checkedInAt = order.checkedIn ? new Date() : null;
    order.updatedBy = new Date();
    await order.save();

    await order.populate("user_id", "name email city phone");
    await order.populate("event_id", "name type city venue venue_name");

    return res.status(200).json({
      message: "Check-in updated",
      data: toAttendee(order),
      statusCode: 200,
    });
  } catch (error) {
    console.error("toggleCheckIn error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

const getAllOrders = async (req, res) => {
  try {
    const orders = await Order.find({})
      .populate("user_id", "name email city")
      .populate("event_id", "name type")
      .select("status createdBy grand_total user_id event_id")

    const flattened = orders.map((order) => ({
      name: order.user_id?.name || null,
      email: order.user_id?.email || null,
      city: order.user_id?.city || null,
      event_name: order.event_id?.name || null,
      event_type: order.event_id?.type || null,
      grand_total: order.grand_total,
      status: order.status,
      createdBy: order.createdBy,
    }));

    res.status(200).json(flattened);
  } catch (error) {
    console.log("Error in fetching orders:", error.message);
    res.status(500).json({
      message: error.message,
    });
  }
};

const downloadOrders = async (req, res) => {
  try {
    const orders = await Order.find()
      .populate("user_id", "name email city")
      .populate("event_id", "name type")
      .select("status createdBy grand_total user_id event_id")
      .lean();

    if (orders.length === 0) {
      return res.status(404).json({ message: "No orders found" });
    }

    const headers = [
      "Customer Name",
      "Email",
      "City",
      "Event Name",
      "Event Type",
      "Grand Total",
      "Status",
      "Created At",
    ];

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", 'attachment; filename="orders.csv"');

    const { Transform } = require("stream");
    const csvTransform = new Transform({
      transform(chunk, encoding, callback) {
        this.push(chunk);
        callback();
      },
    });

    csvTransform.push(`${headers.join(",")}\n`);

    orders.forEach((order) => {
      const row = [
        `"${order.user_id?.name || ""}"`,
        `"${order.user_id?.email || ""}"`,
        `"${order.user_id?.city || ""}"`,
        `"${order.event_id?.name || ""}"`,
        `"${order.event_id?.type || ""}"`,
        order.grand_total || 0,
        `"${order.status || ""}"`,
        `"${
          order.createdBy
            ? new Date(order.createdBy).toLocaleString("en-IN")
            : ""
        }"`,
      ].join(",");

      csvTransform.push(`${row}\n`);
    });

    csvTransform.push(null);

    csvTransform.pipe(res);
  } catch (err) {
    console.error("CSV download error:", err);
    if (!res.headersSent) {
      res.status(500).json({ message: "Error generating CSV file" });
    }
  }
};

const customerCount = async (req, res) => {
  try {
    const count = await Order.countDocuments();
    res.status(200).json({
      success: true,
      totalCustomers: count,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

const paidCustomerCount = async (req, res) => {
  try {
    const count = await Order.countDocuments({ status: "completed" });
    res.status(200).json({
      success: true,
      totalCompletedOrders: count,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

const pendingCustomerCount = async (req, res) => {
  try {
    const count = await Order.countDocuments({ status: "in_progress" });
    res.status(200).json({
      success: true,
      totalPendingOrders: count,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

const avgSpend = async (req, res) => {
  try {
    const result = await Order.aggregate([
      { $match: { status: "completed" } },
      {
        $group: {
          _id: null,
          averageSpend: { $avg: "$grand_total" },
          totalOrders: { $sum: 1 },
        },
      },
    ]);

    const avgSpendValue = result.length ? result[0].averageSpend : 0;
    const totalOrders = result.length ? result[0].totalOrders : 0;

    res.status(200).json({
      success: true,
      averageSpend: avgSpendValue.toFixed(2),
      totalCompletedOrders: totalOrders,
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      message: error.message,
    });
  }
};

module.exports = {
  getAllOrders,
  customerCount,
  paidCustomerCount,
  pendingCustomerCount,
  avgSpend,
  downloadOrders,
  createOrder,
  getMyOrders,
  rateOrder,
  decideApplication,
  getRefundStatus,
  cancelOrder,
  getOrderTicket,
  getTicketPdf,
  getInvoicePdf,
  verifyTicketScan,
  getEventAttendees,
  toggleCheckIn,
};
