const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const QuestionAnswer = new Schema({
    question: {
        type: String,
        unique: false,
        required: false,
    },
    answer: {
        type: String,
        unique: false,
        required: false
    },
    createdBy: {
        type: Date,
        unique: false,
        required: false
    },
});

module.exports = mongoose.model("question_answer", QuestionAnswer);