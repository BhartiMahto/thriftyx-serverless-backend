const Series = require("../models/SeriesModel");
const SeriesOrder = require("../models/SeriesOrderModel");
const Event = require("../models/EventModel");
const Order = require("../models/orderModel");
const cloudinary = require("../utils/cloudinary");
const sendMail = require("../utils/sendMail");
const { SUPPORT, niceDate } = require("../utils/notify");
const {
  createGatewayOrder,
  verifyGatewaySignature,
  MOCK_PAYMENTS,
  RZP_KEY_ID,
} = require("./paymentController");

/* ------------------------------- helpers ------------------------------- */

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

const uploadBuf = (buf) =>
  new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream({ folder: "series" }, (e, r) => (e ? reject(e) : resolve(r)));
    stream.end(buf);
  });

/** Parse + coerce the admin-supplied item list (drops entries with no event). */
const normalizeItems = (raw) => {
  let arr = raw;
  if (typeof arr === "string") { try { arr = JSON.parse(arr); } catch { arr = []; } }
  if (!Array.isArray(arr)) return [];
  return arr
    .map((x) => ({
      event_id: x?.event_id || x?.eventId || null,
      city: x?.city ? String(x.city).trim() : null,
      ticketName: x?.ticketName ? String(x.ticketName).trim() : null,
      price: Math.max(0, Number(x?.price) || 0),
    }))
    .filter((x) => x.event_id);
};

/** Shape a series for the API (optionally with populated event summaries). */
const EVENT_SUMMARY = "name type image cardImage date start_time end_time city venue venue_name locations min_age max_age";

/* ------------------------------- public -------------------------------- */

