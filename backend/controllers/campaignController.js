const User = require("../models/userModel");
const Order = require("../models/orderModel");
const Coupon = require("../models/couponModel");
const CampaignSend = require("../models/campaignSendModel");
const { sendWhatsappTemplate } = require("../utils/sendMessage");
const { client } = require("../utils/twilioClient");

/**
 * WhatsApp marketing campaigns.
 *
 * Business-initiated WhatsApp marketing MUST use a Meta-approved template
 * (Twilio Content SID). Each campaign maps to a coupon, a template SID (from an
 * env var), and an audience. Sends are batched (Lambda has a 29s cap), deduped
 * via CampaignSend (unique campaign+phone), and every send is logged.
 */

const CAMPAIGNS = {
  WELCOMEBACK70: {
    coupon: "WELCOMEBACK70",
    sidEnv: "TWILIO_WA_WB70_SID",
    audience: "all-women",
    label: "WELCOMEBACK70 — 70% off for all women (booked + never-booked)",
  },
  BUY1GET1: {
    coupon: "BUY1GET1",
    sidEnv: "TWILIO_WA_BOGO_SID",
    audience: "all-women",
    label: "Buy 1 Get 1 — all women",
  },
};

const FEMALE = /^female$/i;
const firstNameOf = (name) => (String(name || "").trim().split(/\s+/)[0] || "there");

/** Shapes one recipient for the audience list. */
const toRecipient = (f, lastBooking = null) => ({
  user_id: f._id,
  phone: f.phone,
  firstName: firstNameOf(f.name),
  name: (f.name || "").trim(),
  city: f.city || "",
  gender: f.gender || "",
  lastBooking: lastBooking || null,
});

/**
 * Resolves a campaign's recipient list →
 * [{ user_id, phone, firstName, name, city, lastBooking }].
 */
const resolveAudience = async (def) => {
  const females = await User.find({ gender: FEMALE, phone: { $nin: [null, ""] } })
    .select("_id name phone city gender")
    .lean();

  // Last completed booking per woman (used both to segment AND to show in the
  // recipient table so the admin can tell returning vs never-booked apart).
  const ids = females.map((f) => f._id);
  const agg = await Order.aggregate([
    { $match: { user_id: { $in: ids }, status: "completed" } },
    { $group: { _id: "$user_id", last: { $max: "$createdBy" } } },
  ]);
  const lastById = new Map(agg.map((a) => [String(a._id), a.last]));

  if (def.audience === "all-women") {
    return females.map((f) => toRecipient(f, lastById.get(String(f._id)) || null));
  }

  // lapsed-women: had a completed booking, last one older than the coupon's window.
  const coupon = await Coupon.findOne({ code: new RegExp(`^${def.coupon}$`, "i") }).lean();
  const lapsedDays = coupon?.lapsedDays || 90;
  const cutoff = new Date(Date.now() - lapsedDays * 864e5);

  return females
    .filter((f) => {
      const l = lastById.get(String(f._id));
      return l && new Date(l) < cutoff;
    })
    .map((f) => toRecipient(f, lastById.get(String(f._id))));
};

