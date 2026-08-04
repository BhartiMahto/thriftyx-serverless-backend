const mongoose = require("mongoose");
const Schema = mongoose.Schema;

/**
 * One row per person who tapped "I'm Interested" on a "Coming soon" (interest-
 * stage) event. When the event is opened for booking, everyone here is notified.
 *
 * The unique (event_id, user_id) index makes marking interest idempotent — a
 * user counts once no matter how many times they tap.
 */
const EventInterest = new Schema(
  {
    event_id: { type: Schema.Types.ObjectId, ref: "events", required: true, index: true },
    user_id: { type: Schema.Types.ObjectId, ref: "users", required: true, index: true },
    // Set true once the "now open for booking" notification has been sent, so a
    // re-run of go-live never double-notifies.
    notified: { type: Boolean, default: false },
  },
  { timestamps: true }
);

EventInterest.index({ event_id: 1, user_id: 1 }, { unique: true });

module.exports = mongoose.model("eventInterest", EventInterest);
