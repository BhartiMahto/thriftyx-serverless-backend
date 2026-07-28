const mongoose = require("mongoose");
const Schema = mongoose.Schema;

/**
 * Golden Pass membership — a yearly pass bundling a fixed number of event
 * credits (default 30), usable in any city. Each booking made by an active
 * member spends one credit and auto-confirms (skipping the waitlist).
 *
 * `status` + `expiresAt` + remaining credits together decide whether the pass
 * is currently usable; see `isUsable()` below.
 */
const Membership = new Schema({
  user_id: { type: Schema.Types.ObjectId, ref: "users", required: true },

  tier: { type: String, enum: ["golden"], default: "golden" },
  // Human-facing member id, e.g. TX-GOLD-0007.
  memberId: { type: String, unique: true, sparse: true },

  eventsTotal: { type: Number, default: 30 },
  eventsUsed: { type: Number, default: 0 },

  status: {
    type: String,
    enum: ["pending", "active", "expired", "cancelled"],
    default: "pending",
  },

  price: { type: Number, default: 0 },
  // Snapshot of the holder's city at issue (shown on the card).
  city: { type: String, default: null },

  startsAt: { type: Date, default: null },
  expiresAt: { type: Date, default: null },

  payment_id: { type: String, default: null },
  passUrl: { type: String, default: null }, // S3 PDF

  cancelledAt: { type: Date, default: null },
  createdBy: { type: Date, default: Date.now },
  updatedBy: { type: Date, default: Date.now },
});

/** Credits still available on the pass. */
Membership.virtual("eventsRemaining").get(function () {
  return Math.max(0, (this.eventsTotal || 0) - (this.eventsUsed || 0));
});

/** True when the pass is active, unexpired and has credits left. */
Membership.methods.isUsable = function () {
  return (
    this.status === "active" &&
    (!this.expiresAt || this.expiresAt.getTime() > Date.now()) &&
    this.eventsUsed < this.eventsTotal
  );
};

Membership.set("toJSON", { virtuals: true });
Membership.set("toObject", { virtuals: true });

module.exports = mongoose.model("membership", Membership);
