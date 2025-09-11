const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const Partner = new Schema({
    name: {
        type: String,
        unique: false,
        required: false,
    },
    logo: {
        type: String,
        unique: false,
        required: false
    },
    createdBy:{
        type:Date,
        unique:false,
        required:false
    },
});

module.exports = mongoose.model("partner", Partner);