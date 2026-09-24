const crypto = require("crypto");
const Event = require("../models/EventModel");
const EventApplication = require("../models/EventApplicationModel");
const Order = require("../models/orderModel");
const sendMail = require("../utils/sendMail");
const { sendWaTemplate, firstName, niceDate } = require("../utils/notify");
const { createGatewayOrder, verifyGatewaySignature, MOCK_PAYMENTS, RZP_KEY_ID } = require("./paymentController");
const { findTicket, ticketsForCity, whenForCity } = require("../utils/tickets");

const CUSTOMER_BASE = () => (process.env.CUSTOMER_URL || "https://irlsocialhive.com").replace(/\/$/, "");
const ADMIN_NOTIFY = process.env.APPLICATIONS_NOTIFY_EMAIL || process.env.SELLER_EMAIL || "help@thriftyx.com";

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const cap = (v, n) => (v ? String(v).trim().slice(0, n) : null);
const round2 = (n) => Math.round(n * 100) / 100;
const inr = (n) => `₹${Number(n || 0).toLocaleString("en-IN")}`;

// Invite-only pricing: what an approved applicant actually pays. GST (18%) applies
// to everyone; the platform fee (5%) applies ONLY to male guests (business rule
// for invite-only / admin-added bookings — regular website checkout is separate).
const GST_RATE = 0.18;
const PLATFORM_FEE_RATE = 0.05;
const applicationCharge = (app) => {
  const base = round2(num(app.amount));
  const isMale = String(app.gender || "").trim().toLowerCase() === "male";
  const fee = isMale ? round2(base * PLATFORM_FEE_RATE) : 0;
  const gst = round2(base * GST_RATE);
  const total = round2(base + gst + fee);
  return { base, gst, fee, total, isMale };
};

/**
 * Builds the pieces shown in the approval message (WhatsApp + email): a
 * single-line price breakup, the total, the booking city, and its date/time.
 * `ev` must carry date/start_time/end_time/locations for whenForCity.
 */
const approvalParts = (app, ev) => {
  const charge = applicationCharge(app);
  const breakup = charge.fee > 0
    ? `Ticket ${inr(charge.base)} + GST ${inr(charge.gst)} + Platform fee ${inr(charge.fee)}`
    : `Ticket ${inr(charge.base)} + GST ${inr(charge.gst)}`;
  const when = whenForCity(ev, app.city);
  const dateStr = when.date ? niceDate(when.date) : "";
  const timeStr = [when.start_time, when.end_time].filter(Boolean).join("–");
  const whenLine = [dateStr, timeStr].filter(Boolean).join(" · ") || "See your ticket";
  const cityStr = app.city || ev.city || "—";
  return { ...charge, breakup, whenLine, cityStr };
};

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

const cleanAnswers = (arr) => (Array.isArray(arr)
  ? arr.map((x) => ({
      key: x?.key ? String(x.key) : null,
      label: x?.label ? String(x.label).slice(0, 300) : null,
      value: Array.isArray(x?.value)
        ? x.value.map((v) => String(v).slice(0, 500)).slice(0, 50)
        : (x?.value !== undefined && x?.value !== null ? String(x.value).slice(0, 2000) : null),
    })).filter((x) => x.key)
  : []);

/* ------------------------------- public ------------------------------- */

/**
 * GET /api/event-apply/:id/info — public form data for an invite-only event.
 * Returns just what the (login-free) apply form needs; never leaks admin data.
 */
