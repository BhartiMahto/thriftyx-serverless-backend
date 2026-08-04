const Order = require("../models/orderModel");
const Cart = require("../models/cartModel");
const Event = require("../models/EventModel");
const Coupon = require("../models/couponModel");
const { evaluateCoupon } = require("./couponController");
const {
  refundOrderPayment, fetchRefundStatus,
  createGatewayOrder, verifyGatewaySignature, RZP_KEY_ID,
} = require("./paymentController");
const { ensureTicket, ensureInvoice, attendeesOf } = require("../utils/documents");
const { verifyTicket } = require("../utils/ticketToken");
const { consumeCredit, refundCredit } = require("./membershipController");
const { notifyOrder, niceDate, SUPPORT } = require("../utils/notify");

/**
 * Maps an Order to ONE flat `Attendee` row PER PERSON on the booking. A
 * 2-ticket order yields two rows so the host sees and checks in each guest
 * individually. Row id is `${orderId}:${index}` so the check-in endpoint can
 * target a single attendee. Kept in one place so the contract can't drift.
 */
const toAttendeeRows = (order) => {
  const ticketNames = Array.isArray(order.tickets)
    ? order.tickets.map((t) => t?.name).filter(Boolean)
    : [];
  const ticketType = ticketNames.join(", ") || "—";
  const people = attendeesOf(order);
  const total = people.length;

  return people.map((p, i) => ({
    // Composite id: order + attendee index. Single-person orders still read
    // cleanly (index 0).
    id: `${order._id}:${i}`,
    orderId: order.order_id || null,
    seat: i + 1,
    partySize: total,
    name: p.name || order.user_id?.name || null,
    email: p.email || order.attendee_details?.email || order.user_id?.email || null,
    phone: p.phone || order.attendee_details?.phone || order.user_id?.phone || null,
    gender: p.gender || order.user_id?.gender || null,
    age: p.age ?? null,
    maritalStatus: p.maritalStatus || null,
    reasonToJoin: p.reasonToJoin || null,
    ticketType: total > 1 ? `${ticketType} (${i + 1}/${total})` : ticketType,
    // Admin shows a binary paid/unpaid; backend tracks a 4-state order status.
    paymentStatus: order.status === "completed" ? "paid" : "unpaid",
    orderStatus: order.status,
    registrationDate: order.createdBy || null,
    // Per-attendee check-in; falls back to the order flag for legacy orders.
    checkedIn: Boolean(p.checkedIn ?? order.checkedIn),
    checkedInAt: p.checkedInAt || order.checkedInAt || null,
    city: order.event_id?.city || order.user_id?.city || null,
    venue: order.event_id?.venue_name || order.event_id?.venue || null,
    grandTotal: order.grand_total ?? 0,
  }));
};

