const mongoose = require("mongoose");

/** One event inside a set/series (which occurrence + which ticket to book into). */
const seriesItemSchema = new mongoose.Schema(
  {
    event_id: { type: mongoose.Schema.Types.ObjectId, ref: "events", required: true },
    // Which city occurrence + ticket to book the buyer into (events can be multi-city).
    city: { type: String, default: null },
    ticketName: { type: String, default: null },
    // Snapshot of this item's price at the time the set was composed.
    price: { type: Number, default: 0 },
  },
  { _id: false }
);

/**
 * A "set of N events" — a curated bundle sold as ONE purchase. Buying the set
 * confirms the buyer into every event in `items` (one payment -> N bookings).
 */
const seriesSchema = new mongoose.Schema(
  {
    title: { type: String, required: true },
    description: { type: String, default: "" },
    image: { type: String, default: null },
    items: { type: [seriesItemSchema], default: [] },
    // Set price. Defaults to the sum of the item prices (no discount) but can be
    // overridden by the admin.
    price: { type: Number, default: 0 },
    // Published + bookable when true.
    active: { type: Boolean, default: false },
    createdBy: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.models.Series || mongoose.model("Series", seriesSchema);
