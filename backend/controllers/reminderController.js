const Event = require("../models/EventModel");
const Order = require("../models/orderModel");
const sendMail = require("../utils/sendMail");
const { niceDate, SUPPORT, sendWaTemplate, firstName } = require("../utils/notify");
const { whenForCity } = require("../utils/tickets");

/**
 * Scheduled pre-event reminders (24h + 3h + 1h before start), sent on WhatsApp +
 * email. Driven by a cron Lambda (see handler.reminders / serverless.yml).
 * Idempotent: each order records reminders.h24 / reminders.h3 / reminders.h1 so a
 * reminder is sent once even though the cron runs every 15 min.
 */

const IST_OFFSET_MS = 5.5 * 3600 * 1000;

/**
 * The event's actual start instant for a given booking city, from that city's
 * effective `date` (calendar day) + `start_time` ("HH:MM", IST) — a city may
 * override the event's top-level date/time (e.g. one city postponed), else it
 * inherits the top-level. Robust to `date` being stored at IST- or UTC-midnight.
 * Falls back to IST-midnight if no time. Omitting `city` uses the top-level.
 */
const eventStart = (ev, city) => {
  const { date, start_time } = whenForCity(ev, city);
  if (!date) return null;
  const ist = new Date(new Date(date).getTime() + IST_OFFSET_MS);
  const y = ist.getUTCFullYear(), m = ist.getUTCMonth(), d = ist.getUTCDate();
  let hh = 0, mm = 0;
  const t = String(start_time || "").match(/^(\d{1,2}):(\d{2})/);
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

  // Any event whose top-level date OR any city's overridden date is in the window.
  const events = await Event.find({
    $or: [
      { date: { $gte: from, $lte: to } },
      { "locations.date": { $gte: from, $lte: to } },
    ],
  })
    .select("name date start_time end_time venue_name venue city locations")
    .lean();

  const bandFor = (h) =>
    (h > 3 && h <= 24) ? "h24" : (h > 1 && h <= 3) ? "h3" : (h > 0 && h <= 1) ? "h1" : null;

  let sent24 = 0, sent3 = 0, sent1 = 0, failed = 0, processed = 0;

  for (const ev of events) {
    // Fetch all still-valid bookings for this event; the due reminder band is
    // computed PER booking from ITS city's date/time (cities can differ, e.g.
    // one city postponed). Idempotency is checked per band below.
    const orders = await Order.find({
      event_id: ev._id,
      status: "completed",
      applicationStatus: "confirmed",
      cancelledAt: null,
      "refund.id": null,
    }).populate("user_id", "email phone name");

    for (const o of orders) {
      const start = eventStart(ev, o.event_city);
      if (!start) continue;
      const hoursToStart = (start.getTime() - now) / 3600000;
      const kind = bandFor(hoursToStart);
      if (!kind) continue;
      if (o.reminders && o.reminders[kind]) continue; // already reminded for this window

      if (processed >= MAX_PER_RUN) {
        console.warn(`reminders: hit per-run cap (${MAX_PER_RUN}); rest next run`);
        return { sent24, sent3, sent1, failed, capped: true };
      }
      processed++;

      const who = firstName(o.attendee_details?.name || o.user_id?.name);
      const phone = o.attendee_details?.phone || o.user_id?.phone;
      const email = o.attendee_details?.email || o.user_id?.email;
      const cityWhen = whenForCity(ev, o.event_city);
      const time = cityWhen.start_time || "";
      const where = venueFor(ev, o.event_city || ev.city || "");
      // Single-line timing phrase (WhatsApp variables can't contain newlines).
      let whenPhrase;
      if (kind === "h1") whenPhrase = `today${time ? ` at ${time}` : ""} — starting in about an hour`;
      else if (kind === "h3") whenPhrase = `today${time ? ` at ${time}` : ""} — starting soon`;
      else whenPhrase = `${niceDate(cityWhen.date)}${time ? ` at ${time}` : ""}`;

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
        if (kind === "h24") sent24++;
        else if (kind === "h3") sent3++;
        else sent1++;
      } catch (e) {
        failed++;
        console.error("reminder send failed:", String(o._id), e.message);
      }
    }
  }

  return { sent24, sent3, sent1, failed, events: events.length };
}

module.exports = { sendDueReminders, eventStart };
