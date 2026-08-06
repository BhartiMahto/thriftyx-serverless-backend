/**
 * Clear the cached ticket PDF (ticket_url) on completed/paid orders so the next
 * download/email regenerates the PDF in the current format (e.g. with the venue
 * map + "Get directions" link). SAFE: the QR is a deterministic JWT (same every
 * time), so any ticket a customer already downloaded still scans fine at the
 * door. The old S3 file is left in place (emailed links keep working); a fresh
 * PDF is created on next fetch.
 *
 *   node scripts/refreshTickets.js           # dry run (list only)
 *   node scripts/refreshTickets.js --apply    # clear ticket_url
 *
 * Re-run with --apply AFTER deploying the new backend, so regeneration uses the
 * updated code.
 */
require("dotenv").config();
const mongoose = require("mongoose");

const APPLY = process.argv.includes("--apply");

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection.db;
  console.log(`Connected to ${mongoose.connection.name} (${APPLY ? "APPLY" : "DRY RUN"})\n`);

  const q = { status: "completed", ticket_url: { $exists: true, $nin: [null, ""] } };
  const rows = await db.collection("orders").find(q).sort({ _id: -1 }).toArray();
  console.log(`Completed orders with a cached ticket_url: ${rows.length}`);
  for (const o of rows) {
    console.log(`  ${o.order_id || String(o._id).slice(-6)} | city:${o.event_city || ""} | ${o.createdBy}`);
  }

  if (!APPLY) {
    console.log("\nDry run only. Re-run with --apply to clear ticket_url.");
    await mongoose.disconnect();
    return;
  }

  const r = await db.collection("orders").updateMany(q, { $unset: { ticket_url: "" } });
  console.log(`\nCleared ticket_url on ${r.modifiedCount} order(s). They will regenerate on next download.`);
  await mongoose.disconnect();
})().catch((e) => { console.error("ERROR:", e.message); process.exit(1); });
