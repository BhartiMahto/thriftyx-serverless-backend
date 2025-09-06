const mongoose = require("mongoose");

const SupportSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, "name is mandatory"],
  },
  email: {
    type: String,
    required: [true, "email is required"],
  },
  subject: {
    type: String,
    required: [true, "subject is mandatory"],
    trim: true,
  },
  message: {
    type: String,
    required: [true, "message is required"],
    trim: true,
  },
  status: {
    type: String,
    required: false,
    default: 'open',
  }
});

module.exports = mongoose.model("support", SupportSchema);
