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
        enum: ['pending', 'in_progress', 'completed', 'failed'],
        default: 'in_progress'
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