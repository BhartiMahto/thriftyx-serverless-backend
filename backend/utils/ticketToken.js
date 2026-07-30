const jwt = require("jsonwebtoken");

/**
 * Signed QR payload for event tickets.
 *
 * The QR printed on a ticket is NOT the order id in plain text — it's a JWT
 * signed with JWT_SECRET, so door staff can verify a ticket is genuine (and
 * un-forged) at scan time. The token carries the order + event id and an
 * expiry a little past the event, after which the QR stops verifying.
 */

const DEFAULT_TTL_DAYS = 2;

/**
 * @param {Object} order   an Order document (needs _id, event_id)
 * @param {Date}   [eventEnd]  event end/date used to set expiry
 * @param {number} [attendeeIndex=0]  which attendee on the order this QR admits
 */
function signTicket(order, eventEnd, attendeeIndex = 0) {
  const base = eventEnd ? new Date(eventEnd).getTime() : Date.now();
  // Valid until the day after the event so late scans still pass.
  const exp = Math.floor((base + DEFAULT_TTL_DAYS * 24 * 3600 * 1000) / 1000);

  // `exp` (unix seconds) goes in the PAYLOAD; do not also pass expiresIn/exp in
  // options — jsonwebtoken rejects that.
  return jwt.sign(
    {
      t: "ticket",
      oid: String(order._id),
      eid: String(order.event_id?._id || order.event_id || ""),
      // `ai` = attendee index; identifies which person on a multi-ticket order
      // this QR admits, so each is checked in individually.
      ai: Number(attendeeIndex) || 0,
      exp,
    },
    process.env.JWT_SECRET
  );
}

/** Verifies a scanned token. Returns the decoded payload or null. */
function verifyTicket(token) {
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (!decoded || decoded.t !== "ticket" || !decoded.oid) return null;
    return decoded;
  } catch {
    return null;
  }
}

module.exports = { signTicket, verifyTicket };
