const { Reject } = require("twilio/lib/twiml/VoiceResponse");
const Event = require("../models/EventModel");
const Order = require("../models/orderModel");
const cloudinary = require("../utils/cloudinary");
const streamifier = require("streamifier");
const { refundOrderPayment } = require("./paymentController");
const { refundCredit } = require("./membershipController");
const { notifyOrder, niceDate, SUPPORT } = require("../utils/notify");

/** Age in whole years from a DOB, or null. */
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

/** Neutral third-person label from a stored gender — never a name. */
const pronounFor = (gender) => {
  switch (String(gender || "").toLowerCase()) {
    case "male": return "He";
    case "female": return "She";
    default: return "They";
  }
};

/**
 * GET /api/events/:id/going — PUBLIC, anonymised list of people attending an
 * event, for social proof on the detail page. Returns only { pronoun, age,
 * reasonToJoin } — never names, contact, or ids — so it's privacy-safe to show
 * to anyone. Draws from paid (or pass-covered) bookings that aren't cancelled
 * or rejected, one entry per attendee.
 */
const getEventGoing = async (req, res) => {
  try {
    const orders = await Order.find({
      event_id: req.params.id,
      // Only people who are actually still coming:
      status: "completed",              // paid (excludes cancelled / unpaid)
      applicationStatus: { $ne: "rejected" }, // not turned away by a host
      "refund.id": null,                // no money refund issued
      "refund.at": null,                // no refund/credit action of any kind
    })
      .select("attendees attendee_details user_id")
      // Account profile is the fallback for a reason/gender/age the booking omits
      // (e.g. older bookings made before the per-event reason existed).
      .populate("user_id", "reasonToJoin gender DOB")
      .sort({ createdBy: -1 })
      .lean();

    const people = [];
    for (const o of orders) {
      const list = Array.isArray(o.attendees) && o.attendees.length
        ? o.attendees
        : (o.attendee_details ? [o.attendee_details] : []);
      list.forEach((p, i) => {
        // Only the booker (first attendee) can borrow from the account profile.
        const acct = i === 0 ? (o.user_id || {}) : {};
        const reason = (p.reasonToJoin || acct.reasonToJoin || "").trim();
        people.push({
          pronoun: pronounFor(p.gender || acct.gender),
          age: p.age ?? ageFromDob(p.DOB || acct.DOB),
          reasonToJoin: reason || null,
        });
      });
    }

    res.status(200).json({ message: "Going", data: { count: people.length, people }, statusCode: 200 });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(200).json({ message: "Going", data: { count: 0, people: [] }, statusCode: 200 });
    }
    console.error("getEventGoing error:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

const getEvents = async (req, res) => {
  try {
    // The list response must stay under AWS Lambda's 6 MB response cap. The
    // long HTML `instruction` field (~4 MB across all events) is only needed on
    // the event detail page, so it is excluded here; `GET /api/events/:id`
    // still returns the full document.
    const events = await Event.find({}).select("-instruction");

    res.status(200).json({ size: events.length, events });
  } catch (err) {
    console.error("Error fetching events:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

/** GET /api/events/:id — single event, used by the public event detail page. */
const getEventById = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);

    if (!event) {
      return res.status(404).json({ message: "Event not found", statusCode: 404 });
    }

    res.status(200).json({ message: "Event", data: event, statusCode: 200 });
  } catch (err) {
    // A malformed ObjectId throws a CastError rather than returning null.
    if (err.name === "CastError") {
      return res.status(404).json({ message: "Event not found", statusCode: 404 });
    }
    console.error("Error fetching event:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

const createEvent = async (req, res) => {
  try {
    const {
      name,
      type,
      city,
      venue,
      date,
      tickets,
      min_age,
      max_age,
      venue_name,
      start_time,
      end_time,
      coordinates,
      description,
      instruction,
      status,
    } = req.body;

    // In multipart requests these arrive as JSON strings — parse them back.
    let parsedTickets = tickets;
    if (typeof parsedTickets === "string") {
      try { parsedTickets = JSON.parse(parsedTickets); } catch { parsedTickets = []; }
    }
    let parsedCoordinates = coordinates;
    if (typeof parsedCoordinates === "string") {
      try { parsedCoordinates = JSON.parse(parsedCoordinates); } catch { parsedCoordinates = {}; }
    }

    // Diagnostics: confirm the multipart file actually survived API Gateway.
    console.log("createEvent hit — file present:", Boolean(req.file),
      "| content-type:", req.headers["content-type"],
      "| body keys:", Object.keys(req.body || {}));

    const file = req.file;
    if (!file) {
      return res.status(400).json({ message: "File not uploaded" });
    }

    const uploadToCloudinary = (fileBuffer) => {
      return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: "image" },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        stream.end(fileBuffer);
      });
    };

    const result = await uploadToCloudinary(file.buffer);

    const newEvent = new Event({
      name,
      type,
      city,
      venue,
      date,
      tickets: parsedTickets,
      min_age,
      max_age,
      venue_name,
      start_time,
      end_time,
      // NOTE: the schema field is misspelled "cordinates".
      cordinates: parsedCoordinates,
      description,
      instruction,
      status,
      image: result.secure_url,
      createdBy: new Date(),
    });

    const savedEvent = await newEvent.save();

    res.status(201).json(savedEvent);
  } catch (err) {
    console.error("createEvent error:", err);
    res.status(500).json({ message: err.message });
  }
};

/** Fields an admin may change on an event. */
const EDITABLE_EVENT_FIELDS = [
  "name", "type", "city", "venue", "venue_name", "date", "start_time", "end_time",
  "tickets", "description", "instruction", "min_age", "max_age", "cordinates", "image",
];

const EVENT_STATUSES = ["Published", "Unpublished", "Cancelled"];

/** PATCH /api/events/:id — admin edits an event. */
const updateEvent = async (req, res) => {
  try {
    const updates = {};
    for (const field of EDITABLE_EVENT_FIELDS) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    // `coordinates` is the natural spelling; the schema field is `cordinates`.
    if (req.body.coordinates !== undefined) updates.cordinates = req.body.coordinates;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "No editable fields provided", statusCode: 400 });
    }

    if (updates.date) {
      const parsed = new Date(updates.date);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ message: "date is not valid", statusCode: 400 });
      }
      updates.date = parsed;
    }

    if (updates.tickets && !Array.isArray(updates.tickets)) {
      return res.status(400).json({ message: "tickets must be an array", statusCode: 400 });
    }

    const event = await Event.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true });
    if (!event) {
      return res.status(404).json({ message: "Event not found", statusCode: 404 });
    }

    return res.status(200).json({ message: "Event updated", data: event, statusCode: 200 });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(404).json({ message: "Event not found", statusCode: 404 });
    }
    console.error("updateEvent error:", err);
    return res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