/** POST /api/order — customer places an order from a cart item. */
const createOrder = async (req, res) => {
  // Held outside the try so the catch can hand a spent pass credit back.
  let claimedPass = null;
  try {
    const { cart_item_id, isTnC_accepted, attendee_details, attendees, couponCode, event_city } = req.body;

    // Normalise the per-attendee list. New checkout sends `attendees` (one per
    // ticket); older callers send a single `attendee_details`. Either way we
    // store both: `attendees[]` for per-person check-in, `attendee_details` for
    // the booker/invoice.
    const cleanAttendee = (a) => ({
      name: a?.name ?? null,
      email: a?.email ?? null,
      phone: a?.phone ?? null,
      gender: a?.gender ?? null,
      age: a?.age ?? null,
      DOB: a?.DOB ?? null,
      city: a?.city ?? null,
      maritalStatus: a?.maritalStatus ?? null,
      reasonToJoin: a?.reasonToJoin ? String(a.reasonToJoin).trim().slice(0, 1000) : null,
    });
    const attendeeList = Array.isArray(attendees) && attendees.length
      ? attendees.map(cleanAttendee)
      : attendee_details
        ? [cleanAttendee(attendee_details)]
        : [];

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

    // How many tickets on this booking (a pass covers only ONE — the holder's).
    const qty = Array.isArray(cart.tickets)
      ? cart.tickets.reduce((n, t) => n + (Number(t.count ?? t.quantity ?? 1) || 1), 0)
      : 1;

    // Golden Pass: covers the HOLDER's own seat only. Claimed atomically so
    // concurrent bookings can't overspend the pass. Coupons are ignored when a
    // pass is in play.
    //   • Solo booking (qty 1)  → fully free + auto-confirmed (skips waitlist).
    //   • With friends (qty >1) → holder's seat free, the remaining seats are
    //     paid and go through the waitlist like any booking.
    claimedPass = await consumeCredit(req.user._id);
    const passCoversWholeOrder = Boolean(claimedPass) && qty <= 1;

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

    // A fully pass-covered (solo) booking costs nothing and is confirmed
    // immediately. A pass-with-friends booking is a normal paid order for the
    // friends' seats (the holder's seat was already excluded from the cart
    // amounts by the client) and follows the pay-then-waitlist flow.
    const grandTotal = passCoversWholeOrder
      ? 0
      : Math.max(0, Math.round((cart.grand_total - discount) * 100) / 100);

    const order = await Order.create({
      user_id: req.user._id,
      event_id: cart.event_id,
      tickets: cart.tickets,
      total_price: passCoversWholeOrder ? 0 : cart.total_price,
      booking_fee: passCoversWholeOrder ? 0 : cart.booking_fee,
      gst: passCoversWholeOrder ? 0 : cart.gst,
      coupon_code: appliedCode,
      discount,
      grand_total: grandTotal,
      // membership_id is set whenever a credit was spent (solo OR the free seat
      // of a group booking) so the credit can be handed back on cancel/reject.
      membership_id: claimedPass ? claimedPass._id : null,
      // paidByPass only for the fully-free solo booking; a group booking still
      // collects money for the friends' seats.
      paidByPass: passCoversWholeOrder,
      // True when a pass covered ONE seat of a paid group booking.
      passSeat: Boolean(claimedPass) && !passCoversWholeOrder,
      status: passCoversWholeOrder ? "completed" : "in_progress",
      applicationStatus: passCoversWholeOrder ? "confirmed" : "waitlist",
      isTnC_accepted: true,
      // Booker / invoice "bill to" = the first attendee.
      attendee_details: attendeeList[0] || undefined,
      // Full per-person list (one QR + one check-in each).
      attendees: attendeeList,
      // Which city/venue of a multi-city event this booking is for.
      event_city: event_city ? String(event_city).trim() : null,
      order_id: `THX${Date.now()}${Math.floor(Math.random() * 1000)}`,
      createdBy: new Date(),
      updatedBy: new Date(),
    });

    await Cart.findByIdAndDelete(cart_item_id);

    // A fully pass-covered (solo) booking is already paid + confirmed → issue
    // the ticket now. A group booking waits for payment + host confirmation.
    if (passCoversWholeOrder) {
      try {
        await ensureTicket(order);
      } catch (docErr) {
        console.error("Pass ticket generation failed:", docErr.message);
      }
    }

    return res.status(201).json({
      message: passCoversWholeOrder ? "Booking confirmed with your Golden Pass" : "Order Created",
      data: {
        _id: order._id,
        order_id: order.order_id,
        status: order.status,
        paidByPass: passCoversWholeOrder,
        // Signals the client that a pass covered one seat of a paid group booking.
        passSeat: Boolean(claimedPass) && !passCoversWholeOrder,
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
      .populate("event_id", "name type city venue venue_name date image start_time locations")
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

    const wasPaid = order.status === "completed";
    order.status = "cancelled";
    order.cancelledAt = new Date();
    order.updatedBy = new Date();

    // Hand any spent pass credit back (solo pass booking OR the free seat of a
    // paid group booking). Null the id (persisted below) so it can't be
    // refunded twice by a later transition.
    if (order.membership_id) {
      try { await refundCredit(order.membership_id); } catch (e) { console.error("credit refund failed:", e.message); }
      order.membership_id = null;
    }

    // Auto-refund a paid (money) booking on self-cancel, provided it's before
    // the refund cutoff (REFUND_CUTOFF_HOURS before the event starts). Because
    // the CUSTOMER is backing out, the non-refundable 5% platform fee is
    // retained; we refund (grand total − platform fee). After the cutoff the
    // seat is still released, but no automatic refund is issued.
    const REFUND_CUTOFF_HOURS = 24;
    const round2 = (n) => Math.round(n * 100) / 100;
    const platformFee = order.booking_fee ?? 0;
    const refundAmount = round2((order.grand_total ?? 0) - platformFee);
    let refundNote = null;
    const eligibleForMoneyRefund =
      wasPaid && !order.paidByPass && refundAmount > 0 &&
      order.payment_id && !order.refund?.id;

    if (eligibleForMoneyRefund) {
      let evDate = null;
      try {
        await order.populate("event_id", "date");
        evDate = order.event_id?.date ? new Date(order.event_id.date) : null;
      } catch { /* no event date → treat as refundable */ }
      const cutoff = evDate ? evDate.getTime() - REFUND_CUTOFF_HOURS * 3600 * 1000 : Infinity;
      const beforeCutoff = Date.now() < cutoff;

      if (beforeCutoff) {
        try {
          // Partial refund: retain the 5% platform fee.
          order.refund = await refundOrderPayment(order, refundAmount);
          refundNote = `We retain the 5% platform fee (₹${platformFee}); ₹${refundAmount} is being refunded.`;
        } catch (e) {
          console.error("cancel refund failed:", e.message);
          order.refund = { id: null, status: "failed", amount: refundAmount, at: new Date() };
          refundNote = "Refund could not be initiated automatically — our team will process it.";
        }
      } else {
        refundNote = `Cancelled within ${REFUND_CUTOFF_HOURS}h of the event — no automatic refund. Contact support if you think this is a mistake.`;
      }
    }

    await order.save();

    // Confirmation message to the customer (best-effort).
    try {
      await order.populate("user_id", "email phone name");
      await order.populate("event_id", "name");
      const ev = order.event_id?.name ? ` for "${order.event_id.name}"` : "";
      let body;
      if (order.refund?.id && order.refund?.status !== "failed") {
        const ref = order.refund.rrn || order.refund.id;
        body =
          `Your booking${ev} has been cancelled. We retain the 5% platform fee (₹${platformFee}); ` +
          `₹${order.refund.amount} is being refunded to your original payment method (ref ${ref}), ` +
          `usually within 5–7 business days. Questions? ${SUPPORT}\n— IRL Social Hive`;
      } else {
        body =
          `Your booking${ev} has been cancelled. ${refundNote || ""} Questions? ${SUPPORT}\n— IRL Social Hive`;
      }
      await notifyOrder(order, { subject: `Booking cancelled — ${order.event_id?.name || "IRL Social Hive"}`, body });
    } catch (e) { console.error("cancel notify:", e.message); }

    return res.status(200).json({
      message: "Booking cancelled",
      data: {
        _id: order._id,
        status: order.status,
        cancelledAt: order.cancelledAt,
        platformFeeRetained: eligibleForMoneyRefund ? platformFee : 0,
        refund: order.refund?.id || order.refund?.status ? order.refund : null,
        refundNote,
      },
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
        // Per-person list so the booker sees each guest and who's checked in.
        attendees: attendeesOf(order).map((p, i) => ({
          seat: i + 1,
          name: p.name || null,
          gender: p.gender || null,
          age: p.age ?? null,
          checkedIn: Boolean(p.checkedIn),
        })),
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

    // Ensure the attendees array exists (migrate legacy single-attendee orders).
    if (!Array.isArray(order.attendees) || !order.attendees.length) {
      order.attendees = attendeesOf(order).map((p) => ({ ...(p.toObject ? p.toObject() : p) }));
    }
    const idx = Number.isInteger(decoded.ai) && decoded.ai >= 0 && decoded.ai < order.attendees.length
      ? decoded.ai
      : 0;
    const person = order.attendees[idx];

    const alreadyIn = Boolean(person.checkedIn);
    const now = new Date();
    if (!alreadyIn) {
      person.checkedIn = true;
      person.checkedInAt = now;
      order.checkedIn = order.attendees.every((a) => a.checkedIn);
      order.checkedInAt = order.checkedIn ? now : order.checkedInAt;
      order.updatedBy = now;
      await order.save();
    }

    const inCount = order.attendees.filter((a) => a.checkedIn).length;
    return res.status(200).json({
      message: alreadyIn ? "Already checked in" : "Checked in",
      valid: true,
      alreadyCheckedIn: alreadyIn,
      data: {
        orderId: order.order_id,
        attendee: { name: person.name || null, phone: person.phone || null },
        // Which guest this QR is and party progress, e.g. "Guest 2 of 3".
        guest: `${idx + 1} of ${order.attendees.length}`,
        partyCheckedIn: `${inCount}/${order.attendees.length}`,
        ticket: Array.isArray(order.tickets) ? order.tickets.map((t) => t?.name).filter(Boolean).join(", ") : "",
        event: order.event_id?.name || null,
        checkedInAt: person.checkedInAt,
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

    // Hand back the pass credit if one was spent on this booking (a solo
    // pass booking OR the free seat of a paid group booking). Null the id so a
    // later transition can't double-refund it.
    if (order.membership_id) {
      try { await refundCredit(order.membership_id); } catch (e) { console.error("credit refund failed:", e.message); }
      order.membership_id = null;
    }

    if (order.paidByPass) {
      // Fully pass-covered — no money to refund, only the credit (done above).
      order.refund = { id: null, status: "credit_returned", amount: 0, at: new Date() };
    } else if (order.status === "completed" && !order.refund?.id) {
      // Auto-refund a paid application (incl. the friends' seats of a group
      // booking). Unpaid ones just get rejected.
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
      data: orders.flatMap(toAttendeeRows),
      statusCode: 200,
    });
  } catch (error) {
    console.error("getEventAttendees error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * PATCH /api/admin/attendees/:orderId/check-in — flips one attendee's check-in
 * state. Body: { checkedIn?, attendeeIndex? }. The orderId may arrive as a
 * composite "orderId:index" (matching the attendee row id); an explicit
 * `attendeeIndex` in the body wins over that.
 */
const toggleCheckIn = async (req, res) => {
  try {
    const { checkedIn } = req.body;
    // Accept the index from the body, or parse it off a composite "id:index".
    const [rawId, idxFromId] = String(req.params.orderId).split(":");
    const idx = Number.isInteger(req.body.attendeeIndex)
      ? req.body.attendeeIndex
      : (idxFromId !== undefined ? Number(idxFromId) : 0);

    const order = await Order.findById(rawId);
    if (!order) {
      return res.status(404).json({ message: "Order not found", statusCode: 404 });
    }

    // Ensure the attendees array exists (migrate legacy single-attendee orders).
    if (!Array.isArray(order.attendees) || !order.attendees.length) {
      order.attendees = attendeesOf(order).map((p) => ({ ...(p.toObject ? p.toObject() : p) }));
    }
    if (idx < 0 || idx >= order.attendees.length) {
      return res.status(400).json({ message: "Invalid attendee", statusCode: 400 });
    }

    const now = new Date();
    const target = order.attendees[idx];
    const next = typeof checkedIn === "boolean" ? checkedIn : !target.checkedIn;
    target.checkedIn = next;
    target.checkedInAt = next ? now : null;

    // Order-level flag = every attendee is in (keeps existing UI/analytics sane).
    order.checkedIn = order.attendees.every((a) => a.checkedIn);
    order.checkedInAt = order.checkedIn ? now : null;
    order.updatedBy = now;
    await order.save();

    await order.populate("user_id", "name email city phone");
    await order.populate("event_id", "name type city venue venue_name");

    // Return the single row that changed.
    const row = toAttendeeRows(order)[idx];
    return res.status(200).json({
      message: "Check-in updated",
      data: row,
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

/**
 * PATCH /api/order/:id/reschedule — move a paid booking to another upcoming
 * occurrence of the same event. Recomputes the total on the new date:
 *   • cheaper/equal → move now (auto-refund any difference)
 *   • costs more    → returns { needsPayment, payment } so the client collects
 *     the difference via Razorpay, then calls again with the razorpay_* fields.
 * The moved booking re-enters the waitlist for the new date's host approval.
 * Body: { eventId, razorpay_order_id?, razorpay_payment_id?, razorpay_signature? }
 */
const rescheduleOrder = async (req, res) => {
  try {
    const { eventId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!eventId) return res.status(400).json({ message: "eventId is required", statusCode: 400 });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Order not found", statusCode: 404 });
    if (String(order.user_id) !== String(req.user._id)) {
      return res.status(403).json({ message: "This booking is not yours", statusCode: 403 });
    }
    if (order.status !== "completed") {
      return res.status(409).json({ message: "Only a paid booking can be rescheduled", statusCode: 409 });
    }
    if (order.applicationStatus === "rejected") {
      return res.status(409).json({ message: "A rejected booking can't be rescheduled", statusCode: 409 });
    }
    if (order.checkedIn) {
      return res.status(409).json({ message: "Cannot reschedule after check-in", statusCode: 409 });
    }
    if (String(order.event_id) === String(eventId)) {
      return res.status(400).json({ message: "Pick a different date", statusCode: 400 });
    }

    const target = await Event.findById(eventId);
    if (!target) return res.status(404).json({ message: "That event was not found", statusCode: 404 });
    const tDate = target.date ? new Date(target.date) : null;
    if (tDate && tDate.getTime() <= Date.now()) {
      return res.status(400).json({ message: "That date has already passed", statusCode: 400 });
    }

    // Paid seats on this order (a pass-covered holder seat is free).
    const qty = Array.isArray(order.tickets)
      ? order.tickets.reduce((n, t) => n + (Number(t.count ?? t.quantity ?? 1) || 1), 0)
      : 1;
    const paidSeats = order.paidByPass ? 0 : (order.passSeat ? Math.max(0, qty - 1) : qty);

    // Unit price on the target: same ticket name if present, else the cheapest.
    const wantName = order.tickets?.[0]?.name;
    const tTickets = Array.isArray(target.tickets) ? target.tickets : [];
    const priceOf = (t) => Number(t?.price) || 0;
    let unit = 0;
    if (tTickets.length) {
      const match = tTickets.find((t) => t.name === wantName);
      unit = match ? priceOf(match) : Math.min(...tTickets.map(priceOf));
    }

    const round2 = (n) => Math.round(n * 100) / 100;
    const newTotalPrice = round2(unit * paidSeats);
    const newFee = round2(newTotalPrice * 0.05);
    const newGst = round2(newTotalPrice * 0.18);
    const newGrand = round2(newTotalPrice + newFee + newGst);
    const oldGrand = order.grand_total ?? 0;
    const diff = round2(newGrand - oldGrand);
    const diffPaise = Math.round(Math.abs(diff) * 100);

    // Costs more → collect the difference first (unless mock mode).
    if (diff > 0) {
      if (!razorpay_order_id) {
        const pay = await createGatewayOrder(diffPaise, `resched_${String(order._id).slice(-10)}`);
        if (!pay.mock) {
          return res.status(200).json({
            message: "Payment required",
            data: {
              needsPayment: true,
              priceDiff: diff,
              newTotal: newGrand,
              payment: { paymentOrderId: pay.paymentOrderId, amount: diffPaise, currency: "INR", keyId: RZP_KEY_ID, mock: false },
            },
            statusCode: 200,
          });
        }
        // mock mode → fall through and just move.
      } else {
        const ok = verifyGatewaySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature });
        if (!ok) return res.status(400).json({ message: "Payment verification failed", statusCode: 400 });
      }
    }

    // Cheaper → refund the difference to the original payment.
    if (diff < 0 && order.payment_id && !order.paidByPass) {
      try {
        order.refund = await refundOrderPayment(order, Math.abs(diff));
      } catch (e) {
        console.error("reschedule refund failed:", e.message);
      }
    }

    // Move the seat. The booking keeps its current approval state — a confirmed
    // booking stays confirmed for the new date (no re-approval needed). Reset
    // check-in and clear the generated docs so the ticket/invoice regenerate for
    // the new date on next view.
    order.event_id = eventId;
    order.total_price = newTotalPrice;
    order.booking_fee = newFee;
    order.gst = newGst;
    order.grand_total = newGrand;
    order.checkedIn = false;
    order.checkedInAt = null;
    order.ticket_url = null;
    order.invoice_url = null;
    order.invoice_no = null;
    order.updatedBy = new Date();
    await order.save();

    // Confirmation message to the customer (best-effort).
    try {
      await order.populate("user_id", "email phone name");
      const when = niceDate(target.date) + (target.start_time ? ` at ${target.start_time}` : "");
      let priceLine = "";
      if (diff > 0) priceLine = ` The ₹${diff} difference was collected.`;
      else if (diff < 0 && order.refund?.id) {
        const ref = order.refund.rrn || order.refund.id;
        priceLine = ` ₹${Math.abs(diff)} is being refunded (ref ${ref}).`;
      }
      await notifyOrder(order, {
        subject: `Booking rescheduled — ${target.name || "IRL Social Hive"}`,
        body:
          `Your booking has been moved to "${target.name || "your event"}" on ${when}` +
          `${target.city ? ` in ${target.city}` : ""}.${priceLine} Questions? ${SUPPORT}\n— IRL Social Hive`,
      });
    } catch (e) { console.error("reschedule notify:", e.message); }

    return res.status(200).json({
      message: "Booking rescheduled",
      data: {
        _id: order._id,
        event_id: eventId,
        grand_total: newGrand,
        applicationStatus: order.applicationStatus,
        rescheduled: true,
      },
      statusCode: 200,
    });
  } catch (err) {
    console.error("rescheduleOrder error:", err);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * PATCH /api/admin/bookings/:id/refund — admin refunds a single booking and
 * cancels it (frees the seat, drops it off "Who's coming"). Refunds money via
 * Razorpay and returns any Golden Pass credit. Idempotent: refuses if already
 * refunded.
 */
const refundBooking = async (req, res) => {
  try {
    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Booking not found", statusCode: 404 });
    if (order.refund?.id) {
      return res.status(409).json({ message: "This booking is already refunded", statusCode: 409 });
    }

    let refund = null;
    if (!order.paidByPass && (order.grand_total ?? 0) > 0 && order.payment_id) {
      try {
        refund = await refundOrderPayment(order);
        order.refund = refund;
      } catch (e) {
        console.error("refundBooking failed:", e.message);
        return res.status(502).json({ message: "Refund failed at the payment gateway", statusCode: 502 });
      }
    }

    // Return any Golden Pass credit spent on this booking.
    if (order.membership_id) {
      try { await refundCredit(order.membership_id); } catch (e) { console.error("credit refund failed:", e.message); }
      order.membership_id = null;
    }

    order.status = "cancelled";
    order.cancelledAt = new Date();
    order.updatedBy = new Date();
    await order.save();

    // Let the member know their booking was refunded.
    try {
      await order.populate("user_id", "email phone name");
      await order.populate("event_id", "name");
      const amt = order.refund?.amount;
      const ref = order.refund?.rrn || order.refund?.id;
      await notifyOrder(order, {
        subject: `Refund processed — ${order.event_id?.name || "IRL Social Hive"}`,
        body:
          `Hi, your booking${order.event_id?.name ? ` for "${order.event_id.name}"` : ""} has been cancelled and refunded` +
          `${amt ? ` (₹${amt})` : ""}${ref ? `, ref ${ref}` : ""}. Refunds can take 5–7 business days. ` +
          `Questions? ${SUPPORT}\n— IRL Social Hive`,
      });
    } catch (e) { console.error("refund notify:", e.message); }

    return res.status(200).json({
      message: "Booking refunded",
      data: { _id: order._id, status: order.status, refund: order.refund || null },
      statusCode: 200,
    });
  } catch (err) {
    console.error("refundBooking error:", err);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * PATCH /api/order/:id/change-city — move a booking to another CITY of the same
 * multi-city event. Same price/date, so there's no payment — only the venue/city
 * change. The ticket regenerates with the new venue on next view.
 * Body: { city }
 */
const changeBookingCity = async (req, res) => {
  try {
    const city = (req.body.city || "").trim();
    if (!city) return res.status(400).json({ message: "city is required", statusCode: 400 });

    const order = await Order.findById(req.params.id);
    if (!order) return res.status(404).json({ message: "Booking not found", statusCode: 404 });
    if (String(order.user_id) !== String(req.user._id)) {
      return res.status(403).json({ message: "This booking is not yours", statusCode: 403 });
    }
    if (order.status === "cancelled") {
      return res.status(409).json({ message: "This booking is cancelled", statusCode: 409 });
    }
    if (order.checkedIn) {
      return res.status(409).json({ message: "Cannot change city after check-in", statusCode: 409 });
    }

    const event = await Event.findById(order.event_id).select("locations city venue venue_name");
    const locs = (event && event.locations) || [];
    const match = locs.find((l) => (l.city || "").trim().toLowerCase() === city.toLowerCase());
    if (!match) {
      return res.status(400).json({ message: "That city isn't available for this event", statusCode: 400 });
    }

    order.event_city = match.city;
    order.ticket_url = null;   // regenerate the ticket with the new venue on next view
    order.updatedBy = new Date();
    await order.save();

    return res.status(200).json({
      message: "City changed",
      data: { _id: order._id, event_city: match.city, venue: match.venue },
      statusCode: 200,
    });
  } catch (err) {
    console.error("changeBookingCity error:", err);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
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
  rescheduleOrder,
  changeBookingCity,
  refundBooking,
  getOrderTicket,
  getTicketPdf,
  getInvoicePdf,
  verifyTicketScan,
  getEventAttendees,
  toggleCheckIn,
};
