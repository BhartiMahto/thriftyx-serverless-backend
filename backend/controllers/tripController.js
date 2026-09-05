const crypto = require("crypto");
const Trip = require("../models/TripModel");
const TripRegistration = require("../models/TripRegistrationModel");
const cloudinary = require("../utils/cloudinary");
const sendMail = require("../utils/sendMail");
const { createGatewayOrder, verifyGatewaySignature, MOCK_PAYMENTS, RZP_KEY_ID } = require("./paymentController");

/* ------------------------------- helpers ------------------------------- */

/** Parse a field that may arrive as JSON (plain request) or a JSON string (multipart). */
const parseArr = (v) => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string" && v.trim()) { try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; } }
  return [];
};

const uploadBuf = (buf) => new Promise((resolve, reject) => {
  const stream = cloudinary.uploader.upload_stream({ folder: "trips" }, (e, r) => (e ? reject(e) : resolve(r)));
  stream.end(buf);
});

const num = (v, d = 0) => { const n = Number(v); return Number.isFinite(n) ? n : d; };
const str = (v) => (v === undefined || v === null ? null : String(v));

const normalizeItinerary = (raw) => parseArr(raw)
  .map((x, i) => ({
    day: num(x?.day, i + 1),
    phase: str(x?.phase),
    title: str(x?.title),
    description: str(x?.description),
  }))
  .filter((x) => x.title || x.description);

const normalizePaymentSchedule = (raw) => parseArr(raw)
  .map((x) => ({ label: str(x?.label), dueLabel: str(x?.dueLabel), amount: num(x?.amount) }))
  .filter((x) => x.label || x.amount);

const normalizeStrings = (raw) => parseArr(raw).map((s) => String(s ?? "").trim()).filter(Boolean);

/** Build the editable-fields object shared by create + update from req.body. */
const tripFieldsFromBody = (body) => {
  const out = {};
  const copy = (k, tx = (v) => v) => { if (body[k] !== undefined) out[k] = tx(body[k]); };
  copy("name");
  copy("destination");
  copy("region");
  copy("route");
  copy("isInternational", (v) => v === true || v === "true");
  copy("start_date", (v) => (v ? new Date(v) : null));
  copy("end_date", (v) => (v ? new Date(v) : null));
  copy("duration_days", (v) => num(v));
  copy("duration_nights", (v) => num(v));
  copy("age_min", (v) => num(v));
  copy("age_max", (v) => num(v));
  copy("price_from", (v) => num(v));
  copy("description");
  copy("status");
  if (body.itinerary !== undefined) out.itinerary = normalizeItinerary(body.itinerary);
  if (body.inclusions !== undefined) out.inclusions = normalizeStrings(body.inclusions);
  if (body.exclusions !== undefined) out.exclusions = normalizeStrings(body.exclusions);
  if (body.highlights !== undefined) out.highlights = normalizeStrings(body.highlights);
  if (body.gallery !== undefined) out.gallery = normalizeStrings(body.gallery);
  if (body.payment_schedule !== undefined) out.payment_schedule = normalizePaymentSchedule(body.payment_schedule);
  copy("spots_total", (v) => num(v));
  copy("spots_left", (v) => num(v));
  return out;
};

const ADMIN_NOTIFY = process.env.TRIPS_NOTIFY_EMAIL || process.env.SELLER_EMAIL || "help@thriftyx.com";
const CUSTOMER_BASE = () => (process.env.CUSTOMER_URL || "https://irlsocialhive.com").replace(/\/$/, "");

/* ------------------------------- public ------------------------------- */