/** PATCH /api/events/:id/status — publish / unpublish / cancel. */
const updateEventStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!EVENT_STATUSES.includes(status)) {
      return res.status(400).json({
        message: `status must be one of: ${EVENT_STATUSES.join(", ")}`,
        statusCode: 400,
      });
    }

    const event = await Event.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true }
    );

    if (!event) {
      return res.status(404).json({ message: "Event not found", statusCode: 404 });
    }

    return res.status(200).json({ message: `Event ${status}`, data: event, statusCode: 200 });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(404).json({ message: "Event not found", statusCode: 404 });
    }
    console.error("updateEventStatus error:", err);
    return res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

/** DELETE /api/events/:id — refuses if anyone has already booked. */
const deleteEvent = async (req, res) => {
  try {
    const Order = require("../models/orderModel");

    const bookings = await Order.countDocuments({
      event_id: req.params.id,
      status: { $ne: "cancelled" },
    });

    if (bookings > 0) {
      return res.status(409).json({
        message: `Cannot delete: ${bookings} active booking(s) exist. Cancel the event instead.`,
        statusCode: 409,
      });
    }

    const event = await Event.findByIdAndDelete(req.params.id);
    if (!event) {
      return res.status(404).json({ message: "Event not found", statusCode: 404 });
    }

    return res.status(200).json({ message: "Event deleted", statusCode: 200 });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(404).json({ message: "Event not found", statusCode: 404 });
    }
    console.error("deleteEvent error:", err);
    return res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

/**
 * PATCH /api/admin/events/:id/reschedule — move a WHOLE event to a new date/time.
 * Every booking references this event, so they all follow automatically (their
 * tickets/attendees are untouched). Body: { date, start_time?, end_time? }.
 */
const rescheduleEvent = async (req, res) => {
  try {
    const { date, start_time, end_time } = req.body;
    if (!date) return res.status(400).json({ message: "date is required", statusCode: 400 });

    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: "Event not found", statusCode: 404 });

    event.date = new Date(date);
    if (start_time !== undefined) event.start_time = start_time;
    if (end_time !== undefined) event.end_time = end_time;
    await event.save();

    // Bookings reference the event, so they move with it. Notify every member.
    const orders = await Order.find({ event_id: event._id, status: "completed" })
      .populate("user_id", "email phone name");
    const affectedBookings = orders.length;

    const when = niceDate(event.date) + (event.start_time ? ` at ${event.start_time}` : "");
    const body =
      `Hi! "${event.name || "Your event"}" has been rescheduled to ${when}` +
      `${event.city ? ` in ${event.city}` : ""}. Your booking is still valid — no action needed. ` +
      `Questions? ${SUPPORT}\n— IRL Social Hive`;
    // Fire notifications in parallel, best-effort.
    await Promise.allSettled(orders.map((o) =>
      notifyOrder(o, { subject: `Event rescheduled — ${event.name || "IRL Social Hive"}`, body })
    ));

    return res.status(200).json({
      message: "Event rescheduled",
      data: {
        _id: event._id,
        date: event.date,
        start_time: event.start_time,
        end_time: event.end_time,
        affectedBookings,
      },
      statusCode: 200,
    });
  } catch (err) {
    if (err.name === "CastError") return res.status(404).json({ message: "Event not found", statusCode: 404 });
    console.error("rescheduleEvent error:", err);
    return res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

/**
 * POST /api/admin/events/:id/cancel — cancel a whole event and REFUND every
 * member: money bookings via Razorpay, Golden Pass bookings by returning the
 * credit. Each order is marked cancelled. Idempotent per order (won't refund a
 * booking that already has a refund).
 */
const cancelEvent = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: "Event not found", statusCode: 404 });

    // Every paid booking still standing for this event.
    const orders = await Order.find({ event_id: event._id, status: "completed" })
      .populate("user_id", "email phone name");

    let moneyRefunded = 0, creditsReturned = 0, failed = 0;
    for (const o of orders) {
      // Money refund (skip pass-covered, zero-value, or already-refunded ones).
      if (!o.paidByPass && (o.grand_total ?? 0) > 0 && o.payment_id && !o.refund?.id) {
        try { o.refund = await refundOrderPayment(o); moneyRefunded++; }
        catch (e) {
          console.error("event-cancel refund failed:", e.message);
          o.refund = { id: null, status: "failed", amount: o.grand_total ?? 0, at: new Date() };
          failed++;
        }
      }
      // Pass credit back.
      if (o.membership_id) {
        try { await refundCredit(o.membership_id); creditsReturned++; o.membership_id = null; }
        catch (e) { console.error("event-cancel credit refund failed:", e.message); }
      }
      o.status = "cancelled";
      o.cancelledAt = new Date();
      o.updatedBy = new Date();
      await o.save();
    }

    event.status = "Cancelled";
    await event.save();

    // Tell every member the event is off and their refund is on the way.
    const refundLine = (o) =>
      o.paidByPass
        ? "Your Golden Pass credit has been returned."
        : (o.grand_total ?? 0) > 0
          ? "Your payment is being refunded to your original payment method."
          : "";
    await Promise.allSettled(orders.map((o) =>
      notifyOrder(o, {
        subject: `Event cancelled — ${event.name || "IRL Social Hive"}`,
        body:
          `Hi, we're sorry — "${event.name || "your event"}"${event.city ? ` in ${event.city}` : ""} ` +
          `has been cancelled. ${refundLine(o)} Refunds can take 5–7 business days. ` +
          `Questions? ${SUPPORT}\n— IRL Social Hive`,
      })
    ));

    return res.status(200).json({
      message: "Event cancelled and members refunded",
      data: {
        _id: event._id,
        status: event.status,
        cancelledBookings: orders.length,
        moneyRefunded,
        creditsReturned,
        failed,
      },
      statusCode: 200,
    });
  } catch (err) {
    if (err.name === "CastError") return res.status(404).json({ message: "Event not found", statusCode: 404 });
    console.error("cancelEvent error:", err);
    return res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

module.exports = {
  getEvents,
  getEventById,
  getEventGoing,
  createEvent,
  updateEvent,
  updateEventStatus,
  deleteEvent,
  rescheduleEvent,
  cancelEvent,
};
