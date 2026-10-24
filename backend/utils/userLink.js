const User = require("../models/userModel");
const { toE164 } = require("./phone");

/** Last 10 digits of a phone, ignoring +, spaces, dashes. "" if none. */
const norm10 = (p) => String(p || "").replace(/\D/g, "").slice(-10);

/** Lower-cased, trimmed email. "" if none. */
const normEmail = (e) => String(e || "").trim().toLowerCase();

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * A regex that matches a stored phone by its last 10 digits even when the stored
 * value has +91 / spaces / dashes (e.g. "+91 81797 25766" matches "8179725766").
 */
const phoneTailRe = (ph10) => new RegExp(ph10.split("").join("[^0-9]*") + "$");

/**
 * Find a user whose phone (last-10) or email matches, else create a minimal
 * account so the person can OTP-login and see this booking. Never throws into
 * the caller — returns null on failure so a booking is never blocked by this.
 * Fills blank name/email/phone on an existing account (never overwrites).
 */
async function findOrCreateUserForAttendee(a = {}) {
  try {
    const ph10 = norm10(a.phone);
    const emailLc = normEmail(a.email);
    const or = [];
    if (ph10) or.push({ phone: phoneTailRe(ph10) });
    if (emailLc) or.push({ email: new RegExp("^" + escapeRe(emailLc) + "$", "i") });

    let user = or.length ? await User.findOne({ $or: or }) : null;
    if (user) {
      let dirty = false;
      if (!user.name && a.name) { user.name = a.name; dirty = true; }
      if (!user.email && a.email) { user.email = a.email; dirty = true; }
      if (!user.phone && a.phone) { user.phone = a.phone; dirty = true; }
      if (dirty) await user.save();
      return user;
    }
    if (!ph10 && !emailLc) return null; // nothing to key an account on
    return await User.create({
      name: a.name || null,
      email: a.email || null,
      // Store canonical E.164 so OTP-login's phoneCandidates() match this account
      // (a raw/spaced phone wouldn't match a clean login input).
      phone: toE164(a.phone) || a.phone || null,
      gender: a.gender || null,
      city: a.city || null,
      DOB: a.DOB || null,
      maritalStatus: a.maritalStatus || null,
      isVerified: true, // phone/email come from a real paid booking
      createdBy: new Date(),
    });
  } catch (e) {
    console.error("findOrCreateUserForAttendee:", e.message);
    return null;
  }
}

/**
 * Mongo filter for "my bookings": the user's own linked orders PLUS any order
 * whose attendee phone (last-10) or email matches this (OTP-verified) account —
 * so login-free / invite-only bookings surface for the right person on login.
 */
function myOrdersFilter(user = {}) {
  const or = [{ user_id: user._id }];
  const ph10 = norm10(user.phone);
  const emailLc = normEmail(user.email);
  if (ph10) or.push({ "attendee_details.phone": phoneTailRe(ph10) });
  if (emailLc) or.push({ "attendee_details.email": new RegExp("^" + escapeRe(emailLc) + "$", "i") });
  return { $or: or };
}

module.exports = { norm10, normEmail, findOrCreateUserForAttendee, myOrdersFilter };
