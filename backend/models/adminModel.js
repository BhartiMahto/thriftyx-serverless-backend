const mongoose = require("mongoose");

const adminSchema = new mongoose.Schema({
  fullName: { type: String, required: true },
  email: { type: String, unique: true, required: true },
  password: { type: String, required: true },
  role: { type: String, enum: ["SUPER_ADMIN", "SUB_ADMIN"], default: "SUB_ADMIN" },
  // Lets a sub-admin be disabled without deleting the record (and its audit trail).
  status: { type: String, enum: ["active", "suspended"], default: "active" },
  lastLoginAt: { type: Date, default: null },
  permissions: [
    {
      module: { type: String },       
      access: { type: String, enum: ["NONE", "VIEW", "EDIT"], default: "NONE" }
    }
  ]
}, { timestamps: true });

module.exports = mongoose.model("Admin", adminSchema);
