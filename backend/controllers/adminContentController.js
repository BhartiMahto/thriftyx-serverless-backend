const EventCity = require("../models/eventCityModel");
const Story = require("../models/storyModel");
const Review = require("../models/reviewModel");
const Support = require("../models/supportModel");
const User = require("../models/userModel");
const Order = require("../models/orderModel");
const Event = require("../models/EventModel");

/**
 * Admin management for cities, blogs (stories), ratings (reviews), bookings,
 * customers and support tickets.
 *
 * Every list here is paginated. The users and orders collections hold 16k and
 * 8k documents respectively, and the previous endpoints returned all of them in
 * one response.
 */

const paging = (query) => {
  const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 200);
  const page = Math.max(Number(query.page) || 1, 1);
  return { limit, page, skip: (page - 1) * limit };
};

const meta = (total, limit, page) => ({
  total,
  page,
  limit,
  pages: Math.ceil(total / limit) || 1,
});

/** Escapes user input before it goes into a regex, so "a+b" can't blow up. */
const safeRegex = (text) =>
  new RegExp(String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

/* ------------------------------ Cities ------------------------------ */

const listCities = async (req, res) => {
  try {
    const cities = await EventCity.find().sort({ city: 1 }).lean();

    // How many events exist per city, so the UI can warn before deleting.
    const counts = await Event.aggregate([
      { $group: { _id: "$city", n: { $sum: 1 } } },
    ]);
    const byCity = new Map(counts.map((c) => [c._id, c.n]));

    res.status(200).json({
      message: "Cities",
      data: cities.map((c) => ({ ...c, eventCount: byCity.get(c.city) ?? 0 })),
      statusCode: 200,
    });
  } catch (error) {
    console.error("listCities error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

const createCity = async (req, res) => {
  try {
    const { city, state, country } = req.body;
    if (!city || !String(city).trim()) {
      return res.status(400).json({ message: "City is required", statusCode: 400 });
    }

    const name = String(city).trim();
    if (await EventCity.findOne({ city: safeRegex(`^${name}$`) })) {
      return res.status(409).json({ message: "City already exists", statusCode: 409 });
    }

    const created = await EventCity.create({
      city: name,
      state: state ? String(state).trim() : null,
      country: country ? String(country).trim() : "India",
      createdBy: new Date(),
    });

    res.status(201).json({ message: "City added", data: created, statusCode: 201 });
  } catch (error) {
    console.error("createCity error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

const updateCity = async (req, res) => {
  try {
    const updates = {};
    for (const f of ["city", "state", "country"]) {
      if (req.body[f] !== undefined) updates[f] = String(req.body[f]).trim() || null;
    }
    if (!Object.keys(updates).length) {
      return res.status(400).json({ message: "Nothing to update", statusCode: 400 });
    }
    if (updates.city === null) {
      return res.status(400).json({ message: "City cannot be empty", statusCode: 400 });
    }

    const updated = await EventCity.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: "City not found", statusCode: 404 });

    res.status(200).json({ message: "City updated", data: updated, statusCode: 200 });
  } catch (error) {
    if (error.name === "CastError") {
      return res.status(404).json({ message: "City not found", statusCode: 404 });
    }
    console.error("updateCity error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

const deleteCity = async (req, res) => {
  try {
    const city = await EventCity.findById(req.params.id);
    if (!city) return res.status(404).json({ message: "City not found", statusCode: 404 });

    // Events store the city as a plain string, so removing the row would orphan
    // them silently. Refuse and say how many are affected.
    const eventCount = await Event.countDocuments({ city: city.city });
    if (eventCount > 0) {
      return res.status(409).json({
        message: `${eventCount} event(s) are in ${city.city}. Reassign them first.`,
        statusCode: 409,
      });
    }

    await EventCity.findByIdAndDelete(req.params.id);
    res.status(200).json({ message: "City deleted", statusCode: 200 });
  } catch (error) {
    if (error.name === "CastError") {
      return res.status(404).json({ message: "City not found", statusCode: 404 });
    }
    console.error("deleteCity error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/* ------------------------------ Blogs / stories ------------------------------ */

const listStories = async (req, res) => {
  try {
    const { limit, page, skip } = paging(req.query);
    const filter = {};
    if (req.query.status && req.query.status !== "all") filter.status = req.query.status;
    if (req.query.search) filter.storyTitle = safeRegex(req.query.search);

    const [rows, total] = await Promise.all([
      Story.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      Story.countDocuments(filter),
    ]);

    res.status(200).json({ message: "Stories", data: rows, meta: meta(total, limit, page), statusCode: 200 });
  } catch (error) {
    console.error("listStories error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** Moderation. The public site only shows stories with status "accepted". */
const setStoryStatus = async (req, res) => {
  try {
    const { status } = req.body;
    if (!["accepted", "rejected", "pending"].includes(status)) {
      return res
        .status(400)
        .json({ message: "status must be accepted, rejected or pending", statusCode: 400 });
    }

    const updated = await Story.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: "Story not found", statusCode: 404 });

    res.status(200).json({ message: `Story ${status}`, data: updated, statusCode: 200 });
  } catch (error) {
    if (error.name === "CastError") {
      return res.status(404).json({ message: "Story not found", statusCode: 404 });
    }
    console.error("setStoryStatus error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

const deleteStory = async (req, res) => {
  try {
    const deleted = await Story.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: "Story not found", statusCode: 404 });
    res.status(200).json({ message: "Story deleted", statusCode: 200 });
  } catch (error) {
    if (error.name === "CastError") {
      return res.status(404).json({ message: "Story not found", statusCode: 404 });
    }
    console.error("deleteStory error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/* ------------------------------ Ratings / reviews ------------------------------ */

const listReviews = async (req, res) => {
  try {
    const { limit, page, skip } = paging(req.query);
    const filter = {};
    if (req.query.search) {
      filter.$or = [
        { name: safeRegex(req.query.search) },
        { location: safeRegex(req.query.search) },
      ];
    }
    if (req.query.minRating) filter.rating = { $gte: Number(req.query.minRating) };

    const [rows, total, avg] = await Promise.all([
      Review.find(filter).sort({ createdBy: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      Review.countDocuments(filter),
      Review.aggregate([{ $group: { _id: null, avg: { $avg: "$rating" } } }]),
    ]);

    res.status(200).json({
      message: "Reviews",
      data: rows,
      meta: { ...meta(total, limit, page), averageRating: Math.round((avg[0]?.avg ?? 0) * 10) / 10 },
      statusCode: 200,
    });
  } catch (error) {
    console.error("listReviews error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

const deleteReview = async (req, res) => {
  try {
    const deleted = await Review.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: "Review not found", statusCode: 404 });
    res.status(200).json({ message: "Review deleted", statusCode: 200 });
  } catch (error) {
    if (error.name === "CastError") {
      return res.status(404).json({ message: "Review not found", statusCode: 404 });
    }
    console.error("deleteReview error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/* ------------------------------ Support tickets ------------------------------ */

const SUPPORT_STATUSES = ["open", "in_progress", "resolved", "closed"];

const listSupportTickets = async (req, res) => {
  try {
    const { limit, page, skip } = paging(req.query);
    const filter = {};
    if (req.query.status && req.query.status !== "all") filter.status = req.query.status;
    if (req.query.search) {
      filter.$or = [
        { name: safeRegex(req.query.search) },
        { email: safeRegex(req.query.search) },
        { subject: safeRegex(req.query.search) },
      ];
    }

    const [rows, total, counts] = await Promise.all([
      Support.find(filter).sort({ createdAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      Support.countDocuments(filter),
      Support.aggregate([{ $group: { _id: "$status", n: { $sum: 1 } } }]),
    ]);

    res.status(200).json({
      message: "Support tickets",
      data: rows,
      meta: {
        ...meta(total, limit, page),
        byStatus: counts.reduce((a, c) => ({ ...a, [c._id || "unset"]: c.n }), {}),
        statuses: SUPPORT_STATUSES,
      },
      statusCode: 200,
    });
  } catch (error) {
    console.error("listSupportTickets error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

const updateSupportTicket = async (req, res) => {
  try {
    const { status } = req.body;
    if (!SUPPORT_STATUSES.includes(status)) {
      return res
        .status(400)
        .json({ message: `status must be one of: ${SUPPORT_STATUSES.join(", ")}`, statusCode: 400 });
    }

    const updated = await Support.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true }
    );
    if (!updated) return res.status(404).json({ message: "Ticket not found", statusCode: 404 });

    res.status(200).json({ message: "Ticket updated", data: updated, statusCode: 200 });
  } catch (error) {
    if (error.name === "CastError") {
      return res.status(404).json({ message: "Ticket not found", statusCode: 404 });
    }
    console.error("updateSupportTicket error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/* ------------------------------ Customers ------------------------------ */

const listCustomers = async (req, res) => {
  try {
    const { limit, page, skip } = paging(req.query);
    const filter = {};

    if (req.query.search) {
      const rx = safeRegex(req.query.search);
      filter.$or = [{ name: rx }, { email: rx }, { phone: rx }];
    }
    if (req.query.verified === "true") filter.isVerified = true;
    if (req.query.verified === "false") filter.isVerified = { $ne: true };
    if (req.query.city) filter.city = safeRegex(req.query.city);

    const [rows, total] = await Promise.all([
      // Never send password/otp/token to the browser.
      User.find(filter)
        .select("name email phone city gender isVerified registrationId createdBy profilePicture")
        .sort({ createdBy: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      User.countDocuments(filter),
    ]);

    // Booking totals for just this page of customers, not all 16k.
    const ids = rows.map((u) => u._id);
    const spend = await Order.aggregate([
      { $match: { user_id: { $in: ids }, status: "completed" } },
      { $group: { _id: "$user_id", orders: { $sum: 1 }, spent: { $sum: { $ifNull: ["$grand_total", 0] } } } },
    ]);
    const byUser = new Map(spend.map((s) => [String(s._id), s]));

    res.status(200).json({
      message: "Customers",
      data: rows.map((u) => ({
        ...u,
        orders: byUser.get(String(u._id))?.orders ?? 0,
        totalSpent: byUser.get(String(u._id))?.spent ?? 0,
      })),
      meta: meta(total, limit, page),
      statusCode: 200,
    });
  } catch (error) {
    console.error("listCustomers error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/* ------------------------------ Bookings ------------------------------ */

const listBookings = async (req, res) => {
  try {
    const { limit, page, skip } = paging(req.query);
    const filter = {};

    if (req.query.status && req.query.status !== "all") filter.status = req.query.status;
    if (req.query.applicationStatus && req.query.applicationStatus !== "all") {
      filter.applicationStatus = req.query.applicationStatus;
    }
    if (req.query.eventId) filter.event_id = req.query.eventId;
    if (req.query.from || req.query.to) {
      filter.createdBy = {};
      if (req.query.from) filter.createdBy.$gte = new Date(req.query.from);
      if (req.query.to) {
        const to = new Date(req.query.to);
        to.setHours(23, 59, 59, 999);
        filter.createdBy.$lte = to;
      }
    }
    if (req.query.search) filter.order_id = safeRegex(req.query.search);

    const [rows, total] = await Promise.all([
      Order.find(filter)
        .populate("user_id", "name email phone")
        .populate("event_id", "name city date venue_name")
        .sort({ createdBy: -1, _id: -1 })
        .skip(skip)
        .limit(limit)
        .lean(),
      Order.countDocuments(filter),
    ]);

    res.status(200).json({
      message: "Bookings",
      data: rows.map((o) => ({
        _id: o._id,
        orderId: o.order_id ?? null,
        status: o.status,
        grandTotal: o.grand_total ?? 0,
        tickets: o.tickets ?? [],
        checkedIn: Boolean(o.checkedIn),
        rating: o.rating ?? null,
        ratingComment: o.ratingComment ?? null,
        applicationStatus: o.applicationStatus ?? "waitlist",
        rejectionReason: o.rejectionReason ?? null,
        refund: o.refund?.id ? { status: o.refund.status, amount: o.refund.amount } : null,
        createdAt: o.createdBy ?? null,
        paymentId: o.payment_id ?? null,
        customer: o.user_id
          ? { name: o.user_id.name, email: o.user_id.email, phone: o.user_id.phone }
          : (o.attendee_details ?? null),
        event: o.event_id
          ? {
              _id: o.event_id._id,
              name: o.event_id.name,
              city: o.event_id.city,
              date: o.event_id.date,
              venue: o.event_id.venue_name,
            }
          : null,
      })),
      meta: meta(total, limit, page),
      statusCode: 200,
    });
  } catch (error) {
    console.error("listBookings error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

module.exports = {
  listCities,
  createCity,
  updateCity,
  deleteCity,
  listStories,
  setStoryStatus,
  deleteStory,
  listReviews,
  deleteReview,
  listSupportTickets,
  updateSupportTicket,
  listCustomers,
  listBookings,
  SUPPORT_STATUSES,
};
