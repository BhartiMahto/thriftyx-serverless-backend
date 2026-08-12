const mongoose = require("mongoose");
const Schema = mongoose.Schema;

/**
 * A marketing "lead" — a snapshot of someone who started the checkout form but
 * has not (yet) completed a booking.
 *
 * The customer site upserts this row (debounced) as a GUEST fills the checkout
 * form, so even a checkout they abandon still leaves us their contact and
 * interests to follow up on. Deduped per (event + contact): one row per person
 * per event, updated in place as they type.
 *
 * `status` flips to "converted" once they actually book, so marketing can
 * exclude buyers from follow-up campaigns.
 */
const Lead = new Schema(
  {
    name: { type: String, default: "" },
    email: { type: String, default: "", lowercase: true, trim: true, index: true },
    phone: { type: String, default: "", trim: true, index: true },
    city: { type: String, default: "" },
    gender: { type: String, default: "" },
    DOB: { type: String, default: "" },
    maritalStatus: { type: String, default: "" },
    reasonToJoin: { type: String, default: "" },

    // What they were trying to book when captured.
    event_id: { type: Schema.Types.ObjectId, ref: "events", index: true },
    event_title: { type: String, default: "" },
    event_city: { type: String, default: "" },
    ticket_name: { type: String, default: "" },
    ticket_price: { type: Number, default: 0 },
    quantity: { type: Number, default: 1 },

    // "abandoned" until they complete a booking, then "converted".
    status: { type: String, enum: ["abandoned", "converted"], default: "abandoned", index: true },
    source: { type: String, default: "checkout" },

    // Whether the person was a guest (not signed in) when captured — leads are
    // for guests, so this is usually true.
    wasGuest: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("lead", Lead);
