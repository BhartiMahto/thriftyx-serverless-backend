const mongoose = require("mongoose");
const Schema = mongoose.Schema;

/**
 * A hosted group Trip (e.g. "Masai Mara Safari", "Meghalaya with Singles").
 * Distinct from Event: trips have a date RANGE, a day-by-day itinerary, an
 * inclusions/exclusions breakdown and a staged payment schedule. Bookings are
 * REQUEST-based (see TripRegistration) — a guest requests to join, the team
 * reviews, then a payment link is issued once accepted.
 */
const Trip = new Schema({
  name: { type: String, required: true },
  // Short display label for the card badge, e.g. "MASAI MARA".
  destination: { type: String, default: null },
  // Human region line, e.g. "Masai Mara" / "Nairobi • Lake Naivasha • Masai Mara".
  region: { type: String, default: null },
  // Short route/subtitle shown under the title on the card + detail.
  route: { type: String, default: null },
  // International vs domestic (drives the India / International filter tabs).
  isInternational: { type: Boolean, default: false },

  // Fixed departure window.
  start_date: { type: Date, default: null },
  end_date: { type: Date, default: null },
  duration_days: { type: Number, default: 0 },
  duration_nights: { type: Number, default: 0 },

  // Audience.
  age_min: { type: Number, default: 0 },
  age_max: { type: Number, default: 0 },

  // "From ₹X / person" — the starting price shown on the card + detail.
  price_from: { type: Number, default: 0 },

  // Long, rich-text description (THE TRIP section).
  description: { type: String, default: null },

  // Posters: `image` = wide hero, `cardImage` = square list card (falls back to image).
  image: { type: String, default: null },
  cardImage: { type: String, default: null },
  // THE PLACE photo gallery.
  gallery: [{ type: String }],

  // DAY BY DAY itinerary.
  itinerary: [{
    day: { type: Number, default: 0 },       // 1, 2, 3…
    phase: { type: String, default: null },  // "ARRIVAL" | "DAY" | "DEPARTURE"…
    title: { type: String, default: null },
    description: { type: String, default: null },
  }],

  // WHAT'S INCLUDED — AND WHAT'S NOT.
  inclusions: [{ type: String }],
  exclusions: [{ type: String }],

  // PAYMENT SCHEDULE — staged instalments (display only; collected once accepted).
  payment_schedule: [{
    label: { type: String, default: null },    // "Booking amount" | "Final Instalment"
    dueLabel: { type: String, default: null }, // "Due date of booking" | "Due 11th Aug 2026"
    amount: { type: Number, default: 0 },
  }],

  // Trust badges (VERIFIED MEMBERS ONLY, FIXED DEPARTURES, HOSTED END-TO-END…).
  highlights: [{ type: String }],

  // Availability.
  spots_total: { type: Number, default: 0 },
  spots_left: { type: Number, default: 0 },

  // Publish state (mirrors Event: "Published" / "Unpublished").
  status: { type: String, default: "Unpublished" },

  createdBy: { type: Date, default: Date.now },
});

module.exports = mongoose.model("trip", Trip);
