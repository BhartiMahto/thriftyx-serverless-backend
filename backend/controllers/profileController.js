const User = require("../models/userModel");
const Order = require("../models/orderModel");
const cloudinary = require("../utils/cloudinary");
const streamifier = require("streamifier");
const { generateOtp, sendOtpToEmail, sendMessageToWhatsapp } = require("../utils/otp");
const { toE164 } = require("../utils/phone");

// How long a contact-change OTP stays valid.
const CONTACT_OTP_TTL_MS = 15 * 60 * 1000;

/** Every stored shape the same phone might take, for uniqueness matching. */
const phoneMatchCandidates = (phone) => {
  const e164 = toE164(phone);
  const digits = String(phone).replace(/\D/g, "");
  const national = digits.slice(-10);
  return [...new Set([e164, e164 && e164.replace(/^\+/, ""), digits, national, String(phone).trim()].filter(Boolean))];
};

/** Fields the customer is allowed to change about themselves. */
const EDITABLE_FIELDS = [
  "name",
  "city",
  "gender",
  "DOB",
  "maritalStatus",
  "occupation",
  "reasonToJoin",
  "bio",
  "interests",
];

const NOTIFICATION_KEYS = ["email", "whatsapp", "eventReminders", "marketing"];

const DEFAULT_NOTIFICATIONS = {
  email: true,
  whatsapp: true,
  eventReminders: true,
  marketing: false,
};

/** Age is derived from DOB rather than stored, so it can never go stale. */
const ageFromDob = (dob) => {
  if (!dob) return null;
  const born = new Date(dob);
  if (Number.isNaN(born.getTime())) return null;

  const now = new Date();
  let age = now.getFullYear() - born.getFullYear();
  const monthDiff = now.getMonth() - born.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && now.getDate() < born.getDate())) age -= 1;

  return age >= 0 && age < 150 ? age : null;
};

/** Never leak credentials or one-time codes to the client. */
const publicUser = (user) => ({
  _id: user._id,
  name: user.name ?? null,
  email: user.email ?? null,
  phone: user.phone ?? null,
  city: user.city ?? null,
  gender: user.gender ?? null,
  DOB: user.DOB ?? null,
  age: ageFromDob(user.DOB),
  maritalStatus: user.maritalStatus ?? null,
  occupation: user.occupation ?? null,
  reasonToJoin: user.reasonToJoin ?? null,
  bio: user.bio ?? null,
  interests: Array.isArray(user.interests) ? user.interests : [],
  profilePicture: user.profilePicture ?? null,
  isVerified: Boolean(user.isVerified),
  registrationId: user.registrationId ?? null,
  notificationPreferences: {
    ...DEFAULT_NOTIFICATIONS,
    ...(user.notificationPreferences?.toObject?.() ?? user.notificationPreferences ?? {}),
  },
});

