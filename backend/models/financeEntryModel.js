const mongoose = require("mongoose");
const Schema = mongoose.Schema;

/**
 * A single manual finance ledger entry — income the platform earned OUTSIDE the
 * website (direct payments, Discord, sponsorships, pre-launch history) or an
 * expense of any kind. Website booking revenue is NOT stored here; it is still
 * computed live from the orders collection and merged into the Financial
 * Insights summary. This ledger is what turns "website revenue" into a full P&L.
 *
 * `date` is the real transaction date (can be well before the platform launched,
 * e.g. pre-March-2025), independent of when the row was created.
 */
const FinanceEntry = new Schema(
  {
    kind: { type: String, enum: ["income", "expense"], required: true, index: true },
    amount: { type: Number, required: true, min: 0 }, // rupees, always positive
    date: { type: Date, required: true, index: true },

    // Freeform so the UI can offer presets AND custom values.
    //  income presets:  Direct payment, Discord, Sponsorship, Historical, Other
    //  expense presets: Venue rent, Marketing/Ads, Team/Salary, Software,
    //                   Food/Catering, Travel/Logistics, Misc
    category: { type: String, default: "Other", trim: true },

    method: { type: String, default: "" }, // cash / upi / bank transfer / card / razorpay / other
    // Provenance: how the row got here.
    source: { type: String, enum: ["manual", "csv-import"], default: "manual" },

    note: { type: String, default: "" },
    reference: { type: String, default: "" }, // invoice no / txn id / anything
    city: { type: String, default: "" },
    event_id: { type: Schema.Types.ObjectId, ref: "events", default: null },

    // --- Bank reconciliation (Phase 2) ---
    reconciled: { type: Boolean, default: false, index: true },
    bankRef: { type: String, default: "" },

    createdByAdmin: { type: Schema.Types.ObjectId, ref: "Admin", default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model("financeEntry", FinanceEntry);
