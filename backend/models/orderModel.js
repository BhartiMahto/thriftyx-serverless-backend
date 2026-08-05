const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const Order = new Schema({
    user_id:{
        type: Schema.Types.ObjectId,
        unique: false,
        ref: "users"
    },
    event_id: {
        type: Schema.Types.ObjectId,
        unique: false,
        ref: "events"
    },
    isTnC_accepted: {
        type: Boolean,
        unique: false,
        default: false,
        required: false
    },
    total_price: {
        type: Number,
        unique: false,
        default: 0,
        required: false
    },
    booking_fee: {
        type: Number,
        unique: false,
        default: 0,
        required: false
    },
    gst: {
        type: Number,
        unique: false,
        default: 0,
        required: false
    },
    coupon_code: {
        type: String,
        unique: false,
        default: null,
        required: false
    },
    discount: {
        type: Number,
        unique: false,
        default: 0,
        required: false
    },
    grand_total: {
        type: Number,
        unique: false,
        default: 0,
        required: false
    },
    tickets: {
        type: Array,
        unique: false,
        default: [],
        required: false
    },
    order_id: {
        type: String,
        unique: false,
        required: false
    },
    invoice_and_tickets: {
        type: String,
        unique: false,
        required: false,
        default: ''
    },
    // --- Generated documents (PDF URLs in S3) ---
    ticket_url: {
        type: String,
        default: null,
        required: false
    },
    invoice_url: {
        type: String,
        default: null,
        required: false
    },
    // Sequential, gap-free tax-invoice number (allocated once, at payment).
    invoice_no: {
        type: String,
        default: null,
        required: false
    },
    invoiced_at: {
        type: Date,
        default: null,
        required: false
    },
    // --- Golden Pass ---
    // Set when the booking was covered by a membership credit (free entry).
    membership_id: {
        type: Schema.Types.ObjectId,
        ref: "membership",
        default: null,
        required: false
    },
    paidByPass: {
        type: Boolean,
        default: false,
        required: false
    },
    // invoice: {
    //     type: String,
    //     unique: false,
    //     required: false,
    //     default: ''
    // },
    // tickets_url: {
    //     type: Array,
    //     unique: false,
    //     required: false,
    //     default: []
    // },
    receipt_no: {
        type: String,
        unique: false,
    },
    payment_id: {
        type: String,
        unique: false,
    },
    status: {
        type: String,
        // 'cancelled' added so a customer-cancelled booking is distinguishable
        // from a payment failure.
        enum: ['pending', 'in_progress', 'completed', 'failed', 'cancelled'],
        default: 'in_progress'
    },
    cancelledAt: {
        type: Date,
        unique: false,
        default: null,
        required: false
    },
    // --- Application review (separate from payment `status`) ---
    // Paying puts the attendee on the WAITLIST; an admin then confirms or
    // rejects. `status` tracks money; `applicationStatus` tracks curation.
    applicationStatus: {
        type: String,
        enum: ['waitlist', 'confirmed', 'rejected'],
        default: 'waitlist'
    },
    reviewedAt: { type: Date, default: null },
    rejectionReason: { type: String, default: null },
    // --- Refund (populated when a rejected application is refunded) ---
    refund: {
        id: { type: String, default: null },
        status: { type: String, default: null },   // e.g. processed / pending / failed
        amount: { type: Number, default: null },
        // Bank reference (RRN/UTR/ARN) from Razorpay — what the customer quotes
        // to their bank to trace the refund. Populated when the gateway returns it.
        rrn: { type: String, default: null },
        // Gateway error description when a refund attempt failed (for diagnosis
        // + so the admin can retry it knowing why).
        error: { type: String, default: null },
        at: { type: Date, default: null },
    },
    // Details of the person actually attending, captured at checkout.
    // Held on the order (not just the user) because they are point-in-time
    // facts — age in particular — and the admin attendee table displays them.
    // The city/venue the attendee chose at booking (for multi-city events).
    // Used to filter "Who's coming" by city.
    event_city: {
        type: String,
        default: null,
        required: false
    },
    // True when a Golden Pass covered ONE seat of a paid group booking (the
    // holder's). paidByPass (below) stays false because money was still taken
    // for the friends' seats.
    passSeat: {
        type: Boolean,
        default: false,
        required: false
    },
    // The booker/primary attendee (also the invoice "bill to"). Mirrors attendees[0].
    attendee_details: {
        name: { type: String, default: null },
        email: { type: String, default: null },
        phone: { type: String, default: null },
        gender: { type: String, default: null },
        age: { type: Number, default: null },
        // Date of birth as entered at checkout (as per government ID).
        DOB: { type: Date, default: null },
        city: { type: String, default: null },
        maritalStatus: { type: String, default: null },
        // Why the attendee wants to join THIS event — used by hosts to curate the waitlist.
        reasonToJoin: { type: String, default: null },
    },
    // One entry PER TICKET when the booking covers more than one person. Each
    // gets its own QR (a ticket-PDF page) and is checked in individually.
    attendees: [{
        name: { type: String, default: null },
        email: { type: String, default: null },
        phone: { type: String, default: null },
        gender: { type: String, default: null },
        age: { type: Number, default: null },
        DOB: { type: Date, default: null },
        city: { type: String, default: null },
        maritalStatus: { type: String, default: null },
        reasonToJoin: { type: String, default: null },
        checkedIn: { type: Boolean, default: false },
        checkedInAt: { type: Date, default: null },
    }],
    // --- Attendee's rating of the event (given from My Tickets after it's over) ---
    rating: {
        type: Number,
        min: 1,
        max: 5,
        default: null,
        required: false
    },
    ratingComment: {
        type: String,
        default: null,
        required: false
    },
    ratedAt: {
        type: Date,
        default: null,
        required: false
    },
    // --- Check-in (consumed by the admin panel's CheckInView) ---
    checkedIn: {
        type: Boolean,
        unique: false,
        default: false,
        required: false
    },
    checkedInAt: {
        type: Date,
        unique: false,
        default: null,
        required: false
    },
    updatedBy:{
        type: Date,
        unique: false,
        required: false,
        default: new Date(),
    },
    createdBy:{
        type: Date,
        unique: false,
        required: false,
        default: new Date(),
    }
});

module.exports = mongoose.model('order', Order);