/** GET /api/user/me */
const getMyProfile = async (req, res) => {
  try {
    return res.status(200).json({
      message: "Profile",
      data: publicUser(req.user),
      statusCode: 200,
    });
  } catch (error) {
    console.error("getMyProfile error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** PATCH /api/user/me */
const updateMyProfile = async (req, res) => {
  try {
    const updates = {};

    for (const field of EDITABLE_FIELDS) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    // Email / phone rules:
    //   • CHANGING an existing one needs OTP re-verification → rejected here.
    //   • ADDING one for the first time (account has none) is allowed inline —
    //     e.g. a member adds their phone at checkout. Validated + unique-checked.
    for (const channel of ["email", "phone"]) {
      if (req.body[channel] === undefined || req.body[channel] === null || String(req.body[channel]).trim() === "") {
        continue;
      }
      if (req.user[channel]) {
        return res.status(400).json({
          message: `Your ${channel} can only be changed with OTP verification (from your profile)`,
          statusCode: 400,
        });
      }
      // First-time add.
      const raw = String(req.body[channel]).trim();
      let value, query;
      if (channel === "email") {
        value = raw.toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
          return res.status(400).json({ message: "Enter a valid email address", statusCode: 400 });
        }
        query = { email: value };
      } else {
        value = toE164(raw);
        if (!value) return res.status(400).json({ message: "Enter a valid phone number", statusCode: 400 });
        query = { phone: { $in: phoneMatchCandidates(raw) } };
      }
      const clash = await User.findOne({ ...query, _id: { $ne: req.user._id } }).select("_id").lean();
      if (clash) {
        return res.status(409).json({ message: `This ${channel} is already linked to another account`, statusCode: 409 });
      }
      updates[channel] = value;
    }

    if (updates.DOB) {
      const parsed = new Date(updates.DOB);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ message: "DOB is not a valid date", statusCode: 400 });
      }
      if (parsed.getTime() > Date.now()) {
        return res.status(400).json({ message: "DOB cannot be in the future", statusCode: 400 });
      }
      updates.DOB = parsed;
    }

    if (updates.name !== undefined && !String(updates.name).trim()) {
      return res.status(400).json({ message: "Name cannot be empty", statusCode: 400 });
    }

    if (updates.interests !== undefined) {
      if (!Array.isArray(updates.interests)) {
        return res.status(400).json({ message: "interests must be an array", statusCode: 400 });
      }
      updates.interests = updates.interests
        .map((i) => String(i).trim())
        .filter(Boolean)
        .slice(0, 20);
    }

    // Free-text fields are capped so a single profile can't bloat the document.
    for (const field of ["occupation", "reasonToJoin", "bio"]) {
      if (updates[field] !== undefined) {
        updates[field] = String(updates[field]).trim().slice(0, field === "bio" ? 1000 : 200) || null;
      }
    }

    // Notification prefs are nested, so they're merged key by key rather than
    // replaced wholesale — a partial update must not wipe the other flags.
    if (req.body.notificationPreferences !== undefined) {
      const incoming = req.body.notificationPreferences;
      if (typeof incoming !== "object" || incoming === null) {
        return res
          .status(400)
          .json({ message: "notificationPreferences must be an object", statusCode: 400 });
      }
      for (const key of NOTIFICATION_KEYS) {
        if (typeof incoming[key] === "boolean") {
          updates[`notificationPreferences.${key}`] = incoming[key];
        }
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "No editable fields provided", statusCode: 400 });
    }

    const user = await User.findByIdAndUpdate(req.user._id, { $set: updates }, { new: true });

    return res.status(200).json({
      message: "Profile updated",
      data: publicUser(user),
      statusCode: 200,
    });
  } catch (error) {
    console.error("updateMyProfile error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** POST /api/user/me/avatar — multipart, field name "profilePicture". */
const updateMyAvatar = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No image uploaded", statusCode: 400 });
    }

    const uploaded = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "avatars" },
        (error, result) => (error ? reject(error) : resolve(result))
      );
      streamifier.createReadStream(req.file.buffer).pipe(stream);
    });

    const user = await User.findByIdAndUpdate(
      req.user._id,
      { $set: { profilePicture: uploaded.secure_url } },
      { new: true }
    );

    return res.status(200).json({
      message: "Profile picture updated",
      data: publicUser(user),
      statusCode: 200,
    });
  } catch (error) {
    console.error("updateMyAvatar error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** GET /api/user/me/stats — small summary for the profile header. */
const getMyStats = async (req, res) => {
  try {
    const [total, completed, upcoming] = await Promise.all([
      Order.countDocuments({ user_id: req.user._id }),
      Order.countDocuments({ user_id: req.user._id, status: "completed" }),
      Order.countDocuments({ user_id: req.user._id, status: { $in: ["completed", "in_progress"] } }),
    ]);

    return res.status(200).json({
      message: "Stats",
      data: { totalBookings: total, paidBookings: completed, activeBookings: upcoming },
      statusCode: 200,
    });
  } catch (error) {
    console.error("getMyStats error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/* ------------------ Email / phone change (OTP-gated) ------------------ */

/**
 * POST /api/user/me/contact/request
 * Body: { channel: "email"|"phone", value }
 * Validates + checks the new value isn't used by another account, then sends an
 * OTP to that new email/phone. The change isn't applied until it's verified.
 */
const requestContactChange = async (req, res) => {
  try {
    const channel = req.body.channel;
    const raw = String(req.body.value ?? "").trim();
    if (!["email", "phone"].includes(channel)) {
      return res.status(400).json({ message: "channel must be email or phone", statusCode: 400 });
    }
    if (!raw) return res.status(400).json({ message: "A value is required", statusCode: 400 });

    let value, query, alreadyMine;
    if (channel === "email") {
      value = raw.toLowerCase();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        return res.status(400).json({ message: "Enter a valid email address", statusCode: 400 });
      }
      query = { email: value };
      alreadyMine = (req.user.email || "").toLowerCase() === value;
    } else {
      value = toE164(raw);
      if (!value) return res.status(400).json({ message: "Enter a valid phone number", statusCode: 400 });
      query = { phone: { $in: phoneMatchCandidates(raw) } };
      alreadyMine = phoneMatchCandidates(req.user.phone || "").some((c) => phoneMatchCandidates(raw).includes(c));
    }

    if (alreadyMine) {
      return res.status(400).json({ message: `That's already your ${channel}`, statusCode: 400 });
    }

    // Uniqueness: no OTHER account may hold this email/phone.
    const clash = await User.findOne({ ...query, _id: { $ne: req.user._id } }).select("_id").lean();
    if (clash) {
      return res.status(409).json({ message: `This ${channel} is already linked to another account`, statusCode: 409 });
    }

    const otp = generateOtp(4);
    await User.updateOne(
      { _id: req.user._id },
      {
        $set: {
          pendingEmail: channel === "email" ? value : null,
          pendingPhone: channel === "phone" ? value : null,
          contactOtp: otp,
          contactOtpAt: new Date(),
        },
      }
    );

    // Local dev aid: print the code to the server log (never returned in the
    // response). Guarded by the same opt-in as the login OTP flow.
    if (process.env.OTP_DEBUG === "true" && process.env.NODE_ENV !== "production") {
      console.log(`[OTP_DEBUG] contact-change ${channel} code for ${value}: ${otp}`);
    }

    // Deliver the code to the NEW destination so the user proves they own it.
    try {
      if (channel === "email") await sendOtpToEmail(otp, value, req.user.name);
      else await sendMessageToWhatsapp(otp, value);
    } catch (e) {
      console.error("contact OTP delivery failed:", e.message);
      return res.status(502).json({ message: `Could not send a code to that ${channel}. Try again.`, statusCode: 502 });
    }

    return res.status(200).json({ message: `We sent a code to your new ${channel}`, data: { channel }, statusCode: 200 });
  } catch (error) {
    console.error("requestContactChange error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * POST /api/user/me/contact/verify
 * Body: { otp }
 * Confirms the code and commits the pending email/phone to the account.
 */
const verifyContactChange = async (req, res) => {
  try {
    const otp = String(req.body.otp ?? "").trim();
    if (!otp) return res.status(400).json({ message: "Enter the code", statusCode: 400 });

    const user = await User.findById(req.user._id);
    if (!user || !user.contactOtp || (!user.pendingEmail && !user.pendingPhone)) {
      return res.status(400).json({ message: "No pending change — request a code first", statusCode: 400 });
    }
    if (user.contactOtpAt && Date.now() - new Date(user.contactOtpAt).getTime() > CONTACT_OTP_TTL_MS) {
      return res.status(400).json({ message: "This code has expired — request a new one", statusCode: 400 });
    }
    if (user.contactOtp !== otp) {
      return res.status(400).json({ message: "Incorrect code", statusCode: 400 });
    }

    const channel = user.pendingEmail ? "email" : "phone";
    const value = user.pendingEmail || user.pendingPhone;

    // Re-check uniqueness at commit time (guards a race between request + verify).
    const query = channel === "email" ? { email: value } : { phone: { $in: phoneMatchCandidates(value) } };
    const clash = await User.findOne({ ...query, _id: { $ne: user._id } }).select("_id").lean();
    if (clash) {
      user.pendingEmail = null; user.pendingPhone = null; user.contactOtp = null; user.contactOtpAt = null;
      await user.save();
      return res.status(409).json({ message: `This ${channel} was just taken by another account`, statusCode: 409 });
    }

    if (channel === "email") user.email = value; else user.phone = value;
    user.isVerified = true;
    user.pendingEmail = null; user.pendingPhone = null; user.contactOtp = null; user.contactOtpAt = null;
    await user.save();

    return res.status(200).json({ message: `Your ${channel} has been updated`, data: publicUser(user), statusCode: 200 });
  } catch (error) {
    console.error("verifyContactChange error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

module.exports = {
  getMyProfile,
  updateMyProfile,
  updateMyAvatar,
  getMyStats,
  requestContactChange,
  verifyContactChange,
};
