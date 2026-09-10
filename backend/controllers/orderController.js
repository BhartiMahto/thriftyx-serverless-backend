const Order = require("../models/orderModel");
const Cart = require("../models/cartModel");
const Event = require("../models/EventModel");
const User = require("../models/userModel");
const { ticketsForCity, findTicket, orderCityVenue, whenForCity } = require("../utils/tickets");
const Coupon = require("../models/couponModel");
const { evaluateCoupon } = require("./couponController");
const {
  refundOrderPayment, fetchRefundStatus,
  createGatewayOrder, verifyGatewaySignature, RZP_KEY_ID, notifyWaitlisted,
} = require("./paymentController");
const { ensureTicket, ensureInvoice, attendeesOf } = require("../utils/documents");
const { verifyTicket } = require("../utils/ticketToken");
const { consumeCredit, refundCredit } = require("./membershipController");
const { notifyOrder, niceDate, SUPPORT, sendWaTemplate, firstName } = require("../utils/notify");
const sendMail = require("../utils/sendMail");

/** Age in whole years from a date-of-birth. null if empty/invalid. Mirrors the
 *  client's ageFromDob so the server derives age authoritatively from DOB rather
 *  than trusting a client-supplied number. */
const ageFromDob = (dob) => {
  if (!dob) return null;
  const born = new Date(dob);
  if (Number.isNaN(born.getTime())) return null;
  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const m = now.getMonth() - born.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < born.getDate())) age -= 1;
  return age >= 0 && age < 150 ? age : null;
};

/**
 * Emails the customer that their booking is confirmed, with the event details
 * and a link to their ticket. Email-only + best-effort (never breaks the flow).
 * WhatsApp confirmation would need its own approved utility template.
 */
const notifyBookingConfirmed = async (order) => {
  try {
    await order.populate("user_id", "email phone name");
    await order.populate("event_id", "name date start_time end_time venue_name venue city");
    const to = order.attendee_details?.email || order.user_id?.email;
    const phone = order.attendee_details?.phone || order.user_id?.phone;
    const who = firstName(order.attendee_details?.name || order.user_id?.name);
    const ev = order.event_id || {};
    const name = ev.name || "your event";
    const when = ev.date ? niceDate(ev.date) : "";
    const time = [ev.start_time, ev.end_time].filter(Boolean).join(" - ");
    const where = [ev.venue_name || ev.venue, order.event_city || ev.city].filter(Boolean).join(", ");

    // WhatsApp (approved Utility document template) — delivers the ticket PDF.
    // {{5}} is the ticket filename appended to the template's fixed S3 base URL.
    const ticketFile = order.ticket_url ? order.ticket_url.split("/").pop() : "";
    if (ticketFile) {
      await sendWaTemplate(phone, "TWILIO_WA_BOOKING_CONFIRMED_SID", {
        1: who,
        2: name,
        3: [when, time].filter(Boolean).join(", ") || "See your ticket",
        4: where || "See your ticket",
        5: ticketFile,
      });
    }

    if (!to) return;
    // Attach the ticket + tax invoice PDFs (nodemailer streams them from S3).
    const attachments = [];
    if (order.ticket_url) attachments.push({ filename: "ticket.pdf", path: order.ticket_url });
    if (order.invoice_url) attachments.push({ filename: "invoice.pdf", path: order.invoice_url });

    const ticketLine = attachments.length
      ? "Your ticket (with entry QR) and tax invoice are attached to this email."
      : order.ticket_url
        ? `Your ticket (with entry QR): ${order.ticket_url}`
        : `Your ticket is ready under "My Tickets" on your IRL Social Hive profile.`;
    const body = [
      `Great news — your booking for "${name}" is confirmed! 🎉`,
      "",
      ...(when ? [`Date: ${when}${time ? ` (${time})` : ""}`] : []),
      ...(where ? [`Venue: ${where}`] : []),
      "",
      ticketLine,
      "",
      "Please have your ticket QR ready at entry. Can't wait to see you there!",
      `Questions? ${SUPPORT}`,
      "— IRL Social Hive",
    ].join("\n");
    await sendMail(to, `Booking confirmed — ${name}`, body, attachments);
  } catch (e) {
    console.error("booking-confirmed email:", e.message);
  }
};

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
    // Answers to the event's custom checkout questions (label denormalised).
    answers: Array.isArray(p.answers)
      ? p.answers.map((x) => ({ key: x.key || null, label: x.label || null, value: x.value ?? null }))
      : [],
    ticketType: total > 1 ? `${ticketType} (${i + 1}/${total})` : ticketType,
    // Admin shows a binary paid/unpaid; backend tracks a 4-state order status.
    paymentStatus: order.status === "completed" ? "paid" : "unpaid",
    orderStatus: order.status,
    registrationDate: order.createdBy || null,
    // Per-attendee check-in; falls back to the order flag for legacy orders.
    checkedIn: Boolean(p.checkedIn ?? order.checkedIn),
    checkedInAt: p.checkedInAt || order.checkedInAt || null,
    // The city/venue this booking is actually FOR (multi-city events store it on
    // the order), not the event's primary city. Falls back to the top-level.
    city: orderCityVenue(order).city || order.user_id?.city || null,
    venue: orderCityVenue(order).venue || null,
    grandTotal: order.grand_total ?? 0,
    // Manually added by an admin (comp / walk-in / test) — shown with a badge and
    // safely removable, unlike real paid bookings (which use cancel/refund).
    addedByAdmin: Boolean(order.addedByAdmin),
  }));
};

