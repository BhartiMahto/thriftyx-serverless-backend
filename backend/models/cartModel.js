const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const Cart = new Schema({
    event_id: {
        type: Schema.Types.ObjectId,
        unique: false,
        default: false,
        required: true
    },
    tickets: {
        type: Array,
        unique: false,
        default: [],
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
    user_id:{
        type: Schema.Types.ObjectId,
        unique: false,
        default: null,
        required: false
    },
    isTnC_accepted: {
        type: Boolean,
        unique: false,
        default: false,
        required: false
    },
    createdBy:{
        type: Date,
        unique: false,
        required: false,
        default: new Date(),
    }
});

module.exports = mongoose.model('cart', Cart);