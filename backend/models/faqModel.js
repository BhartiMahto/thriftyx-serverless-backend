const mongoose = require("mongoose");

const FAQ = new mongoose.Schema(
  {
    category: {
      type: String,
      required: [true, "category is mandatory"],
    },
    question: {
      type: String,
      required: [true, "question is required"],
    },
    answer: {
      type: String,
      required: [true, "answer can't be empty"],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("FAQ", FAQ);