/** GET /api/admin/campaigns/:campaign/preview — audience + progress, no sending. */
const preview = async (req, res) => {
  try {
    const def = CAMPAIGNS[req.params.campaign];
    if (!def) return res.status(404).json({ message: "Unknown campaign", statusCode: 404 });

    const [audience, sentCount] = await Promise.all([
      resolveAudience(def),
      CampaignSend.countDocuments({ campaign: def.coupon, status: "sent" }),
    ]);

    res.status(200).json({
      message: "Campaign preview",
      data: {
        campaign: def.coupon,
        label: def.label,
        templateConfigured: Boolean(process.env[def.sidEnv]),
        audienceCount: audience.length,
        alreadySent: sentCount,
        remaining: Math.max(0, audience.length - sentCount),
      },
      statusCode: 200,
    });
  } catch (e) {
    console.error("campaign preview error:", e.message);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * GET /api/admin/campaigns/:campaign/recipients — the full audience with details,
 * so the admin can SEE and choose exactly who gets the message before sending.
 * Each row carries an `alreadySent` flag (sent/failed in a prior batch).
 */
const recipients = async (req, res) => {
  try {
    const def = CAMPAIGNS[req.params.campaign];
    if (!def) return res.status(404).json({ message: "Unknown campaign", statusCode: 404 });

    const [audience, logs] = await Promise.all([
      resolveAudience(def),
      CampaignSend.find({ campaign: def.coupon }).select("phone status").lean(),
    ]);
    const statusByPhone = new Map(logs.map((r) => [r.phone, r.status]));

    const data = audience
      .map((r) => ({
        userId: r.user_id,
        name: r.name,
        phone: r.phone,
        city: r.city,
        gender: r.gender,
        lastBooking: r.lastBooking,
        sendStatus: statusByPhone.get(r.phone) || null, // "sent" | "failed" | null
        alreadySent: statusByPhone.has(r.phone),
      }))
      // Not-yet-sent first, then most-recent booking first.
      .sort((a, b) => {
        if (a.alreadySent !== b.alreadySent) return a.alreadySent ? 1 : -1;
        return new Date(b.lastBooking || 0) - new Date(a.lastBooking || 0);
      });

    res.status(200).json({
      message: "Campaign recipients",
      data,
      meta: { campaign: def.coupon, total: data.length, alreadySent: logs.filter((l) => l.status === "sent").length },
      statusCode: 200,
    });
  } catch (e) {
    console.error("campaign recipients error:", e.message);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * POST /api/admin/campaigns/:campaign/send
 * body: { mode: "test"|"send", testNumber?, batchSize?, phones? }
 *  - test: sends the template to ONE number (not logged, not deduped).
 *  - send: sends to up to batchSize recipients NOT already sent, logs each.
 *          If `phones` (array) is given, only those selected recipients are
 *          messaged (intersected with the audience); otherwise the whole audience.
 * The admin UI calls "send" repeatedly until remaining === 0.
 */
const send = async (req, res) => {
  try {
    const def = CAMPAIGNS[req.params.campaign];
    if (!def) return res.status(404).json({ message: "Unknown campaign", statusCode: 404 });

    const contentSid = process.env[def.sidEnv];
    if (!contentSid) {
      return res.status(400).json({ message: `Template not configured — set ${def.sidEnv} to the approved WhatsApp template Content SID`, statusCode: 400 });
    }

    const mode = req.body.mode === "send" ? "send" : "test";

    // --- TEST: one message to the admin's own number, nothing logged ---
    if (mode === "test") {
      const num = String(req.body.testNumber || "").trim();
      if (!num) return res.status(400).json({ message: "testNumber is required", statusCode: 400 });
      try {
        const sid = await sendWhatsappTemplate(num, contentSid, { 1: "there" });
        return res.status(200).json({ message: "Test sent", data: { messageSid: sid }, statusCode: 200 });
      } catch (e) {
        return res.status(502).json({ message: `Test send failed: ${e.message}`, statusCode: 502 });
      }
    }

    // --- SEND: a batch of not-yet-sent recipients ---
    const batchSize = Math.min(Math.max(Number(req.body.batchSize) || 50, 1), 100);
    const audience = await resolveAudience(def);

    // Optional selection: only message these phones (∩ audience). Absent/empty =
    // the whole audience. Normalised loosely so UI-supplied numbers still match.
    const selected = Array.isArray(req.body.phones)
      ? new Set(req.body.phones.map((p) => String(p).trim()))
      : null;
    const chosen = selected && selected.size
      ? audience.filter((r) => selected.has(r.phone))
      : audience;

    // Skip anyone already sent this campaign (dedupe across batches / re-runs).
    const sentPhones = new Set(
      (await CampaignSend.find({ campaign: def.coupon }).select("phone").lean()).map((r) => r.phone)
    );
    const pendingAll = chosen.filter((r) => !sentPhones.has(r.phone));
    const pending = pendingAll.slice(0, batchSize);

    let sent = 0, failed = 0;
    for (const r of pending) {
      try {
        const sid = await sendWhatsappTemplate(r.phone, contentSid, { 1: r.firstName });
        await CampaignSend.create({ campaign: def.coupon, user_id: r.user_id, phone: r.phone, firstName: r.firstName, status: "sent", messageSid: sid });
        sent++;
      } catch (e) {
        // Log failures too (dedupe key), so a bad number doesn't block the batch
        // or get retried forever.
        try {
          await CampaignSend.create({ campaign: def.coupon, user_id: r.user_id, phone: r.phone, firstName: r.firstName, status: "failed", error: String(e.message).slice(0, 300) });
        } catch { /* duplicate key — already logged */ }
        failed++;
      }
    }

    const totalSent = await CampaignSend.countDocuments({ campaign: def.coupon });
    res.status(200).json({
      message: "Batch processed",
      data: {
        batchSent: sent,
        batchFailed: failed,
        totalProcessed: totalSent,
        // Remaining within the CHOSEN set (drives the UI's batch loop). Every
        // processed recipient (sent or failed) is logged, so it won't recur.
        remaining: Math.max(0, pendingAll.length - pending.length),
      },
      statusCode: 200,
    });
  } catch (e) {
    console.error("campaign send error:", e.message);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

const FINAL_STATUSES = ["delivered", "read", "undelivered", "failed"];
const RECEIVED = new Set(["delivered", "read"]);

/**
 * GET /api/admin/campaigns/:campaign/delivery — who actually received the
 * message vs who didn't. Uses the delivery status refreshed from Twilio (plus
 * failed-at-send rows). "notReceived" = failed at send OR undelivered/failed.
 */
const delivery = async (req, res) => {
  try {
    const def = CAMPAIGNS[req.params.campaign];
    if (!def) return res.status(404).json({ message: "Unknown campaign", statusCode: 404 });

    const logs = await CampaignSend.find({ campaign: def.coupon }).lean();
    const uids = logs.map((l) => l.user_id).filter(Boolean);
    const users = uids.length
      ? await User.find({ _id: { $in: uids } }).select("name city").lean()
      : [];
    const byId = new Map(users.map((u) => [String(u._id), u]));

    const rows = logs.map((l) => {
      const u = l.user_id ? byId.get(String(l.user_id)) : null;
      // Failed at send has no Twilio delivery status — treat as "failed".
      const ds = l.deliveryStatus || (l.status === "failed" ? "failed" : "");
      const notReceived = l.status === "failed" || ds === "undelivered" || ds === "failed";
      return {
        phone: l.phone,
        name: u?.name || l.firstName || "",
        city: u?.city || "",
        deliveryStatus: ds,
        received: RECEIVED.has(ds),
        notReceived,
        reason: l.error || (l.errorCode ? `Twilio error ${l.errorCode}` : ""),
        at: l.createdAt,
      };
    });

    const summary = {
      total: rows.length,
      received: rows.filter((r) => r.received).length,
      read: rows.filter((r) => r.deliveryStatus === "read").length,
      notReceived: rows.filter((r) => r.notReceived).length,
      pending: rows.filter((r) => !r.received && !r.notReceived).length,
      // How many still need a status refresh from Twilio.
      needsRefresh: logs.filter(
        (l) => l.messageSid && !FINAL_STATUSES.includes(l.deliveryStatus || "")
      ).length,
    };

    res.status(200).json({ message: "Delivery report", data: rows, meta: { campaign: def.coupon, ...summary }, statusCode: 200 });
  } catch (e) {
    console.error("campaign delivery error:", e.message);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * POST /api/admin/campaigns/:campaign/delivery/refresh
 * Pulls the latest delivery status from Twilio for a batch of this campaign's
 * sends whose status isn't final yet, and stores it. The UI loops this until
 * `remaining` is 0. body: { batchSize? }
 */
const refreshDelivery = async (req, res) => {
  try {
    const def = CAMPAIGNS[req.params.campaign];
    if (!def) return res.status(404).json({ message: "Unknown campaign", statusCode: 404 });
    if (!client) return res.status(400).json({ message: "Twilio not configured", statusCode: 400 });

    const batchSize = Math.min(Math.max(Number(req.body.batchSize) || 50, 1), 100);
    const pending = await CampaignSend.find({
      campaign: def.coupon,
      messageSid: { $nin: [null, ""] },
      deliveryStatus: { $nin: FINAL_STATUSES },
    })
      .limit(batchSize)
      .lean();

    let updated = 0;
    for (const r of pending) {
      try {
        const m = await client.messages(r.messageSid).fetch();
        await CampaignSend.updateOne(
          { _id: r._id },
          { $set: { deliveryStatus: m.status || "", errorCode: m.errorCode ? String(m.errorCode) : "", deliveryCheckedAt: new Date() } }
        );
        updated++;
      } catch {
        /* transient — leave for the next refresh pass */
      }
    }

    const remaining = await CampaignSend.countDocuments({
      campaign: def.coupon,
      messageSid: { $nin: [null, ""] },
      deliveryStatus: { $nin: FINAL_STATUSES },
    });

    res.status(200).json({ message: "Refreshed", data: { checked: pending.length, updated, remaining }, statusCode: 200 });
  } catch (e) {
    console.error("campaign refreshDelivery error:", e.message);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

module.exports = { preview, recipients, send, delivery, refreshDelivery, CAMPAIGNS };
