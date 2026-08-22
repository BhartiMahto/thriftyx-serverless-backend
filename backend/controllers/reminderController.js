const Event = require("../models/EventModel");
const Order = require("../models/orderModel");
const sendMail = require("../utils/sendMail");
const { niceDate, SUPPORT, sendWaTemplate, firstName } = require("../utils/notify");

/**
 * Scheduled pre-event reminders (24h + 3h before start), sent on WhatsApp + email.
 * Driven by a cron Lambda (see handler.reminders / serverless.yml). Idempotent:
 * each order records reminders.h24 / reminders.h3 so a reminder is sent once even
 * though the cron runs every 15 min.
 */

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/**
 * The event's actual start instant, from `date` (calendar day) + `start_time`
 * ("HH:MM", IST). Robust to `date` being stored at IST-midnight or UTC-midnight —
 * it takes the IST calendar day either way. Falls back to IST-midnight if no time.
 */
const eventStart = (ev) => {
  if (!ev?.date) return null;
  const ist = new Date(new Date(ev.date).getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear(), m = ist.getUTCMonth(), d = ist.getUTCDate();
  let hh = 0, mm = 0;
  const t = String(ev.start_time || "").match(/^(\d{1,2}):(\d{2})/);
  if (t) { hh = Number(t[1]); mm = Number(t[2]); }
  return new Date(Date.UTC(y, m, d, hh, mm) - IST_OFFSET_MS);
};

const venueFor = (ev, city) => {
  const nrm = (s) => String(s || "").trim().toLowerCase();
  const loc = (ev.locations || []).find((l) => nrm(l.city) === nrm(city));
  return loc
    ? [loc.venue, loc.address].filter(Boolean).join(", ")
    : [ev.venue_name || ev.venue, ev.city].filter(Boolean).join(", ");
};

const MAX_PER_RUN = 400;

/**
 * Finds bookings whose event starts in ~24h or ~3h and hasn't had that reminder
 * yet, and sends it. Returns a small summary. Never throws to the caller.
 */
async function sendDueReminders() {
  const now = Date.now();
  // Coarse event window (precise start is computed per event below): anything
  // that could be within the next ~26h, plus a small past buffer for tz edges.
  const from = new Date(now - 18 * 3600 * 1000);
  const to = new Date(now + 30 * 3600 * 1000);

  const events = await Event.find({ date: { $gte: from, $lte: to } })
    .select("name date start_time end_time venue_name venue city locations")
    .lean();

  let sent24 = 0, sent3 = 0, failed = 0, processed = 0;

  for (const ev of events) {
    const start = eventStart(ev);
    if (!start) continue;
    const hoursToStart = (start.getTime() - now) / 3600000;
    // Which reminder (if any) is due for this event right now?
    let kind = null;
    if (hoursToStart > 3 && hoursToStart <= 24) kind = "h24";
    else if (hoursToStart > 0 && hoursToStart <= 3) kind = "h3";
    if (!kind) continue;

    const orders = await Order.find({
      event_id: ev._id,
      status: "completed",
      applicationStatus: "confirmed",
      cancelledAt: null,
      "refund.id": null,
      [`reminders.${kind}`]: null, // not yet reminded for this window
    }).populate("user_id", "email phone name");

    for (const o of orders) {
      if (processed >= MAX_PER_RUN) {
        console.warn(`reminders: hit per-run cap (${MAX_PER_RUN}); rest next run`);
        return { sent24, sent3, failed, capped: true };
      }
      processed++;

      const who = firstName(o.attendee_details?.name || o.user_id?.name);
      const phone = o.attendee_details?.phone || o.user_id?.phone;
      const email = o.attendee_details?.email || o.user_id?.email;
      const time = ev.start_time || "";
      const where = venueFor(ev, o.event_city || ev.city || "");
      // Single-line timing phrase (WhatsApp variables can't contain newlines).
      const whenPhrase = kind === "h3"
        ? `today${time ? ` at ${time}` : ""} — starting soon`
        : `${niceDate(ev.date)}${time ? ` at ${time}` : ""}`;

      try {
        await sendWaTemplate(phone, "TWILIO_WA_EVENT_REMINDER_SID", {
          1: who, 2: ev.name || "your event", 3: whenPhrase, 4: where || "the venue",
        });
        if (email) {
          const body = [
            `Hi ${who}, a quick reminder about "${ev.name || "your event"}":`,
            "",
            `🗓 ${whenPhrase}`,
            where ? `📍 ${where}` : "",
            "",
            'Bring your ticket QR (in "My Tickets" on your profile). See you there!',
            `Questions? ${SUPPORT}`,
            "— IRL Social Hive",
          ].filter((l) => l !== "").join("\n");
          await sendMail(email, `Reminder — ${ev.name || "IRL Social Hive"}`, body).catch(() => {});
        }
        await Order.updateOne({ _id: o._id }, { $set: { [`reminders.${kind}`]: new Date() } });
        kind === "h24" ? sent24++ : sent3++;
      } catch (e) {
        failed++;
        console.error("reminder send failed:", String(o._id), e.message);
      }
    }
  }

  return { sent24, sent3, failed, events: events.length };
}

module.exports = { sendDueReminders, eventStart };