/** GET /api/trips — published trips, with search + India/International scope + sort. */
const getTrips = async (req, res) => {
  try {
    const { q, scope, sort } = req.query;
    const filter = { status: "Published" };
    if (scope === "india") filter.isInternational = false;
    else if (scope === "international") filter.isInternational = true;
    if (q && String(q).trim()) {
      const rx = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ name: rx }, { destination: rx }, { region: rx }, { route: rx }];
    }

    let sortSpec = { start_date: 1 };
    if (sort === "price_asc") sortSpec = { price_from: 1 };
    else if (sort === "price_desc") sortSpec = { price_from: -1 };
    else if (sort === "longest") sortSpec = { duration_days: -1 };
    else if (sort === "spots") sortSpec = { spots_left: 1 };

    const trips = await Trip.find(filter).sort(sortSpec).lean();
    // Counts for the filter tabs (ignore the q/scope filter, only Published).
    const [all, india, intl] = await Promise.all([
      Trip.countDocuments({ status: "Published" }),
      Trip.countDocuments({ status: "Published", isInternational: false }),
      Trip.countDocuments({ status: "Published", isInternational: true }),
    ]);
    return res.status(200).json({
      message: "Trips",
      data: trips,
      counts: { all, india, international: intl },
      statusCode: 200,
    });
  } catch (error) {
    console.error("getTrips error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** GET /api/trips/:id — one trip (full). */
const getTripById = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id).lean();
    if (!trip) return res.status(404).json({ message: "Trip not found", statusCode: 404 });
    return res.status(200).json({ message: "Trip", data: trip, statusCode: 200 });
  } catch (error) {
    console.error("getTripById error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** POST /api/trips/:id/request — public; capture a request to join (no login, no payment). */
const createRegistration = async (req, res) => {
  try {
    const trip = await Trip.findById(req.params.id);
    if (!trip || trip.status !== "Published") {
      return res.status(404).json({ message: "Trip not found", statusCode: 404 });
    }
    const { name, email, phone, city, pronouns, message } = req.body;
    if (!name || !String(name).trim()) return res.status(400).json({ message: "Name is required", statusCode: 400 });
    if (!phone && !email) return res.status(400).json({ message: "A phone or email is required", statusCode: 400 });

    // This endpoint is public (no login) — cap every field so a script can't store
    // oversized documents.
    const cap = (v, n) => (v ? String(v).trim().slice(0, n) : null);
    const reg = await TripRegistration.create({
      trip_id: trip._id,
      name: cap(name, 120),
      email: cap(email, 200),
      phone: cap(phone, 30),
      city: cap(city, 120),
      pronouns: cap(pronouns, 40),
      message: cap(message, 1000),
      status: "requested",
    });

    // Notify the team (best-effort). Locally this is redirected to the DEV inbox.
    sendMail(
      ADMIN_NOTIFY,
      `New trip request — ${trip.name}`,
      `<p>New request to join <b>${trip.name}</b>.</p>
       <ul>
         <li>Name: ${reg.name}</li>
         <li>Phone: ${reg.phone || "—"}</li>
         <li>Email: ${reg.email || "—"}</li>
         <li>City: ${reg.city || "—"}</li>
         <li>Pronouns: ${reg.pronouns || "—"}</li>
         ${reg.message ? `<li>Message: ${reg.message}</li>` : ""}
       </ul>
       <p>Review it in the admin Trips → Registrations tab.</p>`
    ).catch((e) => console.error("trip request notify failed:", e.message));

    return res.status(201).json({
      message: "Request received",
      data: { _id: reg._id, status: reg.status },
      statusCode: 201,
    });
  } catch (error) {
    console.error("createRegistration error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** GET /api/trips/pay/:token — the accepted registration behind a login-free pay page. */
const getRegistrationByToken = async (req, res) => {
  try {
    const reg = await TripRegistration.findOne({ payToken: req.params.token }).populate(
      "trip_id",
      "name destination region route image start_date end_date"
    );
    if (!reg) return res.status(404).json({ message: "Not found", statusCode: 404 });
    return res.status(200).json({
      message: "Registration",
      data: {
        _id: reg._id,
        name: reg.name,
        status: reg.status,
        amount: reg.amount,
        paidAt: reg.paidAt,
        trip: reg.trip_id,
      },
      statusCode: 200,
    });
  } catch (error) {
    console.error("getRegistrationByToken error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** POST /api/trips/pay/:token — start payment for an accepted registration. */
const payRegistration = async (req, res) => {
  try {
    const reg = await TripRegistration.findOne({ payToken: req.params.token });
    if (!reg) return res.status(404).json({ message: "Not found", statusCode: 404 });
    if (reg.status === "paid") return res.status(400).json({ message: "Already paid", statusCode: 400 });
    if (reg.status !== "accepted") return res.status(400).json({ message: "This request isn't ready for payment yet", statusCode: 400 });
    const amount = num(reg.amount);
    if (amount <= 0) return res.status(400).json({ message: "No amount is set for this request", statusCode: 400 });

    const gw = await createGatewayOrder(Math.round(amount * 100), `trip_${String(reg._id).slice(-10)}`);
    reg.paymentOrderId = gw.paymentOrderId;
    reg.updatedBy = new Date();

    // Mock mode (dev): no gateway — mark paid immediately.
    if (gw.mock) {
      reg.status = "paid";
      reg.paidAt = new Date();
      await reg.save();
      return res.status(200).json({ message: "Paid", data: { mock: true, status: "paid" }, statusCode: 200 });
    }

    await reg.save();
    return res.status(200).json({
      message: "Payment started",
      data: {
        mock: false,
        keyId: RZP_KEY_ID || null,
        amount: Math.round(amount * 100),
        currency: "INR",
        paymentOrderId: gw.paymentOrderId,
      },
      statusCode: 200,
    });
  } catch (error) {
    console.error("payRegistration error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** POST /api/trips/pay/:token/verify — confirm a Razorpay payment → mark paid. */
const verifyRegistrationPayment = async (req, res) => {
  try {
    const reg = await TripRegistration.findOne({ payToken: req.params.token });
    if (!reg) return res.status(404).json({ message: "Not found", statusCode: 404 });
    if (reg.status === "paid") return res.status(200).json({ message: "Already paid", data: { status: "paid" }, statusCode: 200 });
    // Only an accepted registration that actually started a payment can be verified.
    if (reg.status !== "accepted") return res.status(400).json({ message: "This request isn't ready for payment", statusCode: 400 });
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    // Bind the callback to THIS registration's own order — a valid signature for
    // some other order on the merchant account must not mark this trip paid.
    if (!reg.paymentOrderId || razorpay_order_id !== reg.paymentOrderId) {
      return res.status(400).json({ message: "Payment verification failed", statusCode: 400 });
    }
    const ok = verifyGatewaySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature });
    if (!ok) return res.status(400).json({ message: "Payment verification failed", statusCode: 400 });
    reg.status = "paid";
    reg.paymentId = razorpay_payment_id;
    reg.paidAt = new Date();
    reg.updatedBy = new Date();
    await reg.save();
    return res.status(200).json({ message: "Payment confirmed", data: { status: "paid" }, statusCode: 200 });
  } catch (error) {
    console.error("verifyRegistrationPayment error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/* ------------------------------- admin ------------------------------- */

/** GET /api/trips/admin/all — every trip incl. drafts (admin only). */
const listAllTrips = async (req, res) => {
  try {
    const trips = await Trip.find({}).sort({ start_date: 1, createdBy: -1 }).lean();
    return res.status(200).json({ message: "Trips", data: trips, statusCode: 200 });
  } catch (error) {
    console.error("listAllTrips error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

const createTrip = async (req, res) => {
  try {
    const fields = tripFieldsFromBody(req.body);
    if (!fields.name) return res.status(400).json({ message: "name is required", statusCode: 400 });

    const heroFile = req.files?.image?.[0];
    const cardFile = req.files?.cardImage?.[0];
    if (heroFile) fields.image = (await uploadBuf(heroFile.buffer)).secure_url;
    if (cardFile) fields.cardImage = (await uploadBuf(cardFile.buffer)).secure_url;

    const trip = await Trip.create({ ...fields, createdBy: new Date() });
    return res.status(201).json(trip);
  } catch (error) {
    console.error("createTrip error:", error);
    return res.status(500).json({ message: error.message, statusCode: 500 });
  }
};

const updateTrip = async (req, res) => {
  try {
    const updates = tripFieldsFromBody(req.body);
    const heroFile = req.files?.image?.[0];
    const cardFile = req.files?.cardImage?.[0];
    if (heroFile) updates.image = (await uploadBuf(heroFile.buffer)).secure_url;
    if (cardFile) updates.cardImage = (await uploadBuf(cardFile.buffer)).secure_url;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "No editable fields provided", statusCode: 400 });
    }
    const trip = await Trip.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true });
    if (!trip) return res.status(404).json({ message: "Trip not found", statusCode: 404 });
    return res.status(200).json({ message: "Trip updated", data: trip, statusCode: 200 });
  } catch (error) {
    console.error("updateTrip error:", error);
    return res.status(500).json({ message: error.message, statusCode: 500 });
  }
};

const setTripStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!["Published", "Unpublished"].includes(status)) {
      return res.status(400).json({ message: "Invalid status", statusCode: 400 });
    }
    const trip = await Trip.findByIdAndUpdate(req.params.id, { $set: { status } }, { new: true });
    if (!trip) return res.status(404).json({ message: "Trip not found", statusCode: 404 });
    return res.status(200).json({ message: "Status updated", data: trip, statusCode: 200 });
  } catch (error) {
    console.error("setTripStatus error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

const deleteTrip = async (req, res) => {
  try {
    const trip = await Trip.findByIdAndDelete(req.params.id);
    if (!trip) return res.status(404).json({ message: "Trip not found", statusCode: 404 });
    return res.status(200).json({ message: "Trip deleted", statusCode: 200 });
  } catch (error) {
    console.error("deleteTrip error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** GET /api/admin/trip-registrations?trip_id=&status= — list requests. */
const listRegistrations = async (req, res) => {
  try {
    const { trip_id, status } = req.query;
    const filter = {};
    if (trip_id) filter.trip_id = trip_id;
    if (status) filter.status = status;
    const rows = await TripRegistration.find(filter)
      .sort({ createdBy: -1 })
      .populate("trip_id", "name destination")
      .lean();
    return res.status(200).json({ message: "Registrations", data: rows, statusCode: 200 });
  } catch (error) {
    console.error("listRegistrations error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * PATCH /api/admin/trip-registrations/:id — accept (with amount) / reject / note.
 * On accept a payToken + login-free pay link is generated and emailed to the guest.
 */
const updateRegistration = async (req, res) => {
  try {
    const reg = await TripRegistration.findById(req.params.id).populate("trip_id", "name");
    if (!reg) return res.status(404).json({ message: "Not found", statusCode: 404 });
    const { status, amount, adminNote } = req.body;

    if (adminNote !== undefined) reg.adminNote = adminNote ? String(adminNote).slice(0, 2000) : null;
    if (amount !== undefined) reg.amount = num(amount);

    if (status !== undefined) {
      if (!["requested", "accepted", "rejected", "paid", "cancelled"].includes(status)) {
        return res.status(400).json({ message: "Invalid status", statusCode: 400 });
      }
      reg.status = status;
      if (status === "accepted") {
        if (!reg.payToken) reg.payToken = crypto.randomBytes(24).toString("hex");
        // Email the guest a login-free pay link (best-effort).
        if (reg.email) {
          const link = `${CUSTOMER_BASE()}/trip-pay/${reg.payToken}`;
          const amt = num(reg.amount);
          sendMail(
            reg.email,
            `You're in — ${reg.trip_id?.name || "your trip"} 🎉`,
            `<p>Hi ${reg.name || "there"},</p>
             <p>Great news — your request to join <b>${reg.trip_id?.name || "the trip"}</b> has been accepted!</p>
             ${amt > 0 ? `<p>To reserve your spot, please pay <b>₹${amt.toLocaleString("en-IN")}</b>:</p>` : "<p>Please complete your booking:</p>"}
             <p><a href="${link}">${link}</a></p>
             <p>See you there,<br/>Team IRL Social Hive</p>`
          ).catch((e) => console.error("trip accept notify failed:", e.message));
        }
      }
    }

    reg.updatedBy = new Date();
    await reg.save();
    return res.status(200).json({
      message: "Updated",
      data: { _id: reg._id, status: reg.status, amount: reg.amount, payToken: reg.payToken, adminNote: reg.adminNote },
      statusCode: 200,
    });
  } catch (error) {
    console.error("updateRegistration error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

module.exports = {
  // public
  getTrips,
  getTripById,
  createRegistration,
  getRegistrationByToken,
  payRegistration,
  verifyRegistrationPayment,
  // admin
  listAllTrips,
  createTrip,
  updateTrip,
  setTripStatus,
  deleteTrip,
  listRegistrations,
  updateRegistration,
};