const getApplyInfo = async (req, res) => {
  try {
    const ev = await Event.findById(req.params.id).lean();
    if (!ev || !ev.inviteOnly || ev.status !== "Published") {
      return res.status(404).json({ message: "Form not found", statusCode: 404 });
    }
    // Cities (with their per-city date) + tickets, so the form can offer choices.
    const locs = Array.isArray(ev.locations) ? ev.locations : [];
    const cities = locs.length
      ? locs.map((l) => ({ city: l.city, date: whenForCity(ev, l.city).date }))
      : (ev.city ? [{ city: ev.city, date: ev.date }] : []);
    return res.status(200).json({
      message: "Apply info",
      data: {
        _id: ev._id,
        name: ev.name,
        image: ev.image,
        cardImage: ev.cardImage ?? null,
        description: ev.description ?? "",
        shortDescription: ev.shortDescription ?? "",
        min_age: ev.min_age ?? 0,
        max_age: ev.max_age ?? 0,
        cities,
        // Tickets per city (fall back to top-level); price drives the amount.
        ticketsByCity: (cities.length ? cities : [{ city: null }]).reduce((acc, c) => {
          acc[c.city || "_"] = (ticketsForCity(ev, c.city) || []).map((t) => ({ name: t.name, price: Number(t.price) || 0 }));
          return acc;
        }, {}),
        checkoutQuestions: ev.checkoutQuestions ?? [],
      },
      statusCode: 200,
    });
  } catch (error) {
    console.error("getApplyInfo error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** POST /api/event-apply/:id — submit an application (public, no login, no payment). */
const submitApplication = async (req, res) => {
  try {
    const ev = await Event.findById(req.params.id);
    if (!ev || !ev.inviteOnly || ev.status !== "Published") {
      return res.status(404).json({ message: "This form isn't available", statusCode: 404 });
    }
    const { name, email, phone, gender, DOB, city, maritalStatus, reasonToJoin, ticketName, answers } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ message: "Name is required", statusCode: 400 });
    if (!phone && !email) return res.status(400).json({ message: "A phone or email is required", statusCode: 400 });

    // Age gate — re-derived from DOB (never trust a client-sent age).
    const age = ageFromDob(DOB);
    const minA = Number(ev.min_age) || 18;
    const maxA = Number(ev.max_age) || 0;
    if (age != null) {
      if (age < minA) return res.status(400).json({ message: `This event is for ages ${minA}${maxA ? `–${maxA}` : "+"}.`, statusCode: 400 });
      if (maxA && age > maxA) return res.status(400).json({ message: `This event is for ages ${minA}–${maxA}.`, statusCode: 400 });
    }

    // Required custom questions must be answered. Video-type questions are never
    // shown on the login-free apply form, so they can't be required here (else
    // every application would be rejected for an unanswerable field).
    const cleaned = cleanAnswers(answers);
    const requiredQs = (ev.checkoutQuestions || []).filter((q) => q && q.required && q.key && q.type !== "video");
    const isBlank = (v) => v == null || (Array.isArray(v) ? v.length === 0 : String(v).trim() === "");
    for (const q of requiredQs) {
      const hit = cleaned.find((a) => a.key === q.key);
      if (!hit || isBlank(hit.value)) return res.status(400).json({ message: `Please answer: "${q.label || q.key}"`, statusCode: 400 });
    }

    // Resolve the chosen ticket → the amount they'll pay once approved. If the
    // event offers tickets, one MUST resolve — otherwise the application would be
    // a ₹0 dead-end that can never be paid (e.g. a multi-city event with no city
    // chosen).
    const t = findTicket(ev, city, ticketName);
    const hasTickets = (ev.tickets && ev.tickets.length) || (ev.locations || []).some((l) => l.tickets && l.tickets.length);
    if (hasTickets && !t) {
      return res.status(400).json({ message: "Please choose a valid city and ticket.", statusCode: 400 });
    }
    const amount = t ? (Number(t.price) || 0) : 0;

    const app = await EventApplication.create({
      event_id: ev._id,
      name: cap(name, 120),
      email: cap(email, 200),
      phone: cap(phone, 30),
      gender: gender ? String(gender) : null,
      DOB: DOB || null,
      age,
      city: cap(city, 120),
      maritalStatus: maritalStatus ? String(maritalStatus) : null,
      reasonToJoin: cap(reasonToJoin, 1000),
      answers: cleaned,
      ticketName: cap(ticketName, 120),
      amount,
      status: "pending",
    });

    sendMail(
      ADMIN_NOTIFY,
      `New application — ${ev.name}`,
      `<p>New application for <b>${ev.name}</b>.</p>
       <ul>
         <li>Name: ${app.name}</li>
         <li>Phone: ${app.phone || "—"}</li>
         <li>Email: ${app.email || "—"}</li>
         <li>City: ${app.city || "—"}</li>
         <li>Ticket: ${app.ticketName || "—"} (₹${amount})</li>
         ${app.reasonToJoin ? `<li>Why join: ${app.reasonToJoin}</li>` : ""}
       </ul>
       <p>Review it in the admin Applications section.</p>`
    ).catch((e) => console.error("application notify failed:", e.message));

    return res.status(201).json({ message: "Application received", data: { _id: app._id, status: app.status }, statusCode: 201 });
  } catch (error) {
    console.error("submitApplication error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** GET /api/event-apply/pay/:token — the approved application behind a login-free pay page. */
const getApplicationPayInfo = async (req, res) => {
  try {
    const app = await EventApplication.findOne({ payToken: req.params.token }).populate(
      "event_id", "name image cardImage date start_time end_time locations city soldOut"
    );
    if (!app) return res.status(404).json({ message: "Not found", statusCode: 404 });
    const when = app.event_id ? whenForCity(app.event_id, app.city) : { date: null, start_time: "", end_time: "" };
    const charge = applicationCharge(app);
    return res.status(200).json({
      message: "Application",
      data: {
        _id: app._id,
        name: app.name,
        status: app.status,
        // `amount` = the FULL payable (base + GST + male fee) so the pay page's
        // "Amount to pay" / "Pay ₹X" matches what Razorpay actually charges.
        amount: charge.total,
        // Breakdown for a fuller display (ticket price, GST, platform fee).
        ticketPrice: charge.base,
        gst: charge.gst,
        platformFee: charge.fee,
        payable: charge.total,
        ticketName: app.ticketName,
        city: app.city,
        paidAt: app.paidAt,
        // Event is full — the pay page shows "sold out" and blocks payment.
        soldOut: Boolean(app.event_id?.soldOut),
        event: app.event_id ? { _id: app.event_id._id, name: app.event_id.name, image: app.event_id.image, date: when.date, start_time: when.start_time } : null,
      },
      statusCode: 200,
    });
  } catch (error) {
    console.error("getApplicationPayInfo error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** Create the real confirmed, paid Order once an application is paid. */
const createOrderFromApplication = async (app, event, paymentId) => {
  const attendee = {
    name: app.name, email: app.email, phone: app.phone, gender: app.gender,
    age: app.age ?? ageFromDob(app.DOB), DOB: app.DOB || null, city: app.city,
    maritalStatus: app.maritalStatus, reasonToJoin: app.reasonToJoin || null,
    answers: Array.isArray(app.answers) ? app.answers : [],
  };
  const { base, gst, fee, total } = applicationCharge(app);
  const order = await Order.create({
    user_id: null,
    event_id: event._id,
    tickets: [{ name: app.ticketName || "Invite", count: 1, price: base }],
    total_price: base, booking_fee: fee, gst: gst, discount: 0, grand_total: total,
    status: "completed",
    applicationStatus: "confirmed",
    isTnC_accepted: true,
    attendee_details: attendee,
    attendees: [attendee],
    event_city: app.city || null,
    payment_id: paymentId,
    receipt_no: `RCPT${Date.now()}`,
    order_id: `THXA${Date.now()}${Math.floor(Math.random() * 1000)}`,
    createdBy: new Date(),
    updatedBy: new Date(),
  });
  try {
    const { ensureTicket, ensureInvoice } = require("../utils/documents");
    await ensureInvoice(order);   // GST tax invoice (attached to the email)
    await ensureTicket(order);    // ticket PDF with entry QR
  } catch (e) { console.error("application docs:", e.message); }
  return order;
};

/**
 * Send the full booking confirmation once an application is paid: WhatsApp with
 * the ticket PDF + email with the ticket & tax-invoice PDFs and the correct
 * per-city venue/time. Reuses the same tested path as a normal paid booking.
 * Lazy-require avoids any load-order cycle with orderController.
 */
const notifyConfirmed = (order) => {
  try {
    const { notifyBookingConfirmed } = require("./orderController");
    return Promise.resolve(notifyBookingConfirmed(order)).catch((e) =>
      console.error("application confirm notify failed:", e.message)
    );
  } catch (e) {
    console.error("application confirm notify failed:", e.message);
  }
};

/** POST /api/event-apply/pay/:token — start payment for an approved application. */
const payApplication = async (req, res) => {
  try {
    const app = await EventApplication.findOne({ payToken: req.params.token }).populate("event_id");
    if (!app) return res.status(404).json({ message: "Not found", statusCode: 404 });
    if (app.status === "paid") return res.status(400).json({ message: "Already paid", statusCode: 400 });
    if (app.status !== "approved") return res.status(400).json({ message: "This application isn't ready for payment yet", statusCode: 400 });
    // Event full: block payment even for approved applicants holding a pay link.
    if (app.event_id?.soldOut) return res.status(409).json({ message: "This event is sold out", statusCode: 409 });
    // Charge the full payable: ticket price + 18% GST (+ 5% platform fee if male).
    const amount = applicationCharge(app).total;
    if (amount <= 0) return res.status(400).json({ message: "No amount is set", statusCode: 400 });

    const gw = await createGatewayOrder(Math.round(amount * 100), `app_${String(app._id).slice(-10)}`);
    app.paymentOrderId = gw.paymentOrderId;
    app.updatedBy = new Date();

    if (gw.mock) {
      const order = await createOrderFromApplication(app, app.event_id, `mock_pay_${crypto.randomBytes(6).toString("hex")}`);
      app.status = "paid"; app.paidAt = new Date(); app.order_id = order._id;
      await app.save();
      notifyConfirmed(order);
      return res.status(200).json({ message: "Paid", data: { mock: true, status: "paid" }, statusCode: 200 });
    }

    await app.save();
    return res.status(200).json({
      message: "Payment started",
      data: { mock: false, keyId: RZP_KEY_ID || null, amount: Math.round(amount * 100), currency: "INR", paymentOrderId: gw.paymentOrderId },
      statusCode: 200,
    });
  } catch (error) {
    console.error("payApplication error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** POST /api/event-apply/pay/:token/verify — confirm Razorpay payment → create booking. */
const verifyApplicationPayment = async (req, res) => {
  try {
    const app = await EventApplication.findOne({ payToken: req.params.token }).populate("event_id");
    if (!app) return res.status(404).json({ message: "Not found", statusCode: 404 });
    if (app.status === "paid") {
      // Self-heal: if the payment was captured but the Order failed to create on a
      // previous attempt (transient error), (re)create it now so the applicant
      // isn't left paid-with-no-booking.
      if (!app.order_id && app.event_id) {
        try {
          const order = await createOrderFromApplication(app, app.event_id, app.paymentId || null);
          app.order_id = order._id; await app.save();
          notifyConfirmed(order);
        } catch (e) { console.error("verifyApplicationPayment self-heal:", e.message); }
      }
      return res.status(200).json({ message: "Already paid", data: { status: "paid" }, statusCode: 200 });
    }
    if (app.status !== "approved") return res.status(400).json({ message: "This application isn't ready for payment", statusCode: 400 });

    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!app.paymentOrderId || razorpay_order_id !== app.paymentOrderId) {
      return res.status(400).json({ message: "Payment verification failed", statusCode: 400 });
    }
    if (!verifyGatewaySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature })) {
      return res.status(400).json({ message: "Payment verification failed", statusCode: 400 });
    }

    // Atomically claim (approved → paid) so a double callback can't double-book.
    const claimed = await EventApplication.findOneAndUpdate(
      { _id: app._id, status: "approved" },
      { $set: { status: "paid", paymentId: razorpay_payment_id, paidAt: new Date(), updatedBy: new Date() } },
      { new: true }
    );
    if (!claimed) return res.status(200).json({ message: "Already processed", data: { status: "paid" }, statusCode: 200 });

    const order = await createOrderFromApplication(claimed, app.event_id, razorpay_payment_id);
    claimed.order_id = order._id;
    await claimed.save();
    notifyConfirmed(order);

    return res.status(200).json({ message: "Payment confirmed", data: { status: "paid" }, statusCode: 200 });
  } catch (error) {
    console.error("verifyApplicationPayment error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/* ------------------------------- admin ------------------------------- */

/** GET /api/event-apply/admin/list?event_id=&status= — applications for the admin. */
const listApplications = async (req, res) => {
  try {
    const { event_id, status } = req.query;
    const filter = {};
    if (event_id) filter.event_id = event_id;
    if (status) filter.status = status;
    const rows = await EventApplication.find(filter)
      .sort({ createdBy: -1 })
      .populate("event_id", "name")
      .lean();
    return res.status(200).json({ message: "Applications", data: rows, statusCode: 200 });
  } catch (error) {
    console.error("listApplications error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * PATCH /api/event-apply/admin/:id — approve / reject / note.
 * On approve a payToken + login-free pay link is generated and emailed to the
 * applicant (they pay the ticket price they chose).
 */
const updateApplication = async (req, res) => {
  try {
    const app = await EventApplication.findById(req.params.id).populate("event_id", "name date start_time end_time locations city");
    if (!app) return res.status(404).json({ message: "Not found", statusCode: 404 });
    const { status, adminNote } = req.body;

    if (adminNote !== undefined) app.adminNote = adminNote ? String(adminNote).slice(0, 2000) : null;

    if (status !== undefined) {
      // "paid" is reached only through the real payment flow — never settable here.
      if (!["pending", "approved", "rejected"].includes(status)) {
        return res.status(400).json({ message: "Invalid status", statusCode: 400 });
      }
      // Never let the admin flip a real, paid application back.
      if (app.status === "paid") return res.status(400).json({ message: "This application is already paid", statusCode: 400 });
      app.status = status;
      if (status === "approved") {
        if (!app.payToken) app.payToken = crypto.randomBytes(24).toString("hex");
        const link = `${CUSTOMER_BASE()}/apply-pay/${app.payToken}`;
        const ev = app.event_id || {};
        const { total, breakup, whenLine, cityStr } = approvalParts(app, ev);
        if (app.email) {
          sendMail(
            app.email,
            `You're in — ${ev.name || "your event"} 🎉`,
            `<p>Hi ${app.name || "there"},</p>
             <p>Great news — your application for <b>${ev.name || "the event"}</b> has been approved!</p>
             <p>📍 ${cityStr}<br/>🗓 ${whenLine}</p>
             ${total > 0 ? `<p><b>Payment breakdown</b><br/>${breakup}<br/>Total to pay: <b>${inr(total)}</b></p>` : ""}
             <p>Confirm your spot: <a href="${link}">${link}</a></p>
             <p>See you there,<br/>Team IRL Social Hive</p>`
          ).catch((e) => console.error("application approve notify failed:", e.message));
        }
        // WhatsApp (approved Utility template) — pay link + breakup + city/time.
        // {{7}} is the payToken only; the template's URL button prepends the base.
        sendWaTemplate(app.phone, "TWILIO_WA_APPLICATION_APPROVED_SID", {
          1: firstName(app.name),
          2: ev.name || "your event",
          3: cityStr,
          4: whenLine,
          5: breakup,
          6: inr(total),
          7: app.payToken,
        }).catch((e) => console.error("application approve WA failed:", e.message));
      }
    }

    app.updatedBy = new Date();
    await app.save();
    return res.status(200).json({
      message: "Updated",
      data: { _id: app._id, status: app.status, payToken: app.payToken, adminNote: app.adminNote },
      statusCode: 200,
    });
  } catch (error) {
    console.error("updateApplication error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * POST /api/event-apply/admin/create — admin adds an application for someone who
 * reached out directly (e.g. an Instagram DM). Created already APPROVED with a
 * login-free pay link, so the admin can send the WhatsApp/email pay link and the
 * guest lands in the guest list once they pay. Works for any published event
 * (not just invite-only). Amount = the chosen ticket's price (server-resolved).
 */
const adminCreateApplication = async (req, res) => {
  try {
    const { event_id, name, email, phone, gender, DOB, city, maritalStatus, reasonToJoin, ticketName, answers } = req.body;
    const ev = await Event.findById(event_id);
    if (!ev) return res.status(404).json({ message: "Event not found", statusCode: 404 });
    if (!name || !String(name).trim()) return res.status(400).json({ message: "Name is required", statusCode: 400 });
    if (!phone && !email) return res.status(400).json({ message: "A phone or email is required", statusCode: 400 });

    // Resolve the chosen ticket → the price. If the event sells tickets, one must
    // resolve (else the pay link would be a ₹0 dead-end).
    const t = findTicket(ev, city, ticketName);
    const hasTickets = (ev.tickets && ev.tickets.length) || (ev.locations || []).some((l) => l.tickets && l.tickets.length);
    if (hasTickets && !t) {
      return res.status(400).json({ message: "Please choose a valid city and ticket for this event.", statusCode: 400 });
    }
    const base = t ? (Number(t.price) || 0) : num(req.body.amount);
    if (base <= 0) return res.status(400).json({ message: "No ticket price is set — pick a paid ticket.", statusCode: 400 });

    const app = await EventApplication.create({
      event_id: ev._id,
      name: cap(name, 120),
      email: cap(email, 200),
      phone: cap(phone, 30),
      gender: gender ? String(gender) : null,
      DOB: DOB || null,
      age: ageFromDob(DOB),
      city: cap(city, 120),
      maritalStatus: maritalStatus ? String(maritalStatus) : null,
      reasonToJoin: cap(reasonToJoin, 1000),
      answers: cleanAnswers(answers),
      ticketName: cap(ticketName, 120),
      amount: base,
      status: "approved",
      payToken: crypto.randomBytes(24).toString("hex"),
      addedByAdmin: true,
    });

    const link = `${CUSTOMER_BASE()}/apply-pay/${app.payToken}`;
    const { total, breakup, whenLine, cityStr } = approvalParts(app, ev);

    if (app.email) {
      sendMail(
        app.email,
        `You're in — ${ev.name || "your event"} 🎉`,
        `<p>Hi ${app.name || "there"},</p>
         <p>Your spot for <b>${ev.name || "the event"}</b> is reserved!</p>
         <p>📍 ${cityStr}<br/>🗓 ${whenLine}</p>
         <p><b>Payment breakdown</b><br/>${breakup}<br/>Total to pay: <b>${inr(total)}</b></p>
         <p>Confirm your spot: <a href="${link}">${link}</a></p>
         <p>See you there,<br/>Team IRL Social Hive</p>`
      ).catch((e) => console.error("admin-application email failed:", e.message));
    }
    sendWaTemplate(app.phone, "TWILIO_WA_APPLICATION_APPROVED_SID", {
      1: firstName(app.name),
      2: ev.name || "your event",
      3: cityStr,
      4: whenLine,
      5: breakup,
      6: inr(total),
      7: app.payToken,
    }).catch((e) => console.error("admin-application WA failed:", e.message));

    return res.status(201).json({
      message: "Application created",
      data: { _id: app._id, status: app.status, payToken: app.payToken, payLink: link, amount: base, payable: total },
      statusCode: 201,
    });
  } catch (error) {
    console.error("adminCreateApplication error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

module.exports = {
  getApplyInfo,
  submitApplication,
  getApplicationPayInfo,
  payApplication,
  verifyApplicationPayment,
  listApplications,
  updateApplication,
  adminCreateApplication,
};
