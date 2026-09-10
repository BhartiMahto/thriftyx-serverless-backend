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
            // Optional per-city schedule override. When set, THIS city's booking
            // runs on its own date/time (e.g. one city postponed, or a different
            // start time); when blank it inherits the top-level date/start_time/
            // end_time. Keeps single-city + legacy events unchanged.
            date: { type: Date, default: null },
            start_time: { type: String, default: "" },
            end_time: { type: String, default: "" },
            // Per-city tickets — each city has its OWN inventory + prices, so
            // selling out in one city never affects another. Falls back to the
            // top-level `tickets` array when a city has none (legacy events).
            tickets: {
                type: [{
                    name: { type: String, default: "" },
                    price: { type: Number, default: 0 },
                    quantity: { type: Number, default: 0 },
                    description: { type: String, default: "" },
                    // Show/hide on the customer site WITHOUT deleting (which would
                    // drop existing bookings). Sell Early Bird first, flip Regular
                    // live later. false = hidden/not bookable; stays in the DB.
                    active: { type: Boolean, default: true },
                }],
                default: [],
            },
        }],
        default: [],
    },
    image: {
        type: String,
        unique: false,
        default: null,
        required: false
    },
    // Square (1:1) poster for the events LIST card. Falls back to `image` (the
    // wide/horizontal poster used on the detail hero) when not set.
    cardImage: {
        type: String,
        default: null,
    },
    // Optional explainer video — a YouTube/Vimeo link (only the URL is stored;
    // the video is hosted + streamed by YouTube/Vimeo, so no server cost).
    videoUrl: {
        type: String,
        default: null,
    },
    // Admin on/off switch for the video — lets an admin hide the video without
    // deleting the link. Defaults on, so setting a link shows it right away.
    videoEnabled: {
        type: Boolean,
        default: true,
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
    // Event schedule / agenda shown on the customer "Agenda" tab.
    schedule: {
        type: [{
            time: { type: String, default: "" },
            activity: { type: String, default: "" },
        }],
        default: [],
    },
    description: {
        type: String,
        unique: false,
        default: null,
        required: false
    },
    // Short one/two-line summary shown on the events LIST card. Kept small so it
    // can be returned by the list query (the full `description` is excluded there).
    shortDescription: {
        type: String,
        default: "",
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
    // Admin-defined, per-event checkout questions. Different event types (Digital
    // Detox, Single Parent, Founders Connect, Dinner with Strangers…) ask
    // different things, so each event carries its own list. Every attendee
    // answers these at checkout, in addition to the standard fields. The captured
    // answers are stored per-attendee on the Order with the label denormalised,
    // so a past order keeps the exact question that was asked even if it is later
    // edited or removed here.
    checkoutQuestions: [{
        key: { type: String },                    // stable id within the event
        label: { type: String },                  // the question shown to the attendee
        type: { type: String, default: "text" },  // text | paragraph | select | boolean | multiselect | video
        options: [{ type: String }],              // choices for select / multiselect
        required: { type: Boolean, default: false },
    }],
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
    // Invite-only: the event is hidden from the public listing and is NOT
    // directly bookable. People apply via a shareable form link (/apply/:id);
    // an admin approves, then the applicant pays the chosen ticket price.
    inviteOnly: {
        type: Boolean,
        default: false,
    },
    // Admin-forced "Sold out": shows a Sold-out badge on the card + detail and
    // blocks booking, regardless of remaining ticket inventory.
    soldOut: {
        type: Boolean,
        default: false,
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