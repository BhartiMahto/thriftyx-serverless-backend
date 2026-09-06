const mongoose = require("mongoose");

/** The buyer's details, captured once for the whole set. */
const buyerSchema = new mongoose.Schema(
  {
    name: { type: String, default: null },
    email: { type: String, default: null },
    phone: { type: String, default: null },
    gender: { type: String, default: null },
    DOB: { type: String, default: null },
    age: { type: Number, default: null },
    city: { type: String, default: null },
    maritalStatus: { type: String, default: null },
  },
  { _id: false }
);

const itemSnapshotSchema = new mongoose.Schema(
  {
    event_id: { type: mongoose.Schema.Types.ObjectId, ref: "events" },
    city: { type: String, default: null },
    ticketName: { type: String, default: null },
    price: { type: Number, default: 0 },
  },
  { _id: false }
);

/**
 * A single purchase of a set/series. Created `pending` at checkout, flipped to
 * `completed` after payment — at which point one confirmed Order per item is
 * created and linked in `childOrderIds`.
 */
const seriesOrderSchema = new mongoose.Schema(
  {
    series_id: { type: mongoose.Schema.Types.ObjectId, ref: "Series", required: true },
    user_id: { type: mongoose.Schema.Types.ObjectId, ref: "users", required: true },
    buyer: { type: buyerSchema, default: {} },
    items: { type: [itemSnapshotSchema], default: [] },
    amount: { type: Number, default: 0 }, // rupees charged for the set
    status: { type: String, enum: ["pending", "completed", "failed"], default: "pending" },
    paymentOrderId: { type: String, default: null }, // gateway (Razorpay) order id
    payment_id: { type: String, default: null },
    receipt_no: { type: String, default: null },
    childOrderIds: [{ type: mongoose.Schema.Types.ObjectId, ref: "order" }],
    createdBy: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.models.SeriesOrder || mongoose.model("SeriesOrder", seriesOrderSchema);
