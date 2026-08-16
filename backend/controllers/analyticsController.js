const mongoose = require("mongoose");
const Order = require("../models/orderModel");
const User = require("../models/userModel");

/**
 * Financial analytics for the dashboard.
 *
 * All figures come from the orders collection. Only `completed` orders count as
 * revenue — `in_progress` and `pending` are baskets that were never paid for,
 * and counting them would overstate income.
 *
 * NOTE: `createdBy` is a Date field (misnamed; it is a timestamp, not a user).
 */

const PAID = "completed";

/** Parses ?from / ?to, defaulting to the last 12 months. */
const parseRange = (query) => {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from
    ? new Date(query.from)
    : new Date(new Date(to).setMonth(to.getMonth() - 11));

  from.setHours(0, 0, 0, 0);
  to.setHours(23, 59, 59, 999);

  const valid = !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && from <= to;
  return { from, to, valid };
};

const dateMatch = (from, to) => ({ createdBy: { $gte: from, $lte: to } });

// A successfully-refunded order (refund.id set) is no longer revenue, even when
// its status stayed "completed" — e.g. an external/gateway refund. (Our own
// admin refunds also flip status to "cancelled", so they're excluded regardless.)
const NOT_REFUNDED = { "refund.id": null };
const paidMatch = (from, to) => ({ ...dateMatch(from, to), status: PAID, ...NOT_REFUNDED });

