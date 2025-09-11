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

/* ------------------ USER REGISTER/LOGIN/OTP ------------------ */

const register = async (req, res) => {
  const { email, phone, name, password } = req.body;
  const lowerCaseEmail = email ? email.toLowerCase() : null;

  const filter = phone ? { phone } : { email: lowerCaseEmail };
  const existingUser = await User.findOne(filter);

  if (existingUser) {
    return res
      .status(400)
      .json({ message: "User Already Exists", statusCode: 400 });
  }

  const hashPassword = bcrypt.hashSync(password, 8);
  const tokenWith = phone ? phone : lowerCaseEmail;
  const token = jwtSignGenerator(tokenWith);
  const today = new Date();
  const fourDigitOtp = generateOtp(4);

  if (lowerCaseEmail) sendOtpToEmail(fourDigitOtp, lowerCaseEmail, name);
  if (phone) sendMessageToWhatsapp(fourDigitOtp, phone);

  const userDetails = {
    name,
    phone,
    email: lowerCaseEmail,
    password: hashPassword,
    token,
    otp: fourDigitOtp,
    createdBy: today,
    isVerified: false,
  };

  try {
    await User.create(userDetails);
    return res
      .status(201)
      .json({ message: "User Registered But Not Verified", statusCode: 201 });
  } catch (err) {
    console.log("Error :", err);
    return res.status(500).json({ message: "Internal Server Error" });
  }
};

const userLogin = async (req, res) => {
  const { email, phone } = req.body;
  const lowerCaseEmail = email ? email.toLowerCase() : null;

  const filter = phone ? { phone } : { email: lowerCaseEmail };
  const user = await User.findOne(filter);

  if (!user) return res.status(404).json({ message: "User Not Found" });

  const fourDigitOtp = generateOtp(4);

  if (lowerCaseEmail) sendOtpToEmail(fourDigitOtp, lowerCaseEmail, user.name);
  if (phone) sendMessageToWhatsapp(fourDigitOtp, phone);

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
    return res.status(200).json({ message: "User Unverified", statusCode: 200 });
  }

  return res.status(200).json({ message: "User Verified", statusCode: 200 });
};

const verifyCode = async (req, res) => {
  const { email, phone, otp, otpType } = req.body;
  const lowerCaseEmail = email ? email.toLowerCase() : null;

  const filter = phone ? { phone } : { email: lowerCaseEmail };
  const user = await User.findOne(filter);

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

  const filter = phone ? { phone } : { email: lowerCaseEmail };
  const user = await User.findOne(filter);

  if (!user) return res.status(404).json({ message: "User Not Found" });

  const fourDigitOtp = generateOtp(4);

  if (lowerCaseEmail) sendOtpToEmail(fourDigitOtp, lowerCaseEmail, user.name);
  if (phone) sendMessageToWhatsapp(fourDigitOtp, phone);

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

const adminLogin = async (req, res) => {
  try {
    const { email, password } = req.body;

    const admin = await Admin.findOne({ email });
    if (!admin) return res.status(400).json({ error: "Invalid credentials" });

    const isMatch = await bcrypt.compare(password, admin.password);
    if (!isMatch) return res.status(400).json({ error: "Invalid credentials" });

    const token = jwt.sign(
      { id: admin._id, role: admin.role },
      process.env.JWT_SECRET,
      { expiresIn: "1d" }
    );

    res.json({ message: "Login Success", token, admin });
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
  adminLogin,
};
