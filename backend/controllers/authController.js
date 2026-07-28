const User = require("../models/userModel");
const Admin = require("../models/adminModel");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const {
  generateOtp,
  sendOtpToEmail,
  sendMessageToWhatsapp,
} = require("../utils/otp");
const { jwtSignGenerator, jwtGenerator } = require("../utils/jwt");
const { OAuth2Client } = require("google-auth-library");
const { toE164 } = require("../utils/phone");

/**
 * Delivers an OTP over whichever channel the user chose.
 *
 * Previously these calls were fire-and-forget, so a Twilio or SMTP failure was
 * invisible and the API still replied "OTP sent". Now the caller can react.
 * Returns { ok, channel, error }.
 */
const deliverOtp = async ({ otp, email, phone, name }) => {
  const channel = phone ? "whatsapp" : "email";

  // Local development aid: print the code to the server console so the login
  // flow can be exercised while email/WhatsApp delivery is misconfigured.
  //
  // Guarded by BOTH an explicit opt-in and NODE_ENV, and the code is only ever
  // written to the server log — never returned in the HTTP response, which
  // would let anyone log in as anyone.
  if (process.env.OTP_DEBUG === "true" && process.env.NODE_ENV !== "production") {
    console.log(`[OTP_DEBUG] ${channel} code for ${phone || email}: ${otp}`);
  }

  try {
    if (phone) await sendMessageToWhatsapp(otp, phone);
    else await sendOtpToEmail(otp, email, name);
    return { ok: true, channel };
  } catch (err) {
    console.error(`OTP delivery failed over ${channel}:`, err.message);
    return { ok: false, channel, error: err.message };
  }
};

/**
 * Every phone shape the same person might be stored as.
 *
 * Existing rows hold bare national numbers ("9876543210") — a sample of 3000
 * were all 10 digits — while new sign-ups are stored E.164 ("+919876543210").
 * Someone typing "+91…" must still match their old 10-digit row, so all forms
 * are tried.
 */
const phoneCandidates = (phone) => {
  const e164 = toE164(phone);
  const digits = String(phone).replace(/\D/g, "");
  const national = digits.slice(-10);

  return [
    e164,
    e164 ? e164.replace(/^\+/, "") : null,
    digits,
    national,
    String(phone).trim(),
  ].filter(Boolean);
};

/** Looks a user up by whichever identifier was supplied. */
const findUserByIdentifier = ({ email, phone }) => {
  if (phone) {
    return User.findOne({ phone: { $in: [...new Set(phoneCandidates(phone))] } });
  }
  return User.findOne({ email: email ? email.toLowerCase() : null });
};

/* ------------------ USER REGISTER/LOGIN/OTP ------------------ */

const register = async (req, res) => {
  const { email, phone, name, password } = req.body;
  const lowerCaseEmail = email ? email.toLowerCase() : null;
  // Store phones in a single canonical format so lookups match regardless of
  // whether the user typed a country code.
  const normalisedPhone = phone ? toE164(phone) : null;

  if (!lowerCaseEmail && !normalisedPhone) {
    return res
      .status(400)
      .json({ message: "An email or a WhatsApp number is required", statusCode: 400 });
  }

  const existingUser = await findUserByIdentifier({ email: lowerCaseEmail, phone });

  if (existingUser) {
    return res
      .status(400)
      .json({ message: "User Already Exists", statusCode: 400 });
  }

  const hashPassword = password ? bcrypt.hashSync(password, 8) : undefined;
  const tokenWith = normalisedPhone ? normalisedPhone : lowerCaseEmail;
  const token = jwtSignGenerator(tokenWith);
  const today = new Date();
  const fourDigitOtp = generateOtp(4);

  const userDetails = {
    name,
    phone: normalisedPhone,
    email: lowerCaseEmail,
    password: hashPassword,
    token,
    otp: fourDigitOtp,
    createdBy: today,
    isVerified: false,
  };

  try {
    const created = await User.create(userDetails);

    const delivery = await deliverOtp({
      otp: fourDigitOtp,
      email: lowerCaseEmail,
      phone: normalisedPhone,
      name,
    });

    if (!delivery.ok) {
      // Don't leave a half-registered account behind that can never verify.
      await User.deleteOne({ _id: created._id });
      return res.status(502).json({
        message: `Could not send the code over ${delivery.channel}. Please try the other option.`,
        statusCode: 502,
      });
    }

    return res.status(201).json({
      message: "User Registered But Not Verified",
      channel: delivery.channel,
      statusCode: 201,
    });
  } catch (err) {
    console.log("Error :", err);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

const userLogin = async (req, res) => {
  const { email, phone } = req.body;
  const lowerCaseEmail = email ? email.toLowerCase() : null;
  const normalisedPhone = phone ? toE164(phone) : null;

  if (!lowerCaseEmail && !normalisedPhone) {
    return res
      .status(400)
      .json({ message: "An email or a WhatsApp number is required", statusCode: 400 });
  }

  const user = await findUserByIdentifier({ email: lowerCaseEmail, phone });

  if (!user) return res.status(404).json({ message: "User Not Found" });

  const fourDigitOtp = generateOtp(4);

  const delivery = await deliverOtp({
    otp: fourDigitOtp,
    email: lowerCaseEmail,
    phone: normalisedPhone,
    name: user.name,
  });

  if (!delivery.ok) {
    return res.status(502).json({
      message: `Could not send the code over ${delivery.channel}. Please try the other option.`,
      statusCode: 502,
    });
  }

  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        otp: fourDigitOtp,
        isVerified: user.isVerified,
        registrationId: user.registrationId,
      },
    }
  );

  if (!user.isVerified) {
    return res
      .status(200)
      .json({ message: "User Unverified", channel: delivery.channel, statusCode: 200 });
  }

  return res
    .status(200)
    .json({ message: "User Verified", channel: delivery.channel, statusCode: 200 });
};

