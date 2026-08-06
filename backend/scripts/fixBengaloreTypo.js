/**
 * One-off data fix: correct the misspelled city "Bengalore" -> "Bengaluru"
 * wherever it appears (event.city, event.locations[].city, order.event_city).
 *
 * Read-only by default. Pass --apply to actually write the changes.
 *   node scripts/fixBengaloreTypo.js          # dry run (report only)
 *   node scripts/fixBengaloreTypo.js --apply   # apply the fix
 */
require("dotenv").config();
const mongoose = require("mongoose");

const WRONG = "Bengalore";
const RIGHT = "Bengaluru";
const APPLY = process.argv.includes("--apply");

(async () => {
  const uri = process.env.MONGO_URI;
  if (!uri) throw new Error("MONGO_URI not set");
  await mongoose.connect(uri);
  const db = mongoose.connection.db;
  console.log(`Connected to: ${mongoose.connection.name}  (${APPLY ? "APPLY" : "DRY RUN"})\n`);

  const rx = new RegExp(`^${WRONG}$`, "i");

  // --- Events: top-level city ---
  const events = db.collection("events");
  const evTop = await events.countDocuments({ city: rx });
  const evLoc = await events.countDocuments({ "locations.city": rx });
  console.log(`events.city == "${WRONG}"          : ${evTop}`);
  console.log(`events.locations[].city == "${WRONG}": ${evLoc}`);

  // --- Orders: event_city ---
  const orders = db.collection("orders");
  const ordCity = await orders.countDocuments({ event_city: rx });
  console.log(`orders.event_city == "${WRONG}"     : ${ordCity}`);

  // Sample a few event names for context.
  const samples = await events
    .find({ $or: [{ city: rx }, { "locations.city": rx }] }, { projection: { name: 1, city: 1, "locations.city": 1 } })
    .limit(5)
    .toArray();
  if (samples.length) {
    console.log("\nSample affected events:");
    for (const s of samples) {
      const locCities = (s.locations || []).map((l) => l.city).join(", ");
      console.log(`  - ${s.name} | top: ${s.city} | locations: [${locCities}]`);
    }
  }

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to write changes.");
    await mongoose.disconnect();
    return;
  }

  console.log("\nApplying fixes...");
  // 1) Top-level event.city
  const r1 = await events.updateMany({ city: rx }, { $set: { city: RIGHT } });
  // 2) Nested locations[].city — positional-filtered update per matching element.
  const r2 = await events.updateMany(
    { "locations.city": rx },
    { $set: { "locations.$[el].city": RIGHT } },
    { arrayFilters: [{ "el.city": rx }] }
  );
  // 3) orders.event_city
  const r3 = await orders.updateMany({ event_city: rx }, { $set: { event_city: RIGHT } });

  console.log(`  events.city updated     : ${r1.modifiedCount}`);
  console.log(`  events.locations updated: ${r2.modifiedCount}`);
  console.log(`  orders.event_city upd.  : ${r3.modifiedCount}`);

  // Verify none remain.
  const remainTop = await events.countDocuments({ city: rx });
  const remainLoc = await events.countDocuments({ "locations.city": rx });
  const remainOrd = await orders.countDocuments({ event_city: rx });
  console.log(`\nRemaining after fix -> events.city:${remainTop} locations:${remainLoc} orders:${remainOrd}`);

  await mongoose.disconnect();
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
