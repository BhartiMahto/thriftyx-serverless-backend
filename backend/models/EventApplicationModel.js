const mongoose = require("mongoose");
const Schema = mongoose.Schema;

/**
 * An application to join an INVITE-ONLY event. No login and no payment at apply
 * time — the team reviews each one. Flow:
 *   pending → (admin) approved → applicant pays via login-free link → paid
 *           → (admin) rejected  [dead end]
 * On payment a real confirmed Order is created (so the person shows in the event
 * attendee list, gets a ticket, and counts in revenue). `payToken` backs the
 * login-free pay page (/apply-pay/:token).
 */
const answerSchema = new Schema(
  { key: { type: String, default: null }, label: { type: String, default: null }, value: { type: Schema.Types.Mixed, default: null } },
  { _id: false }
);

const eventApplicationSchema = new Schema({
  event_id: { type: Schema.Types.ObjectId, ref: "events", required: true },

  // Applicant details captured on the public form.
  name: { type: String, default: null },
  email: { type: String, default: null },
  phone: { type: String, default: null },
  gender: { type: String, default: null },
  DOB: { type: String, default: null },
  age: { type: Number, default: null },
  city: { type: String, default: null },            // the city/occurrence they applied for
  maritalStatus: { type: String, default: null },
  reasonToJoin: { type: String, default: null },
  answers: { type: [answerSchema], default: [] },    // per-event custom questions

  // The ticket they chose → the amount they pay once approved.
  ticketName: { type: String, default: null },
  amount: { type: Number, default: 0 },

  status: {
    type: String,
    enum: ["pending", "approved", "rejected", "paid"],
    default: "pending",
  },
  adminNote: { type: String, default: null },

  // Login-free payment.
  payToken: { type: String, default: null, index: true },
  paymentOrderId: { type: String, default: null },
  paymentId: { type: String, default: null },
  paidAt: { type: Date, default: null },
  // The confirmed Order created once payment succeeds.
  order_id: { type: Schema.Types.ObjectId, ref: "order", default: null },

  createdBy: { type: Date, default: Date.now },
  updatedBy: { type: Date, default: Date.now },
});

module.exports = mongoose.models.eventApplication || mongoose.model("eventApplication", eventApplicationSchema);