/**
 * Copy the booker's checkout details onto their User profile so the admin
 * Customers page (sourced from the users collection) shows them.
 *
 * FILL-IF-BLANK: only fields that are currently empty on the profile are set,
 * so we never clobber values the user deliberately entered on their Profile
 * page. Formats mirror profileController.updateMyProfile (DOB -> Date,
 * reasonToJoin trimmed/capped at 200). Best-effort: a failure here must never
 * break the booking, so the caller wraps it in try/catch and it also guards
 * itself. This is the reliable server-side counterpart to the client's
 * best-effort saveProfileFromForm() call, which can silently fail (session
 * timing, network) and leave the profile blank.
 */
const syncProfileFromBooking = async (userId, booker) => {
  if (!userId || !booker) return;
  const u = await User.findById(userId)
    .select("name city gender DOB maritalStatus reasonToJoin")
    .lean();
  if (!u) return;

  const isBlank = (v) => v === null || v === undefined || v === "";
  const str = (v) => (v === null || v === undefined ? "" : String(v).trim());
  const set = {};

  if (isBlank(u.name) && str(booker.name)) set.name = str(booker.name);
  if (isBlank(u.city) && str(booker.city)) set.city = str(booker.city);
  if (isBlank(u.gender) && str(booker.gender)) set.gender = str(booker.gender);
  if (isBlank(u.maritalStatus) && str(booker.maritalStatus)) set.maritalStatus = str(booker.maritalStatus);
  if (isBlank(u.reasonToJoin) && str(booker.reasonToJoin)) {
    set.reasonToJoin = str(booker.reasonToJoin).slice(0, 200);
  }
  if (isBlank(u.DOB) && booker.DOB) {
    const d = new Date(booker.DOB);
    if (!Number.isNaN(d.getTime()) && d.getTime() <= Date.now()) set.DOB = d;
  }

  if (Object.keys(set).length) {
    await User.updateOne({ _id: userId }, { $set: set });
  }
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
    // Normalise custom-question answers: keep only entries with a key, coerce the
    // value to a string (or an array of strings for multiselect), and cap length.
    const cleanAnswers = (arr) => Array.isArray(arr)
      ? arr
          .map((x) => ({
            key: x?.key ? String(x.key) : null,
            label: x?.label ? String(x.label).slice(0, 300) : null,
            value: Array.isArray(x?.value)
              ? x.value.map((v) => String(v).slice(0, 500)).slice(0, 50)
              : (x?.value !== undefined && x?.value !== null ? String(x.value).slice(0, 2000) : null),
          }))
          .filter((x) => x.key)
      : undefined;

    const cleanAttendee = (a) => ({
      name: a?.name ?? null,
      email: a?.email ?? null,
      phone: a?.phone ?? null,
      gender: a?.gender ?? null,
      // Derive age from DOB (authoritative); fall back to the client's number only
      // when no DOB is present (legacy callers), so the stored age can't contradict
      // the stored DOB.
      age: ageFromDob(a?.DOB) ?? (a?.age ?? null),
      DOB: a?.DOB ?? null,
      city: a?.city ?? null,
      maritalStatus: a?.maritalStatus ?? null,
      reasonToJoin: a?.reasonToJoin ? String(a.reasonToJoin).trim().slice(0, 1000) : null,
      answers: cleanAnswers(a?.answers),
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

    // "Coming soon" (interest) events are not bookable.
    if (event.stage === "interest") {
      return res.status(400).json({
        message: "This event isn't open for booking yet.",
        statusCode: 400,
      });
    }

    // Invite-only events are not directly bookable — they go through the
    // application + approval flow (/apply/:id). Block the direct checkout path.
    if (event.inviteOnly) {
      return res.status(400).json({
        message: "This event is invite-only. Please apply through the form.",
        statusCode: 400,
      });
    }

    // Admin-forced sold out — no more bookings.
    if (event.soldOut) {
      return res.status(400).json({ message: "This event is sold out.", statusCode: 400 });
    }

    // Age gate — every attendee's age must fall within the event's allowed range:
    // no older, no younger. Defence-in-depth; the checkout UI already enforces
    // this, but a direct API call must not bypass it, so the age is RE-DERIVED
    // from the attendee's DOB here (the client-supplied age is never trusted).
    // The floor mirrors the client: an explicit min_age, else the platform floor
    // of 18. max 0 = no upper limit. Attendees with no/invalid DOB (legacy
    // callers) can't be checked, so they're skipped.
    {
      const minA = Number(event.min_age) || 18;
      const maxA = Number(event.max_age) || 0;
      for (const a of attendeeList) {
        const age = ageFromDob(a.DOB);
        if (age == null) continue;
        if (age < minA) {
          return res.status(400).json({
            message: `This event is for ages ${minA}${maxA ? `–${maxA}` : "+"}. An attendee's age (${age}) is below the minimum.`,
            statusCode: 400,
          });
        }
        if (maxA && age > maxA) {
          return res.status(400).json({
            message: `This event is for ages ${minA}–${maxA}. An attendee's age (${age}) is above the maximum.`,
            statusCode: 400,
          });
        }
      }
    }

    // Required custom questions must be answered by every attendee.
    {
      const requiredQs = (event.checkoutQuestions || []).filter((q) => q && q.required && q.key);
      if (requiredQs.length) {
        const isBlankAnswer = (v) =>
          v === undefined || v === null ||
          (Array.isArray(v) ? v.length === 0 : String(v).trim() === "");
        for (const a of attendeeList) {
          const ans = Array.isArray(a.answers) ? a.answers : [];
          for (const q of requiredQs) {
            const hit = ans.find((x) => x.key === q.key);
            if (!hit || isBlankAnswer(hit.value)) {
              return res.status(400).json({
                message: `Please answer: "${q.label || q.key}" for every attendee.`,
                statusCode: 400,
              });
            }
          }
        }
      }
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

    const round2 = (n) => Math.round(n * 100) / 100;

    // Server-authoritative pricing (anti-tamper + per-city). For every non-pass
    // order we RECOMPUTE the amount from the event's own per-city tickets, so a
    // tampered or stale client price (or a cheaper city's price) can't stick.
    // Pass bookings keep the client's holder-excluded amounts (the holder-seat
    // exclusion is computed client-side) — solo passes are forced to ₹0 below.
    let sTotal = Number(cart.total_price) || 0;
    let sFee = Number(cart.booking_fee) || 0;
    let sGst = Number(cart.gst) || 0;
    if (!claimedPass) {
      let sub = 0;
      for (const t of (Array.isArray(cart.tickets) ? cart.tickets : [])) {
        const authoritative = findTicket(event, event_city, t.name);
        const unit = authoritative ? Number(authoritative.price) : (Number(t.price) || 0);
        sub += unit * (Number(t.count ?? t.quantity ?? 1) || 1);
      }
      sTotal = round2(sub);
      // Fee + GST are computed AFTER the coupon discount (on the net subtotal)
      // below, so they scale with the discounted amount.
    }

    // Coupon is re-validated and the discount recomputed HERE from the SERVER's
    // subtotal — a client-sent discount/price is never trusted. Usage is recorded
    // atomically so a coupon can't be over-redeemed by concurrent requests.
    let discount = 0;
    let appliedCode = null;
    if (!claimedPass && couponCode) {
      // Attendee genders + authoritative per-ticket prices, for BOGO coupons.
      const bogoAttendees = (Array.isArray(attendees) && attendees.length
        ? attendees
        : (attendee_details ? [attendee_details] : [])
      ).map((a) => a?.gender || "");
      const bogoUnitPrices = [];
      for (const t of (Array.isArray(cart.tickets) ? cart.tickets : [])) {
        const authoritative = findTicket(event, event_city, t.name);
        const unit = authoritative ? Number(authoritative.price) : (Number(t.price) || 0);
        const cnt = Number(t.count ?? t.quantity ?? 1) || 1;
        for (let i = 0; i < cnt; i++) bogoUnitPrices.push(unit);
      }
      const result = await evaluateCoupon(couponCode, sTotal, req.user._id, {
        eventCity: event_city ? String(event_city).trim() : "",
        attendees: bogoAttendees,
        unitPrices: bogoUnitPrices,
      });
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

    // Platform fee (5%) + GST (18%) apply to the DISCOUNTED subtotal, so the
    // coupon reduces the fees too. (Pass bookings keep the client amounts.)
    let netSubtotal = sTotal;
    if (!claimedPass) {
      netSubtotal = Math.max(0, round2(sTotal - discount));
      sFee = round2(netSubtotal * 0.05);
      sGst = round2(netSubtotal * 0.18);
    }

    // A fully pass-covered (solo) booking costs nothing and is confirmed
    // immediately. A pass-with-friends booking is a normal paid order for the
    // friends' seats (the holder's seat was already excluded from the cart
    // amounts by the client) and follows the pay-then-waitlist flow.
    // grand_total = net subtotal (after discount) + fee + GST on that net.
    const grandTotal = passCoversWholeOrder
      ? 0
      : Math.max(0, round2(netSubtotal + sFee + sGst));

    // A coupon that covers 100% leaves ₹0 to pay. Razorpay rejects ₹0 orders,
    // so skip the gateway entirely and treat it like a paid booking awaiting
    // host confirmation (status completed, applicationStatus waitlist).
    const noPaymentNeeded = !passCoversWholeOrder && grandTotal <= 0;

    const order = await Order.create({
      user_id: req.user._id,
      event_id: cart.event_id,
      tickets: cart.tickets,
      total_price: passCoversWholeOrder ? 0 : sTotal,
      booking_fee: passCoversWholeOrder ? 0 : sFee,
      gst: passCoversWholeOrder ? 0 : sGst,
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
      status: (passCoversWholeOrder || noPaymentNeeded) ? "completed" : "in_progress",
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

    // Seed the booker's profile from what they just entered at checkout, so the
    // admin Customers page (sourced from the users collection) isn't blank.
    // Fill-if-blank + best-effort: never let a profile-sync hiccup fail a booking.
    try {
      await syncProfileFromBooking(req.user._id, attendeeList[0]);
    } catch (e) {
      console.error("profile sync from booking failed:", e.message);
    }

    // A fully pass-covered (solo) booking is already paid + confirmed → issue
    // the ticket now. A group booking waits for payment + host confirmation.
    if (passCoversWholeOrder) {
      try {
        await ensureTicket(order);
      } catch (docErr) {
        console.error("Pass ticket generation failed:", docErr.message);
      }
      await notifyBookingConfirmed(order);
    } else if (noPaymentNeeded) {
      // ₹0 (100%-coupon) booking: no gateway. Let them know it's received and
      // pending host confirmation (same as a paid booking after payment).
      try { await notifyWaitlisted(order); } catch (e) { console.error("free-booking notify:", e.message); }
    }

    return res.status(201).json({
      message: passCoversWholeOrder
        ? "Booking confirmed with your Golden Pass"
        : noPaymentNeeded ? "Booking received — no payment needed" : "Order Created",
      data: {
        _id: order._id,
        order_id: order.order_id,
        status: order.status,
        paidByPass: passCoversWholeOrder,
        // No payment step needed (pass-covered, or a 100%-coupon ₹0 booking).
        noPaymentNeeded,
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
      .sort({ createdBy: -1 })
      .lean();

    // Never expose the raw gateway refund error to the customer — it's admin-only.
    for (const o of orders) { if (o.refund) delete o.refund.error; }

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

    // The event must be over. Use the booking city's effective date (a city may
    // have its own date). An event with no date can't be confirmed as past.
    const cityDate = whenForCity(order.event_id, order.event_city).date;
    const eventDate = cityDate ? new Date(cityDate).getTime() : null;
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

    // Auto-refund a paid (money) booking on self-cancel, TIERED by how long
    // before the event the customer backs out (% of the total they paid):
    //   ≥ 48h  → 100%      24–48h → 50%      < 24h → 10%      event started → 0%
    const round2 = (n) => Math.round(n * 100) / 100;
    const refundPercentForHours = (h) => {
      if (h <= 0) return 0; // event already started / passed
      if (h >= 48) return 100;
      if (h >= 24) return 50;
      return 10;
    };

    let evDate = null;
    try {
      // Include locations so the booking city's own date is used (a city may be
      // postponed independently — its refund window must follow its own date).
      await order.populate("event_id", "date start_time locations");
      const cityDate = whenForCity(order.event_id, order.event_city).date;
      evDate = cityDate ? new Date(cityDate) : null;
    } catch { /* no event date → treat as fully refundable */ }
    const hoursToEvent = evDate ? (evDate.getTime() - Date.now()) / 3600000 : Infinity;
    const refundPercent = refundPercentForHours(hoursToEvent);
    const refundAmount = round2((order.grand_total ?? 0) * (refundPercent / 100));

    let refundNote = null;
    const eligibleForMoneyRefund =
      wasPaid && !order.paidByPass && refundAmount > 0 &&
      order.payment_id && !order.refund?.id;

    if (eligibleForMoneyRefund) {
      try {
        order.refund = await refundOrderPayment(order, refundAmount);
        refundNote = `As per our cancellation policy, ${refundPercent}% (₹${refundAmount}) is being refunded.`;
      } catch (e) {
        // Razorpay SDK rejects with { statusCode, error: { description, reason } }.
        const reason = e?.error?.description || e?.error?.reason || e?.message || "unknown error";
        console.error("cancel refund failed:", e?.statusCode || "", reason, JSON.stringify(e?.error || {}));
        order.refund = { id: null, status: "failed", amount: refundAmount, error: reason, at: new Date() };
        refundNote = "Refund could not be initiated automatically — our team will process it.";
      }
    } else if (wasPaid && !order.paidByPass && refundPercent === 0) {
      refundNote = "The event has already started, so no refund applies. Contact support if you think this is a mistake.";
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
          `Your booking${ev} has been cancelled. As per our cancellation policy, ` +
          `₹${order.refund.amount} (${refundPercent}%) is being refunded to your original payment method (ref ${ref}), ` +
          `usually within 5–7 business days. Questions? ${SUPPORT}\n— IRL Social Hive`;
      } else {
        body =
          `Your booking${ev} has been cancelled. ${refundNote || ""} Questions? ${SUPPORT}\n— IRL Social Hive`;
      }
      await notifyOrder(order, { subject: `Booking cancelled — ${order.event_id?.name || "IRL Social Hive"}`, body });

      // WhatsApp (approved Utility template): {{3}} = concise refund status.
      const waRefund = (order.refund?.id && order.refund?.status !== "failed")
        ? `₹${order.refund.amount} (${refundPercent}%) is being refunded to your original payment method.`
        : (refundNote || "No refund applies as per our policy.");
      await sendWaTemplate(
        order.attendee_details?.phone || order.user_id?.phone,
        "TWILIO_WA_BOOKING_CANCELLED_SID",
        { 1: firstName(order.attendee_details?.name || order.user_id?.name), 2: order.event_id?.name || "your event", 3: waRefund }
      );
    } catch (e) { console.error("cancel notify:", e.message); }

    // Notify the team on every cancellation. The RAW gateway error (e.g. an
    // insufficient-balance refund failure) goes ONLY here — never to the customer.
    try {
      const ADMIN_CANCEL_EMAIL = process.env.ADMIN_CANCEL_EMAIL || "admin@thriftyx.com";
      const r = order.refund || {};
      const evName = order.event_id?.name || "an event";
      const who = order.attendee_details?.name || order.user_id?.name || "A customer";
      const refundFailed = r.status === "failed" || (r.amount > 0 && !r.id);
      const refundLine = !wasPaid
        ? "This booking was not a paid (money) order."
        : refundFailed
          ? `⚠️ REFUND FAILED — ₹${r.amount ?? refundAmount} could NOT be auto-refunded. Add Razorpay balance and retry.\nGateway error: ${r.error || "unknown"}`
          : r.id
            ? `Refund of ₹${r.amount} initiated (ref ${r.rrn || r.id}), status: ${r.status}.`
            : (refundPercent === 0 ? "No refund applies (event already started)." : `Refund note: ${refundNote || "—"}`);
      await sendMail(
        ADMIN_CANCEL_EMAIL,
        `${refundFailed ? "⚠️ " : ""}Booking cancelled — ${evName}${refundFailed ? " (refund needs attention)" : ""}`,
        `<p><b>${who}</b> cancelled a ticket.</p>
         <ul>
           <li>Event: ${evName}${order.event_city ? ` — ${order.event_city}` : ""}</li>
           <li>Order: ${order.order_id || order._id}</li>
           <li>Customer: ${order.attendee_details?.name || order.user_id?.name || "—"} · ${order.attendee_details?.email || order.user_id?.email || "—"} · ${order.attendee_details?.phone || order.user_id?.phone || "—"}</li>
           <li>Amount paid: ₹${order.grand_total ?? 0}</li>
           <li>Cancelled at: ${order.cancelledAt}</li>
         </ul>
         <p>${refundLine}</p>`
      );
    } catch (e) { console.error("cancel admin notify:", e.message); }

    return res.status(200).json({
      message: "Booking cancelled",
      data: {
        _id: order._id,
        status: order.status,
        cancelledAt: order.cancelledAt,
        refundPercent: eligibleForMoneyRefund ? refundPercent : 0,
        // Raw gateway `error` is deliberately omitted — it's admin-only.
        refund: (order.refund?.id || order.refund?.status)
          ? { id: order.refund.id, status: order.refund.status, amount: order.refund.amount, rrn: order.refund.rrn, at: order.refund.at }
          : null,
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
      "name type city venue venue_name date start_time end_time image locations"
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
    // Effective date/time for the booking's city (a city may have its own).
    const when = whenForCity(event, order.event_city);

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
          date: when.date || null,
          startTime: when.start_time || null,
          endTime: when.end_time || null,
          // The city/venue this booking is FOR (multi-city events store it on
          // the order), not the event's primary city.
          venue: orderCityVenue(order).venue,
          city: orderCityVenue(order).city,
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

      // Let the customer know they're in, with their ticket. Best-effort.
      await notifyBookingConfirmed(order);

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

    // Pull the live status + bank reference (RRN) from Razorpay (mock echoes the
    // stored value), and keep the stored copy fresh. The RRN often only appears
    // once the refund is processed, so this refresh is what surfaces it.
    let liveStatus = order.refund?.status ?? null;
    let liveRrn = order.refund?.rrn ?? null;
    try {
      const s = await fetchRefundStatus(order);
      if (s) {
        let changed = false;
        if (s.status && s.status !== order.refund?.status) { order.refund.status = s.status; changed = true; }
        if (s.rrn && s.rrn !== order.refund?.rrn) { order.refund.rrn = s.rrn; changed = true; }
        if (changed) await order.save();
        liveStatus = s.status ?? liveStatus;
        liveRrn = s.rrn ?? liveRrn;
      }
    } catch (err) {
      console.error("fetchRefundStatus error:", err.message);
    }

    return res.status(200).json({
      message: "Refund status",
      data: {
        refunded: Boolean(order.refund?.id),
        refundId: order.refund?.id ?? null,
        status: liveStatus,
        rrn: liveRrn,
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
    // Only real, current attendees:
    //  - status "completed" = paid (incl. Golden Pass free bookings). This drops
    //    the thousands of "in_progress"/pending/failed (never-paid) checkouts.
    //  - refund.id null = NOT refunded. A refunded booking is cancelled (or an
    //    external refund left status completed with a refund object) and must not
    //    show at the door. (Failed-refund attempts keep refund.id null → still shown.)
    const orders = await Order.find({
      event_id: req.params.eventId,
      status: "completed",
      "refund.id": null,
    })
      .populate("user_id", "name email city phone")
      .populate("event_id", "name type city venue venue_name locations")
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
 * POST /api/admin/events/:eventId/attendees — admin manually adds a booking
 * (e.g. an offline / walk-in / comp attendee). Creates a completed + confirmed
 * order with no user account (details live on the order). Amount is what the
 * admin actually collected (0 for a comp). Best-effort ticket generation.
 */
const adminAddAttendee = async (req, res) => {
  try {
    const event = await Event.findById(req.params.eventId);
    if (!event) return res.status(404).json({ message: "Event not found", statusCode: 404 });

    const { name, email, phone, gender, age, DOB, city, ticketType, amount, maritalStatus, reasonToJoin } = req.body;
    if (!name || !String(name).trim()) {
      return res.status(400).json({ message: "Attendee name is required", statusCode: 400 });
    }
    const price = Math.max(0, Number(amount) || 0);
    const attendee = {
      name: String(name).trim().slice(0, 120),
      email: email ? String(email).trim().slice(0, 200) : null,
      phone: phone ? String(phone).trim().slice(0, 30) : null,
      gender: gender ? String(gender) : null,
      age: (age !== undefined && age !== null && age !== "") ? Number(age) : (DOB ? ageFromDob(DOB) : null),
      DOB: DOB || null,
      city: city ? String(city).trim() : null,
      maritalStatus: maritalStatus ? String(maritalStatus) : null,
      reasonToJoin: reasonToJoin ? String(reasonToJoin).trim().slice(0, 1000) : null,
      answers: [],
    };

    const order = await Order.create({
      user_id: null, // no customer account — an admin-added booking
      event_id: event._id,
      tickets: [{ name: ticketType ? String(ticketType) : "Manual", count: 1, price }],
      total_price: price,
      booking_fee: 0,
      gst: 0,
      discount: 0,
      grand_total: price,
      status: "completed",         // admin add = already paid/settled
      applicationStatus: "confirmed", // and confirmed (they're in)
      addedByAdmin: true,          // marker so it's distinguishable from online bookings
      isTnC_accepted: true,
      attendee_details: attendee,
      attendees: [attendee],
      event_city: city ? String(city).trim() : null,
      order_id: `THX${Date.now()}${Math.floor(Math.random() * 1000)}`,
      createdBy: new Date(),
      updatedBy: new Date(),
    });

    // Best-effort: issue the ticket so it can be downloaded/sent. Never fail the add.
    try {
      const { ensureTicket } = require("../utils/documents");
      await ensureTicket(order);
    } catch (e) { console.error("adminAddAttendee ticket:", e.message); }

    return res.status(201).json({
      message: "Attendee added",
      data: { _id: order._id, order_id: order.order_id },
      statusCode: 201,
    });
  } catch (error) {
    console.error("adminAddAttendee error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * DELETE /api/admin/attendees/:orderId — permanently remove a MANUALLY-added
 * attendee (addedByAdmin: comp / walk-in / test). Real paid bookings cannot be
 * deleted here — use cancel/refund — so a genuine customer record can never be
 * silently destroyed. The row id may arrive as a composite "orderId:index";
 * only the order id matters (admin-added attendees are single-attendee orders).
 */
const deleteEventAttendee = async (req, res) => {
  try {
    const [orderId] = String(req.params.orderId).split(":");
    const order = await Order.findById(orderId);
    if (!order) return res.status(404).json({ message: "Booking not found", statusCode: 404 });
    if (!order.addedByAdmin) {
      return res.status(403).json({
        message: "Only manually-added attendees can be removed here. Use cancel/refund for a real booking.",
        statusCode: 403,
      });
    }
    await Order.deleteOne({ _id: order._id });
    return res.status(200).json({ message: "Attendee removed", statusCode: 200 });
  } catch (error) {
    console.error("deleteEventAttendee error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * Scheduled cleanup: permanently delete manually admin-added attendees
 * (addedByAdmin) the day AFTER their event has passed. An order's effective date
 * is its per-city occurrence date (whenForCity), falling back to the event's
 * top-level date. "Day after" = the occurrence date is before the start of today
 * (IST) — so on the event day itself nothing is removed, and from the next day on
 * the manual entries are gone. Orphaned manual orders (event deleted) are also
 * cleaned. Idempotent — safe to run repeatedly. Never touches real bookings.
 */
const cleanupExpiredManualAttendees = async () => {
  try {
    const { whenForCity } = require("../utils/tickets");
    // Start of today in IST, as a UTC instant.
    const IST_MS = 5.5 * 60 * 60 * 1000;
    const istNow = new Date(Date.now() + IST_MS);
    const istMidnightUtc = Date.UTC(istNow.getUTCFullYear(), istNow.getUTCMonth(), istNow.getUTCDate());
    const startOfTodayUtc = new Date(istMidnightUtc - IST_MS);

    const manual = await Order.find({ addedByAdmin: true })
      .populate("event_id", "date start_time end_time locations")
      .lean();

    const toDelete = [];
    for (const o of manual) {
      const ev = o.event_id;
      if (!ev) { toDelete.push(o._id); continue; } // event gone → orphan, clean it
      const when = whenForCity(ev, o.event_city);
      const raw = when?.date ?? ev.date ?? null;
      const d = raw ? new Date(raw) : null;
      if (d && !Number.isNaN(d.getTime()) && d < startOfTodayUtc) toDelete.push(o._id);
    }

    if (toDelete.length) {
      // Re-assert addedByAdmin in the delete filter — defence-in-depth so a real
      // booking can never be removed by this job.
      await Order.deleteMany({ _id: { $in: toDelete }, addedByAdmin: true });
    }
    return { checked: manual.length, deleted: toDelete.length };
  } catch (e) {
    console.error("cleanupExpiredManualAttendees error:", e.message);
    return { checked: 0, deleted: 0, error: e.message };
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
    await order.populate("event_id", "name type city venue venue_name locations");

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
    // Invite-only events can only be joined via the application + approval flow —
    // never by rescheduling an existing booking onto them (mirrors createOrder).
    if (target.inviteOnly) {
      return res.status(400).json({ message: "That event is invite-only — please apply through its form.", statusCode: 400 });
    }
    const tDate = target.date ? new Date(target.date) : null;
    if (tDate && tDate.getTime() <= Date.now()) {
      return res.status(400).json({ message: "That date has already passed", statusCode: 400 });
    }

    // Paid seats on this order (a pass-covered holder seat is free).
    const qty = Array.isArray(order.tickets)
      ? order.tickets.reduce((n, t) => n + (Number(t.count ?? t.quantity ?? 1) || 1), 0)
      : 1;
    const paidSeats = order.paidByPass ? 0 : (order.passSeat ? Math.max(0, qty - 1) : qty);

    // Unit price on the target — resolved from the booking's CITY tickets on the
    // target occurrence (per-city pricing), falling back to the target's shared
    // tickets. Same ticket name if present, else the cheapest in that city.
    const wantName = order.tickets?.[0]?.name;
    const tTickets = ticketsForCity(target, order.event_city);
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
        const reason = e?.error?.description || e?.error?.reason || e?.message || "unknown error";
        console.error("refundBooking failed:", e?.statusCode || "", reason, JSON.stringify(e?.error || {}));
        // Record why it failed so it can be retried knowingly (id stays null,
        // so this endpoint can be called again to retry once the cause is fixed).
        order.refund = { id: null, status: "failed", amount: order.grand_total ?? 0, error: reason, at: new Date() };
        await order.save();
        return res.status(502).json({ message: `Refund failed: ${reason}`, statusCode: 502 });
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
      // WhatsApp (approved Utility template): {{3}} = refunded amount.
      await sendWaTemplate(
        order.attendee_details?.phone || order.user_id?.phone,
        "TWILIO_WA_REFUND_SID",
        { 1: firstName(order.attendee_details?.name || order.user_id?.name), 2: order.event_id?.name || "your event", 3: amt ? `₹${amt}` : "Your refund" }
      );
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

    const event = await Event.findById(order.event_id).select("locations city venue venue_name tickets");
    const locs = (event && event.locations) || [];
    const match = locs.find((l) => (l.city || "").trim().toLowerCase() === city.toLowerCase());
    if (!match) {
      return res.status(400).json({ message: "That city isn't available for this event", statusCode: 400 });
    }

    // With per-city tickets, a free city-change is only safe when the booked
    // ticket exists in the target city AT THE SAME PRICE. A price difference would
    // need a payment/refund, so we block it and point the user to cancel + rebook.
    const targetTickets = ticketsForCity(event, match.city);
    for (const bt of (order.tickets || [])) {
      const name = bt?.name;
      if (!name) continue;
      const tt = targetTickets.find((t) => String(t.name).trim().toLowerCase() === String(name).trim().toLowerCase());
      if (!tt) {
        return res.status(400).json({
          message: `"${name}" isn't offered in ${match.city}. Please cancel and rebook for that city.`,
          statusCode: 400,
        });
      }
      if (Number(tt.price) !== Number(bt.price)) {
        return res.status(400).json({
          message: `The price in ${match.city} differs from what you paid. Please cancel this booking and rebook for ${match.city}.`,
          statusCode: 400,
        });
      }
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

/**
 * POST /api/admin/events/:id/message — email selected attendees of an event.
 * Body: { ids: string[] (attendee row ids "<orderId>:<idx>" or plain order ids),
 *         subject?, content }.
 *
 * Dedupes to ONE email per order (the booker) so a multi-ticket booking isn't
 * emailed twice. `{name}` in the content is replaced with the recipient's first
 * name. Best-effort per recipient; returns counts.
 *
 * Email only: free-form WhatsApp is blocked by Meta outside the 24h service
 * window, so ad-hoc WhatsApp isn't offered here — automated reminders use the
 * approved event_reminder template instead (see reminderController).
 */
const sendEventMessage = async (req, res) => {
  try {
    const { ids, subject, content } = req.body || {};
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: "No recipients selected", statusCode: 400 });
    }
    if (!content || !String(content).trim()) {
      return res.status(400).json({ message: "Message content is required", statusCode: 400 });
    }

    // Attendee row ids are "<orderId>:<index>"; reduce to unique order ids.
    const orderIds = [...new Set(ids.map((x) => String(x).split(":")[0]))];
    const orders = await Order.find({ _id: { $in: orderIds }, event_id: req.params.id })
      .populate("user_id", "name email");

    const subj = String(subject || "").trim() || "A message about your booking";
    let sent = 0, failed = 0, skipped = 0;

    for (const o of orders) {
      const email = o.attendee_details?.email || o.user_id?.email;
      if (!email) { skipped++; continue; }
      const who = firstName(o.attendee_details?.name || o.user_id?.name);
      const body = String(content).replace(/\{name\}/gi, who);
      try {
        await sendMail(email, subj, body);
        sent++;
      } catch (e) {
        failed++;
        console.error("sendEventMessage:", String(o._id), e.message);
      }
    }

    return res.status(200).json({
      message: "Messages sent",
      data: { sent, failed, skipped, orders: orders.length },
      statusCode: 200,
    });
  } catch (err) {
    if (err.name === "CastError") return res.status(404).json({ message: "Event not found", statusCode: 404 });
    console.error("sendEventMessage error:", err);
    return res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

module.exports = {
  getAllOrders,
  sendEventMessage,
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
  adminAddAttendee,
  deleteEventAttendee,
  cleanupExpiredManualAttendees,
  toggleCheckIn,
};
