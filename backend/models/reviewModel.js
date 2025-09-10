const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const Review = new Schema({
    eventId: {
        type: Schema.Types.ObjectId,
        ref: 'Event',
        required: true,
    },
    name: {
        type: String,
        unique: false,
        required: false
    },
    image: {
        type: String,
        unique: false,
        required: false
    },
    location: {
        type: String,
        unique: false,
        required: false
    },
    description: {
        type: String,
        unique: false,
        required: false
    },
    date: {
        type: Date,
        unique: false,
        required: false
    },
    rating: {
        type: Number,
        unique: false,
        required: false
    },
    comments: {
        type: Array,
        unique: false,
        required: false
    },
    createdBy:{
        type:Date,
        unique:false,
        required:false
    },
});

module.exports = mongoose.model("review", Review);