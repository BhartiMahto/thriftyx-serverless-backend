const sendMail = require("./sendMail");
const { sendWhatsapp } = require("./sendMessage");

/**
 * Best-effort notification for a single order. Resolves the recipient from the
 * order's attendee details (falling back to the populated account) and sends an
 * email + WhatsApp. Never throws — a delivery failure must not break the booking
 * operation that triggered it.
 *
 * @param {Object} order            an Order (attendee_details, and ideally a
 *                                  populated user_id with email/phone)
 * @param {Object} msg
 * @param {string} msg.subject      email subject
 * @param {string} msg.body         message body (used for both email + WhatsApp)
 */
async function notifyOrder(order, { subject, body }) {
  try {
    const d = order.attendee_details || {};
    const u = order.user_id && typeof order.user_id === "object" ? order.user_id : {};
    const email = d.email || u.email || null;
    const phone = d.phone || u.phone || null;

    const tasks = [];
    if (email && subject && body) {
      tasks.push(sendMail(email, subject, body).catch((e) => console.error("notifyOrder email:", e.message)));
    }
    if (phone && body) {
      tasks.push(sendWhatsapp(phone, body).catch((e) => console.error("notifyOrder whatsapp:", e.message)));
    }
    await Promise.allSettled(tasks);
  } catch (e) {
    console.error("notifyOrder error:", e.message);
  }
}

/**
 * Best-effort notification to a single user account (email + WhatsApp). Mirrors
 * notifyOrder but takes a plain user object — used for non-order messages such
 * as "the event you were interested in is now open for booking". Never throws.
 *
 * @param {Object} user            a user with email/phone (e.g. a populated account)
 * @param {Object} msg
 * @param {string} msg.subject     email subject
 * @param {string} msg.body        message body (used for both email + WhatsApp)
 */
async function notifyUser(user, { subject, body }) {
  try {
    const u = user && typeof user === "object" ? user : {};
    const email = u.email || null;
    const phone = u.phone || null;

    const tasks = [];
    if (email && subject && body) {
      tasks.push(sendMail(email, subject, body).catch((e) => console.error("notifyUser email:", e.message)));
    }
    if (phone && body) {
      tasks.push(sendWhatsapp(phone, body).catch((e) => console.error("notifyUser whatsapp:", e.message)));
    }
    await Promise.allSettled(tasks);
  } catch (e) {
    console.error("notifyUser error:", e.message);
  }
}

/** Friendly date like "Sat, 12 Sep 2026". */
function niceDate(d) {
  if (!d) return "the new date";
  return new Date(d).toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" });
}

const SUPPORT = "help@thriftyx.com / +91-8247539519";

module.exports = { notifyOrder, notifyUser, niceDate, SUPPORT };
