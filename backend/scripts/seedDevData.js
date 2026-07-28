/**
 * Seeds a DEV database with fresh sample data so the apps are usable without any
 * production data.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='devpass123' npm run seed:dev
 *
 * SAFETY: refuses to run if the target database name looks like production
 * (contains "prod"). This is intentional — the whole point of switching to dev
 * is to never write here by accident. Override only if you truly mean it:
 *   ALLOW_PROD_SEED=true npm run seed:dev
 */
require("dotenv").config();
const bcrypt = require("bcryptjs");
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const { describeUri } = require("../config/db");

const Admin = require("../models/adminModel");
const User = require("../models/userModel");
const Event = require("../models/EventModel");
const EventCity = require("../models/eventCityModel");
const Coupon = require("../models/couponModel");
const Faq = require("../models/faqModel");
const Review = require("../models/reviewModel");

const day = 86400000;
const daysFromNow = (n) => new Date(Date.now() + n * day);

(async () => {
  const { db, host } = describeUri(process.env.MONGO_URI);

  // --- Prod guard ---
  if (/prod/i.test(db) && process.env.ALLOW_PROD_SEED !== "true") {
    console.error(`\n⛔ Refusing to seed: database "${db}" looks like PRODUCTION.`);
    console.error("   Point MONGO_URI at your dev database first.");
    console.error("   (If you really mean it: ALLOW_PROD_SEED=true npm run seed:dev)\n");
    process.exit(1);
  }

  const email = (process.env.ADMIN_EMAIL || "admin@dev.local").toLowerCase();
  const password = process.env.ADMIN_PASSWORD || "devpass123";

  try {
    await connectDB();
    console.log(`\nSeeding DEV data into "${db}" @ ${host}\n`);

    // 1. Super admin
    if (!(await Admin.findOne({ email }))) {
      const modules = ["events","attendees","orders","gallery","users","faq","support","founder","partner","reviews","blogs","siteContent","finance","revenue","subadmin"];
      await Admin.create({
        fullName: "Dev Admin",
        email,
        password: await bcrypt.hash(password, 10),
        role: "SUPER_ADMIN",
        status: "active",
        permissions: modules.map((m) => ({ module: m, access: "EDIT" })),
      });
      console.log(`  ✓ admin: ${email} / ${password}`);
    } else {
      console.log(`  = admin ${email} already exists`);
    }

    // 2. A verified test customer
    if (!(await User.findOne({ email: "user@dev.local" }))) {
      await User.create({
        name: "Dev User",
        email: "user@dev.local",
        phone: "9000000000",
        city: "Mumbai",
        gender: "male",
        isVerified: true,
        registrationId: "thriftyx_dev001",
        createdBy: new Date(),
      });
      console.log("  ✓ customer: user@dev.local (verified)");
    }

    // 3. Cities
    const cities = [
      { city: "Mumbai", state: "Maharashtra" },
      { city: "Delhi", state: "Delhi" },
      { city: "Bengaluru", state: "Karnataka" },
    ];
    for (const c of cities) {
      if (!(await EventCity.findOne({ city: c.city }))) {
        await EventCity.create({ ...c, country: "India", createdBy: new Date() });
      }
    }
    console.log(`  ✓ cities: ${cities.map((c) => c.city).join(", ")}`);

    // 4. Events — a couple of upcoming (multi-city same name) + one past (for rating)
    const tickets = [
      { name: "Early Bird", price: "499", quantity: 20 },
      { name: "Regular", price: "799", quantity: 40 },
    ];
    const sampleEvents = [
      { name: "Dine with Strangers", type: "Dinner", city: "Mumbai", venue_name: "The Table, Bandra", date: daysFromNow(10), status: "Published" },
      { name: "Dine with Strangers", type: "Dinner", city: "Delhi", venue_name: "Social, CP", date: daysFromNow(12), status: "Published" },
      { name: "Rooftop Mixer", type: "Mixer", city: "Bengaluru", venue_name: "Skyye, UB City", date: daysFromNow(7), status: "Published" },
      { name: "Board Games Night", type: "Games", city: "Mumbai", venue_name: "Bombay Cafe", date: daysFromNow(-5), status: "Published" }, // past → rateable
    ];
    for (const e of sampleEvents) {
      const exists = await Event.findOne({ name: e.name, city: e.city, date: e.date });
      if (!exists) {
        await Event.create({
          ...e,
          venue: e.venue_name,
          tickets,
          description: `<p>Come along to <strong>${e.name}</strong> in ${e.city}. Meet new people over a great evening.</p>`,
          min_age: 18,
          max_age: 45,
          image: "https://images.unsplash.com/photo-1519389950473-47ba0277781c?w=1200",
          start_time: "7:00 PM",
          end_time: "10:00 PM",
          createdBy: new Date(),
        });
      }
    }
    console.log(`  ✓ events: ${sampleEvents.length} (incl. 1 past for rating tests)`);

    // 5. Coupons
    const coupons = [
      { code: "WELCOME10", description: "10% off your first booking", discountType: "percent", discountValue: 10, minOrderValue: 0, maxDiscount: 200, active: true, listed: true },
      { code: "FLAT100", description: "₹100 off orders above ₹500", discountType: "flat", discountValue: 100, minOrderValue: 500, active: true, listed: true },
    ];
    for (const c of coupons) {
      if (!(await Coupon.findOne({ code: c.code }))) await Coupon.create(c);
    }
    console.log(`  ✓ coupons: ${coupons.map((c) => c.code).join(", ")}`);

    // 6. A FAQ + a review so those pages aren't empty
    if (!(await Faq.findOne({ question: /how do i book/i }))) {
      await Faq.create({ category: "Booking", question: "How do I book an event?", answer: "Open an event, pick a venue and ticket, and check out." });
    }
    if (!(await Review.findOne({ name: "Aditi (dev)" }))) {
      await Review.create({ name: "Aditi (dev)", location: "Mumbai", description: "Loved the vibe — met some great people!", rating: 5, comments: ["Fun", "Welcoming"], date: new Date(), createdBy: new Date() });
    }
    console.log("  ✓ 1 FAQ + 1 review");

    console.log("\nDone. Sign in to the admin with the credentials above.\n");
    process.exit(0);
  } catch (err) {
    console.error("Seed failed:", err.message);
    process.exit(1);
  } finally {
    await mongoose.connection.close().catch(() => {});
  }
})();
