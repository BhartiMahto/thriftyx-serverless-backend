const { Reject } = require("twilio/lib/twiml/VoiceResponse");
const Event = require("../models/EventModel");
const Order = require("../models/orderModel");
const EventInterest = require("../models/eventInterestModel");
const User = require("../models/userModel");
const cloudinary = require("../utils/cloudinary");
const streamifier = require("streamifier");
const { refundOrderPayment } = require("./paymentController");
const { refundCredit } = require("./membershipController");
const { notifyOrder, notifyUser, niceDate, SUPPORT } = require("../utils/notify");
const s3 = require("../utils/s3");

/**
 * Invalidate the cached ticket PDFs for every active booking of an event, so
 * they regenerate with the event's new details (date/time/venue) on next
 * download. The old PDFs are deleted from the bucket (keys are random, so a
 * regenerated ticket gets a new key). The QR is a deterministic JWT, so any
 * ticket a customer already downloaded still scans at the door. Returns how
 * many bookings were refreshed.
 */
async function invalidateEventTickets(eventId) {
  const filter = {
    event_id: eventId,
    status: { $ne: "cancelled" },
    ticket_url: { $nin: [null, ""] },
  };
  const orders = await Order.find(filter, { ticket_url: 1 });
  if (!orders.length) return 0;
  // Delete old objects best-effort (a failed delete just leaves an orphan).
  await Promise.allSettled(orders.map((o) => s3.deleteByUrl(o.ticket_url)));
  await Order.updateMany(filter, { $unset: { ticket_url: "" } });
  return orders.length;
}

/** Age in whole years from a DOB, or null. */
/** Normalise a per-city tickets array (from JSON or multipart string). */
const normalizeTickets = (raw) => {
  let t = raw;
  if (typeof t === "string") { try { t = JSON.parse(t); } catch { t = []; } }
  if (!Array.isArray(t)) return [];
  return t
    .map((x) => ({
      name: String(x.name ?? x.type ?? "").trim(),
      price: Number(x.price) || 0,
      quantity: Number(x.quantity ?? x.capacity) || 0,
      description: String(x.description ?? "").trim(),
    }))
    .filter((x) => x.name);
};