const verifyCode = async (req, res) => {
  const { email, phone, otp, otpType } = req.body;

  const user = await findUserByIdentifier({ email, phone });

  if (!user) return res.status(404).json({ message: "User Not Found" });
  if (user.otp !== otp) {
    return res.status(400).json({ message: "Incorrect OTP", statusCode: 400 });
  }

  if (otpType === "register") {
    const registrationId = "thriftyx_" + generateOtp(6);
    const token = jwtGenerator({ _id: user._id });

    await User.updateOne(
      { _id: user._id },
      { $set: { token, otp: null, isVerified: true, registrationId } }
    );

    return res.status(200).json({
      message: "Registration Successful",
      user: {
        _id: user._id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        isVerified: true,
        registrationId,
      },
      token,
      statusCode: 200,
    });
  }

  if (otpType === "login") {
    const token = jwtGenerator({ _id: user._id });

    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          token,
          otp: null,
          isVerified: user.isVerified,
          registrationId: user.registrationId,
        },
      }
    );

    return res.status(200).json({
      message: "Login Success",
      user: {
        _id: user._id,
        DOB: user.DOB,
        city: user.city,
        name: user.name,
        phone: user.phone,
        email: user.email,
        gender: user.gender,
        isVerified: user.isVerified,
        registrationId: user.registrationId,
        profilePicture: user.profilePicture,
      },
      token,
      statusCode: 200,
    });
  }

  if (otpType === "forgot") {
    if (user.forgotCode !== otp) {
      return res
        .status(400)
        .json({ message: "Incorrect OTP", statusCode: 400 });
    }
    await User.updateOne({ _id: user._id }, { $set: { forgotCode: null } });
    return res
      .status(200)
      .json({ message: "OTP Verified Successfully", statusCode: 200 });
  }
};

const resendOTP = async (req, res) => {
  const { email, phone } = req.body;
  const lowerCaseEmail = email ? email.toLowerCase() : null;
  const normalisedPhone = phone ? toE164(phone) : null;

  const user = await findUserByIdentifier({ email, phone });

  if (!user) return res.status(404).json({ message: "User Not Found" });

  const fourDigitOtp = generateOtp(4);

  const delivery = await deliverOtp({
    otp: fourDigitOtp,
    email: lowerCaseEmail,
    phone: normalisedPhone,
    name: user.name,
  });

  if (!delivery.ok) {
    return res.status(502).json({
      message: `Could not send the code over ${delivery.channel}.`,
      statusCode: 502,
    });
  }

  if (!user.isVerified) {
    await User.updateOne(
      { _id: user._id },
      {
        $set: {
          otp: fourDigitOtp,
          isVerified: user.isVerified,
          registrationId: user.registrationId,
        },
      }
    );
    return res.status(200).json({ message: "New OTP Sent", statusCode: 200 });
  }

  await User.updateOne(
    { _id: user._id },
    { $set: { forgotCode: fourDigitOtp } }
  );

  return res.status(200).json({ message: "New OTP Sent", statusCode: 200 });
};

const updatePassword = async (req, res) => {
  const { email, phone, password } = req.body;
  const lowerCaseEmail = email ? email.toLowerCase() : null;

  const user = await User.findOne({
    $or: [{ phone }, { email: lowerCaseEmail }],
  });

  if (!user) return res.status(404).json({ message: "User Not Found" });
  if (user.forgotCode !== null) {
    return res.status(400).json({ message: "Email Not Verified" });
  }

  const passIsValid = bcrypt.compareSync(password, user.password);
  if (passIsValid) {
    return res.status(400).json({
      message: "Password Must Be Different From Previous Password",
    });
  }

  const hashPassword = bcrypt.hashSync(password, 8);
  await User.updateOne({ _id: user._id }, { $set: { password: hashPassword } });

  return res
    .status(200)
    .json({ message: "Password Reset Successfully", statusCode: 200 });
};

