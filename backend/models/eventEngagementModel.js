const mongoose = require("mongoose");
const Schema = mongoose.Schema;

/**
 * Lightweight engagement signals on an event:
 *  - "wishlist" — a signed-in user saved the event (toggle on/off). Always has a
 *    user_id (wishlisting requires login so we can attribute it).
 *  - "share"    — someone tapped the Share button (copies the event link). May be
 *    anonymous (user_id null); repeatable, so a person can share more than once.
 *
 * We can't know WHO a link was shared with — only that a user (or guest) chose to
 * share. So "share" is a click signal + count, not a recipient list.
 */
const EventEngagement = new Schema(
  {
    event_id: { type: Schema.Types.ObjectId, ref: "events", required: true, index: true },
    // Null only for an anonymous share; wishlist rows always carry a user.
    user_id: { type: Schema.Types.ObjectId, ref: "users", default: null, index: true },
    type: { type: String, enum: ["wishlist", "share"], required: true, index: true },
    // Where a share came from (future-proofing; only "link" today).
    channel: { type: String, default: null },
  },
  { timestamps: true }
);

// A user wishlists an event at most once (idempotent toggle). Shares are
// repeatable and can be anonymous, so uniqueness applies ONLY to wishlist rows.
EventEngagement.index(
  { event_id: 1, user_id: 1, type: 1 },
  { unique: true, partialFilterExpression: { type: "wishlist" } }
);

module.exports = mongoose.model("eventEngagement", EventEngagement);
