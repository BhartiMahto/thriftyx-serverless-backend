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
    createdBy:{
        type: Date,
        unique: false,
        required: false,
        default: new Date(),
    }
});

module.exports = mongoose.model("events", Event);