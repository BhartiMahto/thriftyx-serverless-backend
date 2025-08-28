const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const Founder = new Schema({
    name: {
        type: String,
        unique: false,
        required: false,
    },
    image: {
        type: String,
        unique: false,
        required: false,
    },
    description: {
        type: String,
        unique: false,
        required: false,
    },
    designation: {
        type: String,
        unique: false,
        required: false,
    },
    createdBy:{
        type:Date,
        unique:false,
        required:false
    },
});

module.exports = mongoose.model("founder", Founder);