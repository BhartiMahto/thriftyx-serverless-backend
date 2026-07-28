/**
 * Brings legacy admin records onto the current schema.
 *
 * THREE generations exist in the `admins` collection:
 *
 *   1. `admin@thriftyx.com` — only { email, password, token }. The old
 *      AdminController identified the super-admin by hardcoded email
 *      (`element.email !== "admin@thriftyx.com"` excluded it from the sub-admin
 *      list), so it never needed a role field.
 *
 *   2. Staff accounts — { name, status, assignedWork: [{title, isAssigned}] }.
 *      The old register() never wrote `role` or `permissions` at all.
 *
 *   3. Newer accounts — { fullName, role, permissions: [{module, access}] },
 *      but using component names ("EventManagement") rather than the canonical
 *      module names the API validates against.
 *
 * Without this, every legacy account reads as a sub-admin with no permissions,
 * and nobody is a SUPER_ADMIN — so Sub-Admin Management is unreachable.
 *
 *   node scripts/migrateAdminRoles.js            # dry run
 *   node scripts/migrateAdminRoles.js --apply    # write
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");

const APPLY = process.argv.includes("--apply");

/** The account the old code treated as the super-admin. */
const SUPER_ADMIN_EMAIL = process.env.LEGACY_SUPER_ADMIN_EMAIL || "admin@thriftyx.com";

/** Old `assignedWork` title -> canonical module. */
const TITLE_TO_MODULE = {
  "Events": "events",
  "Create New Event": "events",
  "Users": "users",
  "Orders": "orders",
  "Gallery": "gallery",
  "Header Image": "siteContent",
  "Founders": "founder",
  "Partners": "partner",
  "Question Answer": "faq",
  "Reviews": "reviews",
  "Contact Us": "support",
  // "Dashboard" is the landing overview, not a permissioned module — skipped.
};

/** Component-style module names -> canonical module. */
const COMPONENT_TO_MODULE = {
  EventManagement: "events",
  RevenueAnalytics: "revenue",
  FinanceInsights: "finance",
  GalleryManager: "gallery",
  CustomerCenter: "users",
  SubAdminManagement: "subadmin",
  SupportTickets: "support",
  FAQ: "faq",
};

(async () => {
  try {
    await connectDB();
    const col = mongoose.connection.db.collection("admins");
    const docs = await col.find({}).toArray();

    const plan = [];

    for (const doc of docs) {
      const set = {};

      // 1. The legacy hardcoded super-admin.
      if (doc.email === SUPER_ADMIN_EMAIL) {
        if (doc.role !== "SUPER_ADMIN") set.role = "SUPER_ADMIN";
        if (!doc.fullName) set.fullName = doc.name || "Super Admin";
        if (!doc.status) set.status = "active";
        // A super-admin's access is implicit; no permission list needed.
      } else {
        if (!doc.role) set.role = "SUB_ADMIN";
        if (!doc.fullName && doc.name) set.fullName = String(doc.name).trim();
        if (!doc.status) set.status = "active";

        // 2. assignedWork -> permissions
        if (Array.isArray(doc.assignedWork) && !Array.isArray(doc.permissions)) {
          const perms = [];
          const seen = new Set();
          for (const work of doc.assignedWork) {
            const module = TITLE_TO_MODULE[work?.title];
            if (!module || seen.has(module)) continue;
            seen.add(module);
            // isAssigned was a boolean; treat it as full access to that area.
            perms.push({ module, access: work.isAssigned ? "EDIT" : "NONE" });
          }
          if (perms.length) set.permissions = perms;
        }

        // 3. Component-style module names -> canonical names.
        if (Array.isArray(doc.permissions) && doc.permissions.length) {
          const remapped = [];
          const seen = new Set();
          let changed = false;
          for (const p of doc.permissions) {
            const module = COMPONENT_TO_MODULE[p.module] || p.module;
            if (module !== p.module) changed = true;
            if (seen.has(module)) continue;
            seen.add(module);
            remapped.push({ module, access: p.access || "NONE" });
          }
          if (changed) set.permissions = remapped;
        }
      }

      if (Object.keys(set).length) plan.push({ _id: doc._id, email: doc.email, set });
    }

    if (!plan.length) {
      console.log("Nothing to migrate — all admin records are already current.");
      process.exit(0);
    }

    console.log(`${plan.length} account(s) need updating:\n`);
    for (const p of plan) {
      console.log(`  ${p.email}`);
      for (const [k, v] of Object.entries(p.set)) {
        console.log(`      ${k} -> ${Array.isArray(v) ? JSON.stringify(v) : v}`);
      }
    }

    if (!APPLY) {
      console.log("\nDry run. Re-run with --apply to write these changes.");
      process.exit(0);
    }

    for (const p of plan) {
      await col.updateOne({ _id: p._id }, { $set: p.set });
    }

    const supers = await col.countDocuments({ role: "SUPER_ADMIN" });
    console.log(`\nApplied. SUPER_ADMIN accounts now: ${supers}`);
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err.message);
    process.exit(1);
  }
})();
