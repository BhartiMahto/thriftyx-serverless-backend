const mongoose = require("mongoose");

const messageHistorySchema = new mongoose.Schema({
  type: { type: String, enum: ["whatsapp", "sms", "email"], required: true },
  recipients: [String],
  subject: { type: String },
  message: { type: String, required: true },
  status: { type: String, enum: ["success", "failed"], default: "success" },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("MessageHistory", messageHistorySchema);
