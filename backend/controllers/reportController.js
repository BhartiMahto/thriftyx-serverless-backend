const Order = require("../models/orderModel");

/**
 * Admin data exports (guest list + sales by city). Both count only real revenue:
 * paid ("completed") orders that were not refunded.
 */

const PAID = "completed";
const NOT_REFUNDED = { "refund.id": null };

/** Optional createdBy date-range filter from ?from=&to= (inclusive). */
const dateRange = (q) => {
  const m = {};
  if (q.from) m.$gte = new Date(q.from);
  if (q.to) {
    const d = new Date(q.to);
    d.setHours(23, 59, 59, 999);
    m.$lte = d;
  }
  return Object.keys(m).length ? { createdBy: m } : {};
};

const isoDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");

/**
 * GET /api/admin/reports/guests
 * One row PER ATTENDEE (a booking of 3 people → 3 rows), with full profile
 * details. Filters: ?event_id=&city=&from=&to=. Paid + non-refunded only.
 */
const guestList = async (req, res) => {
  try {
    const match = { status: PAID, ...NOT_REFUNDED, ...dateRange(req.query) };
    if (req.query.event_id) match.event_id = req.query.event_id;
    if (req.query.city) match.event_city = new RegExp(`^${String(req.query.city).trim()}$`, "i");

    const orders = await Order.find(match)
      .populate("event_id", "name type")
      .select("attendees attendee_details event_id event_city grand_total coupon_code tickets createdBy")
      .sort({ createdBy: -1 })
      .lean();

    const rows = [];
    for (const o of orders) {
      const eventName = o.event_id?.name || "";
      const ticket = (o.tickets || []).map((t) => t.name).filter(Boolean).join(" / ");
      const booker = o.attendee_details || {};
      const list = o.attendees && o.attendees.length ? o.attendees : [booker];
      for (const a of list) {
        rows.push({
          name: a.name || booker.name || "",
          email: a.email || booker.email || "",
          phone: a.phone || booker.phone || "",
          gender: a.gender || "",
          age: a.age ?? "",
          dob: isoDay(a.DOB),
          city: a.city || booker.city || "",
          maritalStatus: a.maritalStatus || "",
          event: eventName,
          eventCity: o.event_city || "",
          ticket,
          amount: o.grand_total || 0,
          coupon: o.coupon_code || "",
          bookedAt: isoDay(o.createdBy),
        });
      }
    }

    res.status(200).json({ message: "Guest list", data: rows, meta: { count: rows.length }, statusCode: 200 });
  } catch (e) {
    console.error("guestList error:", e.message);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * GET /api/admin/reports/sales-by-city
 * Revenue grouped by city (the attendee's chosen city, falling back to the
 * event's city). Filters: ?from=&to=. Paid + non-refunded only.
 */
const salesByCity = async (req, res) => {
  try {
    const match = { status: PAID, ...NOT_REFUNDED, ...dateRange(req.query) };

    const agg = await Order.aggregate([
      { $match: match },
      { $lookup: { from: "events", localField: "event_id", foreignField: "_id", as: "ev" } },
      {
        $addFields: {
          cityKey: {
            $cond: [
              { $gt: [{ $strLenCP: { $ifNull: ["$event_city", ""] } }, 0] },
              "$event_city",
              { $ifNull: [{ $arrayElemAt: ["$ev.city", 0] }, "Unknown"] },
            ],
          },
          attendeeCount: { $max: [{ $size: { $ifNull: ["$attendees", []] } }, 1] },
        },
      },
      {
        $group: {
          _id: "$cityKey",
          bookings: { $sum: 1 },
          guests: { $sum: "$attendeeCount" },
          revenue: { $sum: { $ifNull: ["$grand_total", 0] } },
        },
      },
      { $sort: { revenue: -1 } },
    ]);

    const rows = agg.map((r) => ({
      city: r._id || "Unknown",
      bookings: r.bookings,
      guests: r.guests,
      revenue: r.revenue,
      avgOrder: r.bookings ? Math.round((r.revenue / r.bookings) * 100) / 100 : 0,
    }));
    const totals = rows.reduce(
      (t, r) => ({ bookings: t.bookings + r.bookings, guests: t.guests + r.guests, revenue: t.revenue + r.revenue }),
      { bookings: 0, guests: 0, revenue: 0 }
    );

    res.status(200).json({ message: "Sales by city", data: rows, meta: totals, statusCode: 200 });
  } catch (e) {
    console.error("salesByCity error:", e.message);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

module.exports = { guestList, salesByCity };