// GET /api/series — active sets, with a short event summary for the cards.
const getSeries = async (req, res) => {
  try {
    const series = await Series.find({ active: true })
      .sort({ createdAt: -1 })
      .populate("items.event_id", EVENT_SUMMARY)
      .lean();
    return res.status(200).json({ message: "Series", data: series, count: series.length, statusCode: 200 });
  } catch (err) {
    console.error("getSeries error:", err);
    return res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

// GET /api/series/:id — one set (active only for the public).
const getSeriesById = async (req, res) => {
  try {
    const series = await Series.findById(req.params.id).populate("items.event_id", EVENT_SUMMARY).lean();
    if (!series || !series.active) {
      return res.status(404).json({ message: "Set not found", statusCode: 404 });
    }
    return res.status(200).json({ message: "Series", data: series, statusCode: 200 });
  } catch (err) {
    if (err.name === "CastError") return res.status(404).json({ message: "Set not found", statusCode: 404 });
    console.error("getSeriesById error:", err);
    return res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

// POST /api/series/:id/order — start a set purchase (auth). Creates a pending
// SeriesOrder + a gateway order for the total. Bookings are created on verify.
const createSeriesOrder = async (req, res) => {
  try {
    const series = await Series.findById(req.params.id);
    if (!series || !series.active) {
      return res.status(404).json({ message: "Set not found", statusCode: 404 });
    }
    if (!Array.isArray(series.items) || series.items.length === 0) {
      return res.status(400).json({ message: "This set has no events yet.", statusCode: 400 });
    }

    const b = req.body || {};
    const name = String(b.name || "").trim();
    if (!name) return res.status(400).json({ message: "Name is required", statusCode: 400 });
    if (!b.email && !b.phone) return res.status(400).json({ message: "Email or phone is required", statusCode: 400 });
    if (!b.isTnC_accepted) return res.status(400).json({ message: "Please accept the terms & conditions", statusCode: 400 });

    const buyer = {
      name: name.slice(0, 120),
      email: b.email ? String(b.email).trim().slice(0, 200) : null,
      phone: b.phone ? String(b.phone).trim().slice(0, 30) : null,
      gender: b.gender ? String(b.gender) : null,
      DOB: b.DOB || null,
      age: b.DOB ? ageFromDob(b.DOB) : (b.age ? Number(b.age) : null),
      city: b.city ? String(b.city).trim() : null,
      maritalStatus: b.maritalStatus ? String(b.maritalStatus) : null,
    };

    // Age gate: the buyer must fall within EVERY event's allowed range.
    const events = await Event.find({ _id: { $in: series.items.map((i) => i.event_id) } }).select("name min_age max_age stage");
    const evById = new Map(events.map((e) => [String(e._id), e]));
    const age = ageFromDob(buyer.DOB);
    for (const item of series.items) {
      const ev = evById.get(String(item.event_id));
      if (!ev) continue;
      if (age != null) {
        const minA = Number(ev.min_age) || 18;
        const maxA = Number(ev.max_age) || 0;
        if (age < minA || (maxA && age > maxA)) {
          return res.status(400).json({
            message: `"${ev.name}" is for ages ${minA}${maxA ? `–${maxA}` : "+"}; your age (${age}) is outside that.`,
            statusCode: 400,
          });
        }
      }
    }

    const amount = Math.max(0, Number(series.price) || 0);
    if (amount <= 0) return res.status(400).json({ message: "This set isn't priced yet.", statusCode: 400 });

    const receipt_no = `SET${Date.now()}`;
    const seriesOrder = await SeriesOrder.create({
      series_id: series._id,
      user_id: req.user._id,
      buyer,
      items: series.items.map((i) => ({ event_id: i.event_id, city: i.city, ticketName: i.ticketName, price: i.price })),
      amount,
      status: "pending",
      receipt_no,
    });

    const { paymentOrderId, mock } = await createGatewayOrder(Math.round(amount * 100), receipt_no);
    seriesOrder.paymentOrderId = paymentOrderId;
    await seriesOrder.save();

    return res.status(200).json({
      message: "Set purchase started",
      data: {
        seriesOrderId: seriesOrder._id,
        paymentOrderId,
        amount: Math.round(amount * 100),
        currency: "INR",
        keyId: RZP_KEY_ID || null,
        receipt: receipt_no,
        mock,
      },
      statusCode: 200,
    });
  } catch (err) {
    console.error("createSeriesOrder error:", err);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** Create one confirmed event booking for a set purchase. */
const createChildBooking = async (item, event, so) => {
  const attendee = {
    name: so.buyer.name,
    email: so.buyer.email,
    phone: so.buyer.phone,
    gender: so.buyer.gender,
    age: so.buyer.age,
    DOB: so.buyer.DOB,
    city: item.city || so.buyer.city || null,
    maritalStatus: so.buyer.maritalStatus,
    reasonToJoin: null,
    answers: [],
  };
  const price = Math.max(0, Number(item.price) || 0);
  const order = await Order.create({
    user_id: so.user_id,
    event_id: event._id,
    tickets: [{ name: item.ticketName || "Set pass", count: 1, price }],
    total_price: price,
    booking_fee: 0,
    gst: 0,
    discount: 0,
    grand_total: price,
    status: "completed",
    applicationStatus: "confirmed", // a paid set = confirmed in every event
    isTnC_accepted: true,
    attendee_details: attendee,
    attendees: [attendee],
    event_city: item.city || so.buyer.city || null,
    seriesId: so.series_id,
    seriesOrderId: so._id,
    payment_id: so.payment_id || null,
    order_id: `THXS${Date.now()}${Math.floor(Math.random() * 1000)}`,
    createdBy: new Date(),
    updatedBy: new Date(),
  });
  try {
    const { ensureTicket } = require("../utils/documents");
    await ensureTicket(order);
  } catch (e) { console.error("series ticket:", e.message); }
  return order;
};

/** Best-effort confirmation email listing all events in the set. */
const notifySetBooked = async (so, series, events) => {
  try {
    const to = so.buyer.email;
    if (!to) return;
    const evById = new Map(events.map((e) => [String(e._id), e]));
    const lines = so.items.map((i, n) => {
      const ev = evById.get(String(i.event_id));
      const when = ev?.date ? niceDate(ev.date) : "date TBA";
      return `  ${n + 1}. ${ev?.name || "Event"} — ${when}${i.city ? ` (${i.city})` : ""}`;
    });
    const body = [
      `Thanks for booking "${series.title}"! 🎉`,
      "",
      "You're confirmed for all events in this set:",
      ...lines,
      "",
      "Your tickets are in your account under My Tickets. See you there!",
      `Questions? ${SUPPORT}`,
      "— IRL Social Hive",
    ].join("\n");
    await sendMail(to, `You're in — ${series.title}`, body);
  } catch (e) {
    console.error("notifySetBooked:", e.message);
  }
};

// POST /api/series/verify — confirm payment + create one booking per event (auth).
const verifySeriesPayment = async (req, res) => {
  try {
    const { seriesOrderId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    if (!seriesOrderId) return res.status(400).json({ message: "seriesOrderId is required", statusCode: 400 });

    const so = await SeriesOrder.findById(seriesOrderId);
    if (!so) return res.status(404).json({ message: "Set purchase not found", statusCode: 404 });
    if (String(so.user_id) !== String(req.user._id)) {
      return res.status(403).json({ message: "This purchase is not yours", statusCode: 403 });
    }
    if (so.status === "completed") {
      return res.status(200).json({ message: "Already confirmed", data: { seriesOrderId: so._id, status: "completed" }, statusCode: 200 });
    }
    if (so.status !== "pending") {
      return res.status(409).json({ message: "This purchase can no longer be paid", statusCode: 409 });
    }

    let paymentId;
    if (MOCK_PAYMENTS) {
      paymentId = razorpay_payment_id || `mock_pay_${Date.now()}`;
    } else {
      // Bind the callback to THIS purchase's gateway order, then verify the HMAC.
      if (!so.paymentOrderId || razorpay_order_id !== so.paymentOrderId) {
        return res.status(400).json({ message: "Payment verification failed", statusCode: 400 });
      }
      if (!verifyGatewaySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature })) {
        // Status-guarded so a bad-signature retry can never revert an order that
        // a concurrent valid verify already completed.
        await SeriesOrder.updateOne({ _id: so._id, status: "pending" }, { $set: { status: "failed" } });
        return res.status(400).json({ message: "Payment verification failed", statusCode: 400 });
      }
      paymentId = razorpay_payment_id;
    }

    // Atomically claim the purchase (pending -> completed) BEFORE creating any
    // bookings, so a duplicate/retried verify can't create the set twice.
    const claimed = await SeriesOrder.findOneAndUpdate(
      { _id: so._id, status: "pending" },
      { $set: { status: "completed", payment_id: paymentId } },
      { new: true }
    );
    if (!claimed) {
      return res.status(200).json({ message: "Already confirmed", data: { seriesOrderId: so._id, status: "completed" }, statusCode: 200 });
    }
    so.payment_id = paymentId; // so child bookings carry it

    // Create one confirmed booking per event (best-effort per item so one bad
    // event can't strand a paid set — failures are logged for the admin).
    const series = await Series.findById(so.series_id);
    const events = await Event.find({ _id: { $in: so.items.map((i) => i.event_id) } });
    const evById = new Map(events.map((e) => [String(e._id), e]));
    const childIds = [];
    for (const item of so.items) {
      const ev = evById.get(String(item.event_id));
      if (!ev) { console.error("series verify: missing event", String(item.event_id)); continue; }
      try {
        const child = await createChildBooking(item, ev, so);
        childIds.push(child._id);
      } catch (e) {
        console.error("series child booking failed:", String(item.event_id), e.message);
      }
    }

    // Status/payment_id already persisted by the atomic claim; just link children.
    await SeriesOrder.updateOne({ _id: so._id }, { $set: { childOrderIds: childIds } });

    if (series) await notifySetBooked(so, series, events);

    return res.status(200).json({
      message: "Set booked",
      data: { seriesOrderId: so._id, status: "completed", bookings: childIds.length },
      statusCode: 200,
    });
  } catch (err) {
    console.error("verifySeriesPayment error:", err);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/* -------------------------------- admin -------------------------------- */

// GET /api/series/admin/all
const listAllSeries = async (req, res) => {
  try {
    const series = await Series.find({}).sort({ createdAt: -1 }).populate("items.event_id", EVENT_SUMMARY).lean();
    return res.status(200).json({ message: "Series", data: series, statusCode: 200 });
  } catch (err) {
    console.error("listAllSeries error:", err);
    return res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

// GET /api/series/admin/orders — who bought which set.
const listSeriesOrders = async (req, res) => {
  try {
    const orders = await SeriesOrder.find({ status: "completed" })
      .sort({ createdAt: -1 })
      .populate("series_id", "title")
      .lean();
    return res.status(200).json({ message: "Set orders", data: orders, statusCode: 200 });
  } catch (err) {
    console.error("listSeriesOrders error:", err);
    return res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

// POST /api/series — create a set (multipart: optional `image`).
const createSeries = async (req, res) => {
  try {
    const items = normalizeItems(req.body.items);
    const sumPrice = items.reduce((s, i) => s + (Number(i.price) || 0), 0);
    let image = null;
    const file = req.files?.image?.[0];
    if (file) image = (await uploadBuf(file.buffer)).secure_url;

    const series = await Series.create({
      title: String(req.body.title || "").trim() || "Untitled set",
      description: String(req.body.description || ""),
      image,
      items,
      // Price defaults to the sum of item prices (no discount) unless overridden.
      price: req.body.price !== undefined && req.body.price !== "" ? Math.max(0, Number(req.body.price) || 0) : sumPrice,
      active: req.body.active === "true" || req.body.active === true,
    });
    return res.status(201).json({ message: "Set created", data: series, statusCode: 201 });
  } catch (err) {
    console.error("createSeries error:", err);
    return res.status(500).json({ message: err.message, statusCode: 500 });
  }
};

// PATCH /api/series/:id — edit a set (multipart: optional new `image`).
const updateSeries = async (req, res) => {
  try {
    const series = await Series.findById(req.params.id);
    if (!series) return res.status(404).json({ message: "Set not found", statusCode: 404 });

    if (req.body.title !== undefined) series.title = String(req.body.title).trim();
    if (req.body.description !== undefined) series.description = String(req.body.description);
    if (req.body.items !== undefined) series.items = normalizeItems(req.body.items);
    if (req.body.price !== undefined && req.body.price !== "") series.price = Math.max(0, Number(req.body.price) || 0);
    if (req.body.active !== undefined) series.active = req.body.active === "true" || req.body.active === true;

    const file = req.files?.image?.[0];
    if (file) series.image = (await uploadBuf(file.buffer)).secure_url;

    await series.save();
    return res.status(200).json({ message: "Set updated", data: series, statusCode: 200 });
  } catch (err) {
    console.error("updateSeries error:", err);
    return res.status(500).json({ message: err.message, statusCode: 500 });
  }
};

// PATCH /api/series/:id/status — publish / unpublish.
const setSeriesStatus = async (req, res) => {
  try {
    const series = await Series.findByIdAndUpdate(
      req.params.id,
      { active: req.body.active === "true" || req.body.active === true },
      { new: true }
    );
    if (!series) return res.status(404).json({ message: "Set not found", statusCode: 404 });
    return res.status(200).json({ message: "Set updated", data: series, statusCode: 200 });
  } catch (err) {
    console.error("setSeriesStatus error:", err);
    return res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

// DELETE /api/series/:id
const deleteSeries = async (req, res) => {
  try {
    const series = await Series.findByIdAndDelete(req.params.id);
    if (!series) return res.status(404).json({ message: "Set not found", statusCode: 404 });
    return res.status(200).json({ message: "Set deleted", statusCode: 200 });
  } catch (err) {
    console.error("deleteSeries error:", err);
    return res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

module.exports = {
  getSeries,
  getSeriesById,
  createSeriesOrder,
  verifySeriesPayment,
  listAllSeries,
  listSeriesOrders,
  createSeries,
  updateSeries,
  setSeriesStatus,
  deleteSeries,
};
