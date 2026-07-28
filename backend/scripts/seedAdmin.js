/**
 * Creates the first SUPER_ADMIN so the admin panel can be logged into.
 * There is no signup route for admins by design.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='...' npm run seed:admin
 */
require("dotenv").config();
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Admin = require("../models/adminModel");

const MODULES = [
  "events",
  "attendees",
  "orders",
  "gallery",
  "users",
  "faq",
  "support",
  "founder",
  "partner",
  "subadmin",
];

(async () => {
  const email = process.env.ADMIN_EMAIL;
  const password = process.env.ADMIN_PASSWORD;
  const fullName = process.env.ADMIN_NAME || "Super Admin";

  if (!email || !password) {
    console.error("ADMIN_EMAIL and ADMIN_PASSWORD are required.");
    console.error("Example: ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='strong-pass' npm run seed:admin");
    process.exit(1);
  }

  try {
    await connectDB();

    const existing = await Admin.findOne({ email });
    if (existing) {
      console.log(`Admin already exists: ${email} (role=${existing.role})`);
      process.exit(0);
    }

    const admin = await Admin.create({
      fullName,
      email,
      password: await bcrypt.hash(password, 10),
      role: "SUPER_ADMIN",
      permissions: MODULES.map((module) => ({ module, access: "EDIT" })),
    });

    console.log(`Created SUPER_ADMIN: ${admin.email}`);
    process.exit(0);
  } catch (err) {
    console.error("Seed failed:", err.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
})();