/** GET /api/admin/analytics/summary */
const getSummary = async (req, res) => {
  try {
    const { from, to, valid } = parseRange(req.query);
    if (!valid) return res.status(400).json({ message: "Invalid date range", statusCode: 400 });

    const [byStatus] = await Promise.all([
      Order.aggregate([
        { $match: dateMatch(from, to) },
        {
          $group: {
            _id: "$status",
            count: { $sum: 1 },
            revenue: { $sum: { $ifNull: ["$grand_total", 0] } },
          },
        },
      ]),
    ]);

    const statuses = byStatus.reduce((acc, s) => {
      acc[s._id || "unknown"] = { count: s.count, revenue: s.revenue };
      return acc;
    }, {});

    const totalOrders = byStatus.reduce((n, s) => n + s.count, 0);

    // Paid revenue/count exclude refunded orders (see NOT_REFUNDED) — the raw
    // byStatus breakdown above still shows every status untouched.
    const [paidAgg] = await Order.aggregate([
      { $match: paidMatch(from, to) },
      { $group: { _id: null, count: { $sum: 1 }, revenue: { $sum: { $ifNull: ["$grand_total", 0] } } } },
    ]);
    const paid = { count: paidAgg?.count || 0, revenue: paidAgg?.revenue || 0 };

    const [uniqueCustomers] = await Order.aggregate([
      { $match: paidMatch(from, to) },
      { $group: { _id: "$user_id" } },
      { $count: "n" },
    ]);

    // Fees are tracked separately from ticket value on each order.
    const [fees] = await Order.aggregate([
      { $match: paidMatch(from, to) },
      {
        $group: {
          _id: null,
          bookingFees: { $sum: { $ifNull: ["$booking_fee", 0] } },
          gst: { $sum: { $ifNull: ["$gst", 0] } },
          ticketValue: { $sum: { $ifNull: ["$total_price", 0] } },
        },
      },
    ]);

    res.status(200).json({
      message: "Summary",
      data: {
        range: { from, to },
        revenue: paid.revenue,
        paidOrders: paid.count,
        totalOrders,
        averageOrderValue: paid.count ? Math.round((paid.revenue / paid.count) * 100) / 100 : 0,
        uniqueCustomers: uniqueCustomers?.n ?? 0,
        // Share of created orders that were actually paid for.
        conversionRate: totalOrders
          ? Math.round((paid.count / totalOrders) * 1000) / 10
          : 0,
        ticketValue: fees?.ticketValue ?? 0,
        bookingFees: fees?.bookingFees ?? 0,
        gst: fees?.gst ?? 0,
        byStatus: statuses,
      },
      statusCode: 200,
    });
  } catch (error) {
    console.error("getSummary error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** GET /api/admin/analytics/revenue-timeseries?interval=month|day */
const getRevenueTimeseries = async (req, res) => {
  try {
    const { from, to, valid } = parseRange(req.query);
    if (!valid) return res.status(400).json({ message: "Invalid date range", statusCode: 400 });

    const interval = req.query.interval === "day" ? "day" : "month";
    const format = interval === "day" ? "%Y-%m-%d" : "%Y-%m";

    // Paid = completed AND not refunded (refund.id null).
    const isPaid = {
      $and: [{ $eq: ["$status", PAID] }, { $eq: [{ $ifNull: ["$refund.id", null] }, null] }],
    };
    const rows = await Order.aggregate([
      { $match: dateMatch(from, to) },
      {
        $group: {
          _id: { $dateToString: { format, date: "$createdBy" } },
          revenue: { $sum: { $cond: [isPaid, { $ifNull: ["$grand_total", 0] }, 0] } },
          paidOrders: { $sum: { $cond: [isPaid, 1, 0] } },
          totalOrders: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]);

    res.status(200).json({
      message: "Revenue timeseries",
      data: rows.map((r) => ({
        period: r._id,
        revenue: r.revenue,
        paidOrders: r.paidOrders,
        totalOrders: r.totalOrders,
      })),
      interval,
      statusCode: 200,
    });
  } catch (error) {
    console.error("getRevenueTimeseries error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** GET /api/admin/analytics/by-city */
const getRevenueByCity = async (req, res) => {
  try {
    const { from, to, valid } = parseRange(req.query);
    if (!valid) return res.status(400).json({ message: "Invalid date range", statusCode: 400 });

    const rows = await Order.aggregate([
      { $match: paidMatch(from, to) },
      { $lookup: { from: "events", localField: "event_id", foreignField: "_id", as: "event" } },
      { $unwind: { path: "$event", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: { $ifNull: ["$event.city", "Unknown"] },
          revenue: { $sum: { $ifNull: ["$grand_total", 0] } },
          orders: { $sum: 1 },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 25 },
    ]);

    res.status(200).json({
      message: "Revenue by city",
      data: rows.map((r) => ({ city: r._id, revenue: r.revenue, orders: r.orders })),
      statusCode: 200,
    });
  } catch (error) {
    console.error("getRevenueByCity error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** GET /api/admin/analytics/top-events?limit=10 */
const getTopEvents = async (req, res) => {
  try {
    const { from, to, valid } = parseRange(req.query);
    if (!valid) return res.status(400).json({ message: "Invalid date range", statusCode: 400 });

    const limit = Math.min(Number(req.query.limit) || 10, 50);

    const rows = await Order.aggregate([
      { $match: paidMatch(from, to) },
      {
        $group: {
          _id: "$event_id",
          revenue: { $sum: { $ifNull: ["$grand_total", 0] } },
          orders: { $sum: 1 },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: limit },
      { $lookup: { from: "events", localField: "_id", foreignField: "_id", as: "event" } },
      { $unwind: { path: "$event", preserveNullAndEmptyArrays: true } },
    ]);

    res.status(200).json({
      message: "Top events",
      data: rows.map((r) => ({
        eventId: r._id,
        name: r.event?.name ?? "Deleted event",
        city: r.event?.city ?? null,
        type: r.event?.type ?? null,
        date: r.event?.date ?? null,
        revenue: r.revenue,
        orders: r.orders,
      })),
      statusCode: 200,
    });
  } catch (error) {
    console.error("getTopEvents error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** GET /api/admin/analytics/ticket-mix — revenue split by ticket name. */
const getTicketMix = async (req, res) => {
  try {
    const { from, to, valid } = parseRange(req.query);
    if (!valid) return res.status(400).json({ message: "Invalid date range", statusCode: 400 });

    /*
     * Order line items are NOT shaped like event ticket definitions:
     *   legacy orders  -> { name, count, total }   total = line amount, a STRING
     *   orders from the new checkout -> { name, count, price }  price = unit price
     * So revenue prefers `total`, falling back to price × count.
     *
     * Names also arrive with stray whitespace and mixed casing
     * ("Regular Ticket " vs "REGULAR TICKET"), which would otherwise split one
     * ticket type across several rows — hence grouping on a trimmed uppercase key.
     */
    const num = (expr) => ({ $convert: { input: expr, to: "double", onError: 0, onNull: 0 } });
    const count = { $convert: { input: "$tickets.count", to: "int", onError: 0, onNull: 0 } };

    const rows = await Order.aggregate([
      { $match: paidMatch(from, to) },
      { $unwind: { path: "$tickets", preserveNullAndEmptyArrays: false } },
      {
        $addFields: {
          _name: { $trim: { input: { $ifNull: ["$tickets.name", "Unnamed"] } } },
          _line: {
            $cond: [
              { $ifNull: ["$tickets.total", false] },
              num("$tickets.total"),
              { $multiply: [num("$tickets.price"), count] },
            ],
          },
        },
      },
      {
        $group: {
          _id: { $toUpper: "$_name" },
          label: { $first: "$_name" },
          quantity: { $sum: count },
          revenue: { $sum: "$_line" },
        },
      },
      { $sort: { revenue: -1 } },
      { $limit: 20 },
    ]);

    res.status(200).json({
      message: "Ticket mix",
      data: rows.map((r) => ({
        ticketType: r.label || r._id,
        quantity: r.quantity,
        revenue: Math.round(r.revenue * 100) / 100,
      })),
      statusCode: 200,
    });
  } catch (error) {
    console.error("getTicketMix error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

module.exports = {
  getSummary,
  getRevenueTimeseries,
  getRevenueByCity,
  getTopEvents,
  getTicketMix,
};