const forgotPassword = async (req, res) => {
  try {
    const { email, phone } = req.body;
    const lowerCaseEmail = email ? email.toLowerCase() : null;

    const user = await User.findOne({
      $or: [{ phone }, { email: lowerCaseEmail }],
    });

    if (!user) return res.status(404).json({ message: "User Not Found" });

    const otp = generateOtp(4);
    if (lowerCaseEmail) sendOtpToEmail(otp, lowerCaseEmail, user.name);

    user.forgotCode = otp;
    await user.save();

    return res.status(200).json({ message: "OTP Sent", statusCode: 200 });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

/* ------------------ GOOGLE SIGN-IN ------------------ */

const googleClient = process.env.GOOGLE_CLIENT_ID
  ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID)
  : null;

/**
 * POST /api/auth/google
 *
 * Takes the ID token issued by Google Identity Services in the browser and
 * verifies it server-side. The token is never trusted as-is: verifyIdToken
 * checks Google's signature, the audience (our client id), and expiry, so a
 * forged token cannot mint a session.
 *
 * A Google account with a verified email either signs in an existing user with
 * that email or creates a new, already-verified one.
 */
const googleLogin = async (req, res) => {
  try {
    if (!googleClient) {
      return res.status(503).json({
        message: "Google sign-in is not configured (GOOGLE_CLIENT_ID)",
        statusCode: 503,
      });
    }

    const { credential } = req.body;
    if (!credential) {
      return res.status(400).json({ message: "Missing Google credential", statusCode: 400 });
    }

    let payload;
    try {
      const ticket = await googleClient.verifyIdToken({
        idToken: credential,
        audience: process.env.GOOGLE_CLIENT_ID,
      });
      payload = ticket.getPayload();
    } catch (err) {
      console.error("Google token verification failed:", err.message);
      return res.status(401).json({ message: "Invalid Google credential", statusCode: 401 });
    }

    // Google sets email_verified=false for some workspace/alias cases; refusing
    // those stops someone claiming an address they don't actually control.
    if (!payload?.email || payload.email_verified === false) {
      return res
        .status(401)
        .json({ message: "Google account has no verified email", statusCode: 401 });
    }

    const email = payload.email.toLowerCase();
    let user = await User.findOne({ email });

    if (!user) {
      user = await User.create({
        name: payload.name || email.split("@")[0],
        email,
        // No password: this account signs in through Google.
        isVerified: true,
        profilePicture: payload.picture || null,
        registrationId: "thriftyx_" + generateOtp(6),
        createdBy: new Date(),
      });
    } else if (!user.isVerified) {
      // Google has already proven ownership of the address.
      user.isVerified = true;
      if (!user.registrationId) user.registrationId = "thriftyx_" + generateOtp(6);
      if (!user.profilePicture && payload.picture) user.profilePicture = payload.picture;
      await user.save();
    }

    const token = jwtGenerator({ _id: user._id });
    await User.updateOne({ _id: user._id }, { $set: { token, otp: null } });

    return res.status(200).json({
      message: "Login Success",
      user: {
        _id: user._id,
        name: user.name,
        email: user.email,
        phone: user.phone,
        city: user.city,
        gender: user.gender,
        DOB: user.DOB,
        profilePicture: user.profilePicture,
        isVerified: true,
        registrationId: user.registrationId,
      },
      token,
      statusCode: 200,
    });
  } catch (error) {
    console.error("googleLogin error:", error);
    return res.status(500).json({ message: "Internal Server Error", statusCode: 500 });
  }
};

/**
 * GET /api/auth/admin/me — the current admin, straight from the database.
 *
 * The dashboard caches the admin profile in localStorage at login, so a role or
 * permission change would otherwise not take effect until the next sign-in.
 * Calling this on load keeps the cached copy honest.
 */
const adminMe = async (req, res) => {
  try {
    const admin = req.admin;
    if (!admin) {
      return res.status(401).json({ message: "Unauthorized", statusCode: 401 });
    }
    if (admin.status === "suspended") {
      return res.status(403).json({ message: "This account has been suspended", statusCode: 403 });
    }

    return res.status(200).json({
      message: "Admin",
      data: {
        _id: admin._id,
        fullName: admin.fullName ?? null,
        email: admin.email,
        role: admin.role ?? "SUB_ADMIN",
        status: admin.status ?? "active",
        permissions: Array.isArray(admin.permissions)
          ? admin.permissions.map((p) => ({ module: p.module, access: p.access }))
          : [],
      },
      statusCode: 200,
    });
  } catch (error) {
    console.error("adminMe error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

const adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    const admin = await Admin.findOne({ email: String(email || "").toLowerCase().trim() });
    if (!admin) return res.status(400).json({ error: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

    // A suspended sub-admin keeps their record but must not get a session.
    if (admin.status === "suspended") {
      return res.status(403).json({ error: "This account has been suspended" });
    }

    const token = jwt.sign(
      { id: admin._id, role: admin.role },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    await Admin.updateOne({ _id: admin._id }, { $set: { lastLoginAt: new Date() } });

    // Never return the password hash to the browser.
    res.json({
      message: "Login Success",
      token,
      admin: {
        _id: admin._id,
        fullName: admin.fullName,
        email: admin.email,
        role: admin.role,
        status: admin.status ?? "active",
        permissions: admin.permissions ?? [],
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  register,
  userLogin,
  verifyCode,
  resendOTP,
  updatePassword,
  forgotPassword,
  googleLogin,
  adminLogin,
  adminMe,
};
