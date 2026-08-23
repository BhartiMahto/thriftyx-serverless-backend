/**
 * Backfill User profiles from past booking details.
 *
 * Historically the checkout captured the attendee's name/gender/DOB/city/
 * maritalStatus/reasonToJoin onto the ORDER (order.attendee_details) but never
 * copied them to the booker's User profile, so the admin Customers page showed
 * those users as blank ("No name"). createOrder now syncs this on every new
 * booking (fill-if-blank); this one-off script does the same for existing
 * bookings.
 *
 * FILL-IF-BLANK: only profile fields that are currently empty are set — a value
 * the user deliberately entered on their Profile page is never overwritten. For
 * each blank field we take the value from that user's MOST RECENT order that
 * has a non-empty value for it.
 *
 * SAFE BY DEFAULT: dry-run unless you pass --apply. Dry-run only reads.
 *
 *   Dry run (no writes):   node scripts/backfillProfilesFromOrders.js
 *   Apply the changes:     node scripts/backfillProfilesFromOrders.js --apply
 */
require("dotenv").config();
const mongoose = require("mongoose");
const User = require("../models/userModel");
const Order = require("../models/orderModel");

const APPLY = process.argv.includes("--apply");
const FIELDS = ["name", "city", "gender", "maritalStatus", "reasonToJoin", "DOB"];

const isBlank = (v) => v === null || v === undefined || v === "";
const str = (v) => (v === null || v === undefined ? "" : String(v).trim());

/** Compute the fill-if-blank $set for one user from their ordered attendee rows. */
function computeSet(user, attendeeRowsNewestFirst) {
  const set = {};
  for (const field of FIELDS) {
    if (!isBlank(user[field])) continue; // never overwrite an existing value
    for (const a of attendeeRowsNewestFirst) {
      if (field === "DOB") {
        if (!a.DOB) continue;
        const d = new Date(a.DOB);
        if (Number.isNaN(d.getTime()) || d.getTime() > Date.now()) continue;
        set.DOB = d;
        break;
      }
      const v = str(a[field]);
      if (!v) continue;
      set[field] = field === "reasonToJoin" ? v.slice(0, 200) : v;
      break;
    }
  }
  return set;
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const dbName = mongoose.connection.name;
  console.log(`Connected to "${dbName}" — mode: ${APPLY ? "APPLY (writing)" : "DRY RUN (read-only)"}\n`);

  // Users who have at least one order carrying attendee details to copy from.
  const userIds = await Order.distinct("user_id", {
    "attendee_details.name": { $nin: [null, ""] },
  });
  console.log(`Candidate users (have a booking with attendee details): ${userIds.length}`);

  let filled = 0;
  const fieldCounts = {};
  const samples = [];

  for (const uid of userIds) {
    const user = await User.findById(uid)
      .select("name city gender DOB maritalStatus reasonToJoin email")
      .lean();
    if (!user) continue;
    if (FIELDS.every((f) => !isBlank(user[f]))) continue; // nothing blank

    // Newest-first attendee rows for this user (booker details).
    const orders = await Order.find({ user_id: uid, "attendee_details.name": { $nin: [null, ""] } })
      .select("attendee_details createdBy")
      .sort({ createdBy: -1, _id: -1 })
      .lean();
    const rows = orders.map((o) => o.attendee_details).filter(Boolean);
    if (!rows.length) continue;

    const set = computeSet(user, rows);
    if (!Object.keys(set).length) continue;

    for (const k of Object.keys(set)) fieldCounts[k] = (fieldCounts[k] || 0) + 1;
    if (samples.length < 10) samples.push({ email: user.email, set });
    filled++;

    if (APPLY) await User.updateOne({ _id: uid }, { $set: set });
  }

  console.log(`\nUsers that would be updated: ${filled}`);
  console.log("Per-field fills:", JSON.stringify(fieldCounts, null, 2));
  console.log("\nSamples (up to 10):");
  for (const s of samples) console.log(" ", s.email, "->", JSON.stringify(s.set));
  console.log(`\n${APPLY ? "DONE — changes written." : "DRY RUN — nothing written. Re-run with --apply to write."}`);

  await mongoose.disconnect();
})().catch((e) => {
  console.error("backfill error:", e.message);
  process.exit(1);
});
