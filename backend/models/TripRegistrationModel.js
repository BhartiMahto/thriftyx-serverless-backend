const mongoose = require("mongoose");
const Schema = mongoose.Schema;

/**
 * A guest's REQUEST to join a Trip. No login and no payment at request time —
 * the team reviews each request. Flow:
 *   requested → (admin) accepted + amount set → guest pays via pay-link → paid
 *             → (admin) rejected  [dead end]
 * The `payToken` backs a login-free payment page (/trip-pay/:token) so an
 * accepted guest can pay without an account.
 */
const TripRegistration = new Schema({
  trip_id: { type: Schema.Types.ObjectId, ref: "trip", required: true },

  // Contact details captured on the request form.
  name: { type: String, default: null },
  email: { type: String, default: null },
  phone: { type: String, default: null },
  city: { type: String, default: null },
  pronouns: { type: String, default: null },
  message: { type: String, default: null },

  status: {
    type: String,
    enum: ["requested", "accepted", "rejected", "paid", "cancelled"],
    default: "requested",
  },

  // Set by the admin when accepting — the amount the guest then pays online.
  amount: { type: Number, default: 0 },
  // Free-text note from the admin (visible to the team only).
  adminNote: { type: String, default: null },

  // Login-free payment: a random token backs the guest's pay page.
  payToken: { type: String, default: null, index: true },
  paymentOrderId: { type: String, default: null },
  paymentId: { type: String, default: null },
  paidAt: { type: Date, default: null },

  createdBy: { type: Date, default: Date.now },
  updatedBy: { type: Date, default: Date.now },
});

module.exports = mongoose.model("tripRegistration", TripRegistration);
