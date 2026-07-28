const User = require("../models/userModel");
const Order = require("../models/orderModel");
const cloudinary = require("../utils/cloudinary");
const streamifier = require("streamifier");

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

    // Email and phone are login identifiers — changing them would need a fresh
    // OTP verification, so they are rejected here rather than silently ignored.
    if (req.body.email !== undefined || req.body.phone !== undefined) {
      return res.status(400).json({
        message: "Email and phone cannot be changed here — they require OTP re-verification",
        statusCode: 400,
      });
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

module.exports = { getMyProfile, updateMyProfile, updateMyAvatar, getMyStats };