/** Normalise a schedule/agenda array (from JSON or multipart string). */
const normalizeSchedule = (raw) => {
  let s = raw;
  if (typeof s === "string") { try { s = JSON.parse(s); } catch { s = []; } }
  if (!Array.isArray(s)) return [];
  return s
    .map((x) => ({
      time: String(x.time ?? "").trim(),
      activity: String(x.activity ?? "").trim(),
    }))
    .filter((x) => x.time || x.activity);
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
      .select("attendees attendee_details user_id event_city")
      // Account profile is the fallback for a reason/gender/age the booking omits
      // (e.g. older bookings made before the per-event reason existed).
      .populate("user_id", "reasonToJoin gender DOB")
      .sort({ createdBy: -1 })
      .lean();

    // Optional city filter (multi-city events). When a city is given, only
    // bookings for THAT city are shown — strict, so a Hyderabad booking never
    // appears under Mumbai. (Legacy bookings with no city won't match any city.)
    const cityFilter = (req.query.city || "").trim().toLowerCase();

    const people = [];
    for (const o of orders) {
      if (cityFilter && (o.event_city || "").trim().toLowerCase() !== cityFilter) {
        continue;
      }
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
    // The list must load fast enough to stay under API Gateway's 29 s timeout.
    // The large HTML `instruction` AND `description` fields are only needed on
    // the event detail page — loading them for all ~1300 events made this query
    // ~48 s (→ 503 timeout) and ~4.5 MB. Excluding BOTH drops it to ~13 s / ~1.3
    // MB. `GET /api/events/:id` still returns the full document, and no list UI
    // renders the full description.
    const events = await Event.find({}).select("-instruction -description").lean();

    // Attach interest counts, but only for "Coming soon" (interest) events — a
    // single grouped query, so the list stays cheap.
    const interestIds = events.filter((e) => e.stage === "interest").map((e) => e._id);
    if (interestIds.length) {
      const counts = await EventInterest.aggregate([
        { $match: { event_id: { $in: interestIds } } },
        { $group: { _id: "$event_id", n: { $sum: 1 } } },
      ]);
      const byId = new Map(counts.map((c) => [String(c._id), c.n]));
      for (const e of events) {
        if (e.stage === "interest") e.interestCount = byId.get(String(e._id)) || 0;
      }
    }

    // Per-event sales rollups so the ADMIN list cards show real numbers
    // (registered / paid / revenue and per-ticket sold). getEvents also serves
    // the PUBLIC /api/events, so this is admin-only — revenue must never leak to
    // the public endpoint, and the public list stays cheap. Two grouped queries
    // over orders, independent of event count.
    const isAdmin = (req.baseUrl || "").includes("admin");
    if (isAdmin) {
    const attendeeCount = { $max: [{ $size: { $ifNull: ["$attendees", []] } }, 1] };
    const [orderRollup, ticketRollup] = await Promise.all([
      Order.aggregate([
        { $match: { status: { $ne: "cancelled" } } },
        { $group: {
            _id: "$event_id",
            registered: { $sum: attendeeCount },
            paid: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, attendeeCount, 0] } },
            revenue: { $sum: { $cond: [{ $eq: ["$status", "completed"] }, { $ifNull: ["$grand_total", 0] }, 0] } },
        } },
      ]),
      Order.aggregate([
        { $match: { status: "completed" } },
        { $unwind: "$tickets" },
        { $group: { _id: { e: "$event_id", n: "$tickets.name" }, sold: { $sum: { $ifNull: ["$tickets.count", 1] } } } },
      ]),
    ]);

    const rollupById = new Map(orderRollup.map((r) => [String(r._id), r]));
    const soldById = new Map();
    for (const r of ticketRollup) {
      const eid = String(r._id.e);
      if (!soldById.has(eid)) soldById.set(eid, {});
      soldById.get(eid)[r._id.n] = r.sold;
    }
    for (const e of events) {
      const o = rollupById.get(String(e._id));
      e.rollup = {
        registered: o?.registered || 0,
        paid: o?.paid || 0,
        revenue: o?.revenue || 0,
        soldByTicket: soldById.get(String(e._id)) || {},
      };
    }
    }

    res.status(200).json({ size: events.length, events });
  } catch (err) {
    console.error("Error fetching events:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

/** GET /api/events/:id — single event, used by the public event detail page. */
const getEventById = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id).lean();

    if (!event) {
      return res.status(404).json({ message: "Event not found", statusCode: 404 });
    }

    if (event.stage === "interest") {
      event.interestCount = await EventInterest.countDocuments({ event_id: event._id });
    }

    // Live availability: how many of each ticket are already sold, per city.
    // Availability is computed (quantity - sold) rather than mutating quantity,
    // so cancels/refunds free the seat automatically. Only paid bookings count.
    const norm = (s) => String(s || "").trim().toLowerCase();
    const soldRows = await Order.aggregate([
      { $match: { event_id: event._id, status: "completed" } },
      { $unwind: "$tickets" },
      { $group: { _id: { c: "$event_city", n: "$tickets.name" }, sold: { $sum: { $ifNull: ["$tickets.count", 1] } } } },
    ]);
    const byCityName = new Map();
    const byName = new Map();
    for (const r of soldRows) {
      const n = norm(r._id.n);
      byCityName.set(`${norm(r._id.c)}||${n}`, (byCityName.get(`${norm(r._id.c)}||${n}`) || 0) + r.sold);
      byName.set(n, (byName.get(n) || 0) + r.sold);
    }
    for (const loc of event.locations || []) {
      for (const t of loc.tickets || []) {
        t.sold = byCityName.get(`${norm(loc.city)}||${norm(t.name)}`) || 0;
      }
    }
    for (const t of event.tickets || []) {
      t.sold = byName.get(norm(t.name)) || 0;
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
      stage,
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
    // Multiple city/venue pairs (JSON in multipart). Keep only those with a city
    // or venue filled in.
    let parsedLocations = req.body.locations;
    if (typeof parsedLocations === "string") {
      try { parsedLocations = JSON.parse(parsedLocations); } catch { parsedLocations = []; }
    }
    parsedLocations = Array.isArray(parsedLocations)
      ? parsedLocations
          .map((l) => ({
            city: (l.city || "").trim(),
            venue: (l.venue || l.venue_name || "").trim(),
            address: (l.address || "").trim(),
            lat: String(l.lat ?? l.latitude ?? ""),
            lng: String(l.lng ?? l.longitude ?? ""),
            tickets: normalizeTickets(l.tickets),
          }))
          .filter((l) => l.city || l.venue)
      : [];
    // Top-level city/venue mirror the first location (keeps the list view + old
    // records working). Fall back to the flat fields when no locations sent.
    const primary = parsedLocations[0];

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
      city: primary ? primary.city : city,
      venue: primary ? primary.venue : venue,
      date,
      tickets: parsedTickets,
      min_age,
      max_age,
      venue_name: primary ? primary.venue : venue_name,
      start_time,
      end_time,
      locations: parsedLocations,
      // NOTE: the schema field is misspelled "cordinates".
      cordinates: parsedCoordinates,
      description,
      instruction,
      status,
      // "interest" = Coming soon (collect interest, not bookable); "open" = normal.
      stage: stage === "interest" ? "interest" : "open",
      schedule: normalizeSchedule(req.body.schedule),
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

    // In a multipart request (poster replacement) every field is a string —
    // parse the structured ones back and coerce numbers.
    if (typeof updates.tickets === "string") {
      try { updates.tickets = JSON.parse(updates.tickets); } catch { updates.tickets = []; }
    }
    if (typeof updates.cordinates === "string") {
      try { updates.cordinates = JSON.parse(updates.cordinates); } catch { delete updates.cordinates; }
    }
    if (updates.min_age !== undefined) updates.min_age = Number(updates.min_age) || undefined;
    if (updates.max_age !== undefined) updates.max_age = Number(updates.max_age) || undefined;

    // A new poster was uploaded → push it to Cloudinary and store the URL.
    if (req.file) {
      const uploaded = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream({ folder: "image" }, (e, r) => (e ? reject(e) : resolve(r)));
        stream.end(req.file.buffer);
      });
      updates.image = uploaded.secure_url;
    }

    if (Object.keys(updates).length === 0 && req.body.locations === undefined) {
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

    // Schedule / agenda (structured array; JSON string in multipart).
    if (req.body.schedule !== undefined) {
      updates.schedule = normalizeSchedule(req.body.schedule);
    }

    // Stage: an admin may turn a normal event into a "Coming soon" (interest)
    // listing from the edit form. Turning interest -> open must go through the
    // dedicated "Open for booking" action (goLive) so interested users get
    // notified — so we deliberately ignore stage:"open" here.
    if (req.body.stage === "interest") {
      updates.stage = "interest";
      updates.notifiedInterested = false; // reset guard if it re-enters interest
    }

    // Multiple city/venue pairs — normalise and mirror the first onto the flat fields.
    if (req.body.locations !== undefined) {
      let locs = req.body.locations;
      if (typeof locs === "string") { try { locs = JSON.parse(locs); } catch { locs = []; } }
      locs = Array.isArray(locs)
        ? locs.map((l) => ({
            city: (l.city || "").trim(),
            venue: (l.venue || l.venue_name || "").trim(),
            address: (l.address || "").trim(),
            lat: String(l.lat ?? l.latitude ?? ""),
            lng: String(l.lng ?? l.longitude ?? ""),
            tickets: normalizeTickets(l.tickets),
          })).filter((l) => l.city || l.venue)
        : [];
      updates.locations = locs;
      if (locs[0]) {
        updates.city = locs[0].city;
        updates.venue = locs[0].venue;
        updates.venue_name = locs[0].venue;
      }
    }

    // Snapshot the schedule BEFORE saving, so we can tell if date/time actually
    // changed (and only then notify attendees).
    const prev = await Event.findById(req.params.id).select("date start_time end_time").lean();

    const event = await Event.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true });
    if (!event) {
      return res.status(404).json({ message: "Event not found", statusCode: 404 });
    }

    // If anything printed on the ticket changed, refresh cached ticket PDFs so
    // existing bookings show the new details on next download.
    const ticketFieldsChanged =
      updates.date !== undefined || updates.start_time !== undefined ||
      updates.end_time !== undefined || updates.venue !== undefined ||
      updates.venue_name !== undefined || updates.city !== undefined ||
      req.body.locations !== undefined;
    let ticketsRefreshed = 0;
    if (ticketFieldsChanged) {
      try { ticketsRefreshed = await invalidateEventTickets(event._id); }
      catch (e) { console.error("invalidateEventTickets (update) failed:", e.message); }
    }

    // If the date/time actually changed (not just re-submitted unchanged), tell
    // attendees so they know the new schedule and can grab the updated ticket.
    let attendeesNotified = 0;
    const dateChanged =
      updates.date !== undefined && prev && +new Date(prev.date || 0) !== +new Date(event.date || 0);
    const timeChanged =
      (updates.start_time !== undefined && (prev?.start_time || "") !== (event.start_time || "")) ||
      (updates.end_time !== undefined && (prev?.end_time || "") !== (event.end_time || ""));
    if (dateChanged || timeChanged) {
      try {
        const orders = await Order.find({ event_id: event._id, status: "completed" })
          .populate("user_id", "email phone name");
        const when = niceDate(event.date) + (event.start_time ? ` at ${event.start_time}` : "");
        const body =
          `Hi! "${event.name || "Your event"}" has been rescheduled to ${when}` +
          `${event.city ? ` in ${event.city}` : ""}. Your booking is still valid — no action needed. ` +
          `You can download your updated ticket from your profile. Questions? ${SUPPORT}\n— IRL Social Hive`;
        const results = await Promise.allSettled(orders.map((o) =>
          notifyOrder(o, { subject: `Event updated — ${event.name || "IRL Social Hive"}`, body })
        ));
        attendeesNotified = results.filter((r) => r.status === "fulfilled").length;
      } catch (e) { console.error("updateEvent notify failed:", e.message); }
    }

    return res.status(200).json({
      message: "Event updated", data: event, ticketsRefreshed, attendeesNotified, statusCode: 200,
    });
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

    // The date/time changed → refresh cached ticket PDFs so they show the new
    // schedule on next download.
    try { await invalidateEventTickets(event._id); }
    catch (e) { console.error("invalidateEventTickets (reschedule) failed:", e.message); }

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

