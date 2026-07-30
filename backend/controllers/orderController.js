const Order = require("../models/orderModel");
const Cart = require("../models/cartModel");
const Event = require("../models/EventModel");
const Coupon = require("../models/couponModel");
const { evaluateCoupon } = require("./couponController");
const { refundOrderPayment, fetchRefundStatus } = require("./paymentController");
const { ensureTicket, ensureInvoice, attendeesOf } = require("../utils/documents");
const { verifyTicket } = require("../utils/ticketToken");
const { consumeCredit, refundCredit } = require("./membershipController");

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
    const { cart_item_id, isTnC_accepted, attendee_details, attendees, couponCode } = req.body;

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

    // Hand any spent pass credit back (solo pass booking OR the free seat of a
    // paid group booking). Null the id (persisted below) so it can't be
    // refunded twice by a later transition.
    if (order.membership_id) {
      try { await refundCredit(order.membership_id); } catch (e) { console.error("credit refund failed:", e.message); }
      order.membership_id = null;
    }

    await order.save();

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
