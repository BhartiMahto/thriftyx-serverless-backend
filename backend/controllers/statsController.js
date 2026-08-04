const Event = require("../models/EventModel");
const Order = require("../models/orderModel");
const Review = require("../models/reviewModel");

/**
 * GET /api/public/stats — headline numbers for the marketing "About" section.
 *
 * Every figure is derived LIVE from real bookings, so it moves on its own as the
 * platform is used — no manual updates, no hardcoded totals:
 *
 *   • eventsHosted — distinct real events that (a) had at least one SUCCESSFUL
 *                    attendee and (b) have already taken place. Goes up by one
 *                    each time another event is run successfully. Pass "events"
 *                    (Golden/Yearly Pass sold as a ticket) are excluded.
 *   • members      — distinct people holding a successful booking. Goes up with
 *                    every new registration; a refund/cancel/reject drops that
 *                    booking, so if it was the person's only one they fall off.
 *   • cities       — distinct cities those hosted events ran in (single `city`
 *                    field + every multi-venue locations[].city).
 *   • avgRating    — mean attendee rating across orders AND reviews, plus the
 *                    number of ratings it's based on.
 *
 * A "successful" booking = paid (status "completed"), not rejected, and not
 * refunded. Cancelled bookings already carry status "cancelled", and refunded
 * ones carry a refund id, so both are naturally excluded — that's the
 * "subtract on refund" behaviour, computed rather than counted by hand.
 */
const SUCCESSFUL = {
  status: "completed",
  applicationStatus: { $ne: "rejected" },
  "refund.id": null,
};

// Pass products (sold through the normal ticket flow) are not real events.
const NOT_A_PASS = { name: { $not: { $regex: "golden|yearly|pass", $options: "i" } } };

const getPublicStats = async (req, res) => {
  try {
    const now = new Date();

    // Events that actually had a paying attendee — the universe of "real" events.
    const attendedEventIds = await Order.distinct("event_id", SUCCESSFUL);

    const [hostedAgg, members, orderRating, reviewRating] = await Promise.all([
      // Hosted events (already happened, had attendees, not a pass) + the set of
      // distinct cities they ran in — both from one pass over that event set.
      Event.aggregate([
        { $match: { _id: { $in: attendedEventIds }, date: { $lte: now }, ...NOT_A_PASS } },
        {
          $facet: {
            count: [{ $count: "n" }],
            cities: [
              {
                $project: {
                  cities: {
                    $setUnion: [
                      [{ $ifNull: ["$city", ""] }],
                      {
                        $map: {
                          input: { $ifNull: ["$locations", []] },
                          as: "l",
                          in: { $ifNull: ["$$l.city", ""] },
                        },
                      },
                    ],
                  },
                },
              },
              { $unwind: "$cities" },
              { $project: { c: { $toLower: { $trim: { input: "$cities" } } } } },
              { $match: { c: { $ne: "" } } },
              { $group: { _id: "$c" } },
              { $count: "n" },
            ],
          },
        },
      ]),
      // Distinct people with a live successful booking.
      Order.distinct("user_id", SUCCESSFUL).then((ids) => ids.length),
      Order.aggregate([
        { $match: { rating: { $ne: null, $gte: 1 } } },
        { $group: { _id: null, sum: { $sum: "$rating" }, n: { $sum: 1 } } },
      ]),
      Review.aggregate([
        { $match: { rating: { $ne: null, $gte: 1 } } },
        { $group: { _id: null, sum: { $sum: "$rating" }, n: { $sum: 1 } } },
      ]),
    ]);

    const eventsHosted = hostedAgg[0]?.count?.[0]?.n || 0;
    const cities = hostedAgg[0]?.cities?.[0]?.n || 0;

    const ratingSum = (orderRating[0]?.sum || 0) + (reviewRating[0]?.sum || 0);
    const ratingCount = (orderRating[0]?.n || 0) + (reviewRating[0]?.n || 0);
    const avgRating = ratingCount ? Math.round((ratingSum / ratingCount) * 10) / 10 : null;

    res.status(200).json({
      message: "Public stats",
      data: { eventsHosted, members, cities, avgRating, ratingCount },
      statusCode: 200,
    });
  } catch (error) {
    console.error("getPublicStats error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

module.exports = { getPublicStats };
