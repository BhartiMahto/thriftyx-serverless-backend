const mongoose = require("mongoose");

/**
 * Cities events can be held in.
 *
 * The `event_cities` collection already held 23 documents but had no model
 * file — it was only ever written by the previous codebase's EventCityService.
 * The collection name is pinned so the existing rows are picked up (Mongoose
 * would otherwise pluralise to "eventcities").
 */
const eventCitySchema = new mongoose.Schema(
  {
    country: { type: String, trim: true, default: "India" },
    state: { type: String, trim: true, default: null },
    city: { type: String, trim: true, required: true },
    // Legacy timestamp field — a Date despite the name, matching the rest of
    // this database's convention.
    createdBy: { type: Date, default: Date.now },
  },
  { collection: "event_cities", versionKey: false }
);

eventCitySchema.index({ city: 1 }, { unique: false });

module.exports = mongoose.model("EventCity", eventCitySchema);
