/**
 * One-off backfill: turn "pass sold as a ticket" orders into Golden Pass
 * memberships so those buyers show under Subscriptions.
 *
 * SAFE + IDEMPOTENT:
 *   - Skips any user who already has a membership (re-run any time).
 *   - One membership per user (their most recent pass purchase).
 *   - Validity = purchase date + 1 year (status active/expired accordingly).
 *   - 30 credits, 0 used; price = what they paid.
 *
 * Usage:
 *   # Dry run — reports what WOULD happen, writes nothing:
 *   MONGO_URI="<prod-uri>" DRY_RUN=1 node scripts/migrate-pass-memberships.js
 *
 *   # Real run against prod:
 *   MONGO_URI="<prod-uri>" node scripts/migrate-pass-memberships.js
 *
 * If MONGO_URI isn't passed inline it falls back to backend/.env.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const Counter = require("../models/counterModel");
const Membership = require("../models/membershipModel");

const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const YEAR = 365 * 24 * 3600 * 1000;

(async () => {
  if (!process.env.MONGO_URI) { console.error("MONGO_URI is required"); process.exit(1); }
  await mongoose.connect(process.env.MONGO_URI);
  const db = mongoose.connection;
  console.log(`Connected to DB: ${db.name}  |  ${DRY_RUN ? "DRY RUN (no writes)" : "LIVE RUN"}`);

  const Events = db.collection("events");
  const Orders = db.collection("orders");
  const Users = db.collection("users");

  const passEventIds = (await Events.find({ name: /golden|yearly|pass/i }).project({ _id: 1, name: 1 }).toArray());
  console.log("Pass-like events:", passEventIds.map((e) => e.name).join(", ") || "(none)");
  const ids = passEventIds.map((e) => e._id);
  if (!ids.length) { await mongoose.disconnect(); return; }

  const orders = await Orders.find({ event_id: { $in: ids }, status: "completed" })
    .project({ user_id: 1, grand_total: 1, payment_id: 1, createdBy: 1 }).toArray();

  // One pass per user — keep the most recent purchase.
  const byUser = new Map();
  for (const o of orders) {
    if (!o.user_id) continue;
    const k = String(o.user_id);
    const prev = byUser.get(k);
    const t = o.createdBy ? new Date(o.createdBy).getTime() : 0;
    const pt = prev?.createdBy ? new Date(prev.createdBy).getTime() : -1;
    if (!prev || t > pt) byUser.set(k, o);
  }

  const now = Date.now();
  let created = 0, skipped = 0, active = 0, expired = 0;

  for (const [uid, o] of byUser) {
    if (await Membership.findOne({ user_id: uid })) { skipped++; continue; }

    const start = o.createdBy ? new Date(o.createdBy) : new Date();
    const expires = new Date(start.getTime() + YEAR);
    const status = expires.getTime() > now ? "active" : "expired";
    status === "active" ? active++ : expired++;

    if (DRY_RUN) { created++; continue; }

    const seq = await Counter.next("member:golden");
    const memberId = `TX-GOLD-${String(seq).padStart(4, "0")}`;
    const user = await Users.findOne({ _id: new mongoose.Types.ObjectId(uid) }, { projection: { city: 1 } });

    await Membership.create({
      user_id: uid, tier: "golden", memberId,
      eventsTotal: 30, eventsUsed: 0, status,
      price: o.grand_total || 0, city: user?.city || null,
      startsAt: start, expiresAt: expires, payment_id: o.payment_id || null,
      createdBy: new Date(), updatedBy: new Date(),
    });
    created++;
  }

  console.log(JSON.stringify({
    passOrders: orders.length, uniqueUsers: byUser.size,
    [DRY_RUN ? "wouldCreate" : "created"]: created, skipped, active, expired,
  }, null, 2));
  await mongoose.disconnect();
})().catch((e) => { console.error("MIGRATION ERROR:", e.message); process.exit(1); });
