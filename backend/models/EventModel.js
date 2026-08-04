const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const Event = new Schema({
    name: {
        type: String,
        unique: false,
        default: null,
        required: false
    },
    type: {
        type: String,
        unique: false,
        default: null,
        required: false
    },
    city: {
        type: String,
        unique: false,
        default: null,
        required: false
    },
    venue_name: {
        type: String,
        unique: false,
        required: false
    },
    venue: {
        type: String,
        unique: false,
        default: null,
        required: false
    },
    // Multiple cities/venues for one event. Each entry is a city + its venue.
    // The top-level city/venue/venue_name mirror locations[0] for compatibility
    // with the list view and older records.
    locations: {
        type: [{
            city: { type: String, default: "" },
            venue: { type: String, default: "" },
            address: { type: String, default: "" },
            lat: { type: String, default: "" },
            lng: { type: String, default: "" },
        }],
        default: [],
    },
    image: {
        type: String,
        unique: false,
        default: null,
        required: false
    },
    date: {
        type: Date,
        unique: false,
        default: null,
        required: false
    },
    start_time: {
        type: String,
        unique: false,
        default: null,
        required: false
    },
    end_time: {
        type: String,
        unique: false,
        default: null,
        required: false
    },
    tickets: {
        type: Array,
        unique: false,
        default: [],
        required: false
    },
    description: {
        type: String,
        unique: false,
        default: null,
        required: false
    },
    instruction: {
        type: String,
        unique: false,
        default: null,
        required: false
    },
    min_age: {
        type: Number,
        unique: false,
        default: 0,
        required: false
    },
    max_age: {
        type: Number,
        unique: false,
        default: 0,
        required: false
    },
    cordinates: {
        type: Object,
        unique: false,
        default: {},
        required: false
    },
    status: {
        type: String,
        unique: false,
        default: "Unpublished",
        required: false
    },
    // Booking stage (independent of publish `status`):
    //   "open"     → normal, bookable event (default).
    //   "interest" → "Coming soon" card: shown publicly but NOT bookable. People
    //                register interest and are notified when it opens for booking.
    // A Published + "interest" event is a live coming-soon listing.
    stage: {
        type: String,
        enum: ["open", "interest"],
        default: "open",
        required: false,
    },
    // Guard so interested users are notified exactly once, when the event is
    // first opened for booking (interest -> open).
    notifiedInterested: {
        type: Boolean,
        default: false,
        required: false,
    },
    createdBy:{
        type: Date,
        unique: false,
        required: false,
        default: new Date(),
    }
});

module.exports = mongoose.model("events", Event);