/* ============================ Interest ("Coming soon") ============================ */

/**
 * POST /api/events/:id/interest — the signed-in user taps "I'm Interested" on a
 * Coming-soon event. Idempotent (the unique index means a repeat tap is a no-op).
 */
const markInterest = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id).select("stage name");
    if (!event) return res.status(404).json({ message: "Event not found", statusCode: 404 });
    if (event.stage !== "interest") {
      return res.status(400).json({ message: "This event is already open for booking", statusCode: 400 });
    }

    await EventInterest.updateOne(
      { event_id: event._id, user_id: req.user._id },
      { $setOnInsert: { event_id: event._id, user_id: req.user._id, notified: false } },
      { upsert: true }
    );

    const count = await EventInterest.countDocuments({ event_id: event._id });
    return res.status(200).json({ message: "Interest registered", data: { interested: true, count }, statusCode: 200 });
  } catch (err) {
    if (err.name === "CastError") return res.status(404).json({ message: "Event not found", statusCode: 404 });
    // Duplicate key (raced double-tap) → still "interested", not an error.
    if (err.code === 11000) {
      const count = await EventInterest.countDocuments({ event_id: req.params.id });
      return res.status(200).json({ message: "Interest registered", data: { interested: true, count }, statusCode: 200 });
    }
    console.error("markInterest error:", err);
    return res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

/** DELETE /api/events/:id/interest — the user un-marks interest (toggle off). */
const unmarkInterest = async (req, res) => {
  try {
    await EventInterest.deleteOne({ event_id: req.params.id, user_id: req.user._id });
    const count = await EventInterest.countDocuments({ event_id: req.params.id });
    return res.status(200).json({ message: "Interest removed", data: { interested: false, count }, statusCode: 200 });
  } catch (err) {
    if (err.name === "CastError") return res.status(404).json({ message: "Event not found", statusCode: 404 });
    console.error("unmarkInterest error:", err);
    return res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

/**
 * GET /api/events/:id/interest — count + whether the current user is interested
 * (optional auth: `interested` is false for guests).
 */
const getInterest = async (req, res) => {
  try {
    const eventId = req.params.id;
    const [count, mine] = await Promise.all([
      EventInterest.countDocuments({ event_id: eventId }),
      req.user ? EventInterest.exists({ event_id: eventId, user_id: req.user._id }) : null,
    ]);
    return res.status(200).json({ message: "Interest", data: { count, interested: Boolean(mine) }, statusCode: 200 });
  } catch (err) {
    if (err.name === "CastError") return res.status(404).json({ message: "Event not found", statusCode: 404 });
    console.error("getInterest error:", err);
    return res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

/**
 * GET /api/events/interested/mine — the event ids the signed-in user has marked
 * interest in. Lets the events list render the "Interested ✓" state cheaply.
 */
const myInterests = async (req, res) => {
  try {
    const rows = await EventInterest.find({ user_id: req.user._id }).select("event_id").lean();
    return res.status(200).json({ message: "My interests", data: rows.map((r) => String(r.event_id)), statusCode: 200 });
  } catch (err) {
    console.error("myInterests error:", err);
    return res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

/**
 * POST /api/admin/events/:id/go-live — open a Coming-soon event for booking and
 * notify everyone who registered interest (email + WhatsApp). Requires the event
 * to have a date and at least one ticket so there's something to book.
 * Idempotent: only interest rows not yet notified are messaged.
 */
const goLive = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);
    if (!event) return res.status(404).json({ message: "Event not found", statusCode: 404 });

    if (event.stage !== "interest") {
      return res.status(400).json({ message: "Event is already open for booking", statusCode: 400 });
    }
    if (!event.date) {
      return res.status(400).json({ message: "Add an event date before opening for booking", statusCode: 400 });
    }
    if (!Array.isArray(event.tickets) || event.tickets.length === 0) {
      return res.status(400).json({ message: "Add at least one ticket before opening for booking", statusCode: 400 });
    }

    // Flip to open + publish so it becomes bookable and visible.
    event.stage = "open";
    if (event.status !== "Published") event.status = "Published";
    event.notifiedInterested = true;
    await event.save();

    // Notify only those not already notified (idempotent across retries).
    const pending = await EventInterest.find({ event_id: event._id, notified: false })
      .populate("user_id", "email phone name");

    const link = `${(process.env.CUSTOMER_URL || "https://irlsocialhive.com").replace(/\/$/, "")}/events/${event._id}`;
    const when = niceDate(event.date);
    const subject = `Now open for booking — ${event.name || "IRL Social Hive"}`;
    const body =
      `Good news! "${event.name || "the event"} you were interested in"${event.city ? ` in ${event.city}` : ""} ` +
      `is now open for booking${event.date ? ` (${when})` : ""}. Grab your seat: ${link}\n— IRL Social Hive`;

    let notified = 0;
    await Promise.allSettled(
      pending.map((row) =>
        notifyUser(row.user_id, { subject, body })
          .then(() => { notified++; })
          .catch((e) => console.error("go-live notify:", e.message))
      )
    );
    // Mark them notified regardless of per-message delivery (best-effort, no spam on retry).
    await EventInterest.updateMany({ event_id: event._id, notified: false }, { $set: { notified: true } });

    return res.status(200).json({
      message: "Event opened for booking",
      data: { _id: event._id, stage: event.stage, status: event.status, interestedNotified: notified, totalPending: pending.length },
      statusCode: 200,
    });
  } catch (err) {
    if (err.name === "CastError") return res.status(404).json({ message: "Event not found", statusCode: 404 });
    console.error("goLive error:", err);
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
  markInterest,
  unmarkInterest,
  getInterest,
  myInterests,
  goLive,
};
