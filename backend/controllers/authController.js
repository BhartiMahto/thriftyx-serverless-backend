const User = require("../models/userModel");
const bcrypt = require("bcryptjs");
const {
  generateOtp,
  sendOtpToEmail,
  sendMessageToWhatsapp,
} = require("../utils/otp");
const { jwtSignGenerator, jwtGenerator } = require("../utils/jwt");

const register = async (req, res) => {
  const { email, phone, name } = req.body;
  const lowerCaseEmail = email ? email.toLowerCase() : null;

  const filter = phone ? { phone } : { email: lowerCaseEmail };
  const data = await User.findOne(filter);
  if (data)
    return res
      .status(400)
      .json({ message: "User Already Exists", statusCode: 400 });

  const hassPassword = bcrypt.hashSync(req.body.password, 8);
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
    password: hassPassword,
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

const login = async (req, res) => {
  const { email, phone } = req.body;
  const lowerCaseEmail = email ? email.toLowerCase() : null;

  const filter = phone ? { phone } : { email: lowerCaseEmail };
  const data = await User.findOne(filter);

  if (!data) return res.status(404).json({ message: "User Not Found" });

  const fourDigitOtp = generateOtp(4);
  if (lowerCaseEmail) sendOtpToEmail(fourDigitOtp, lowerCaseEmail, data.name);
  if (phone) sendMessageToWhatsapp(fourDigitOtp, phone);

  await User.updateOne(
    { _id: data._id },
    {
      $set: {
        otp: fourDigitOtp,
        isVerified: data.isVerified,
        registrationId: data.registrationId,
      },
    }
  );

  if (!data.isVerified) {
    return res
      .status(200)
      .json({ message: "User Unverified", statusCode: 200 });
  }
  return res.status(200).json({ message: "User Verified", statusCode: 200 });
};

const verifyCode = async (req, res) => {
  const { email, phone } = req.body;
  const lowerCaseEmail = email ? email.toLowerCase() : null;

  const filter = phone ? { phone } : { email: lowerCaseEmail };
  const data = await User.findOne(filter);

  if (!data) return res.status(404).json({ message: "User Not Found" });
  if (data.otp !== req.body.otp)
    return res.status(400).json({ message: "Incorrect OTP", statusCode: 400 });

  if (req.body.otpType === "register") {
    const registrationId = "thriftyx_" + generateOtp(6);
    const token = jwtGenerator({ _id: data._id });

    await User.updateOne(
      { _id: data._id },
      {
        $set: {
          token,
          otp: null,
          isVerified: true,
          registrationId,
        },
      }
    );

    const user = {
      _id: data._id,
      name: data.name,
      phone: data.phone,
      email: data.email,
      isVerified: true,
      registrationId,
    };

    return res.status(200).json({
      message: "Registration Successful",
      user,
      token,
      statusCode: 200,
    });
  }

  if (req.body.otpType === "login") {
    const token = jwtGenerator({ _id: data._id });

    await User.updateOne(
      { _id: data._id },
      {
        $set: {
          token,
          otp: null,
          isVerified: data.isVerified,
          registrationId: data.registrationId,
        },
      }
    );

    const user = {
      _id: data._id,
      DOB: data.DOB,
      city: data.city,
      name: data.name,
      phone: data.phone,
      email: data.email,
      gender: data.gender,
      isVerified: data.isVerified,
      registrationId: data.registrationId,
      profilePicture: data.profilePicture,
    };

    return res
      .status(200)
      .json({ message: "Login Success", user, token, statusCode: 200 });
  }

  if (req.body.otpType === "forgot") {
    if (data.forgotCode !== req.body.otp)
      return res.status(400).json({ message: "Incorrect OTP", statusCode: 400 });

    await User.updateOne(
      { _id: data._id },
      { $set: { forgotCode: null } }
    );
    return res
      .status(200)
      .json({ message: "OTP Verified Successfully", statusCode: 200 });
  }
};

const resendOTP = async (req, res) => {
  const { email, phone } = req.body;
  const lowerCaseEmail = email ? email.toLowerCase() : null;

  const filter = phone ? { phone } : { email: lowerCaseEmail };
  const data = await User.findOne(filter);
  if (!data) return res.status(404).json({ message: "User Not Found" });

  const fourDigitOtp = generateOtp(4);
  if (lowerCaseEmail) sendOtpToEmail(fourDigitOtp, lowerCaseEmail, data.name);
  if (phone) sendMessageToWhatsapp(fourDigitOtp, phone);

  if (!data.isVerified) {
    await User.updateOne(
      { _id: data._id },
      {
        $set: {
          otp: fourDigitOtp,
          isVerified: data.isVerified,
          registrationId: data.registrationId,
        },
      }
    );
    return res.status(200).json({ message: "New OTP Sent", statusCode: 200 });
  }

  await User.updateOne(
    { _id: data._id },
    { $set: { forgotCode: fourDigitOtp } }
  );
  return res.status(200).json({ message: "New OTP Sent", statusCode: 200 });
};

const updatePassword = async (req, res) => {
  const { email } = req.body;
  const lowerCaseEmail = email ? email.toLowerCase() : null;

  const data = await User.findOne({
    $or: [{ phone: req.body.phone }, { email: lowerCaseEmail }],
  });

  if (!data) return res.status(404).json({ message: "User Not Found" });
  if (data.forgotCode !== null)
    return res.status(400).json({ message: "Email Not Verified" });

  const passIsValid = bcrypt.compareSync(req.body.password, data.password);
  if (passIsValid)
    return res.status(400).json({
      message: "Password Must Be Different From Previous Password",
    });

  const hassPassword = bcrypt.hashSync(req.body.password, 8);
  await User.updateOne(
    { _id: data._id },
    { $set: { password: hassPassword } }
  );

  res
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



module.exports = { register, login, verifyCode, resendOTP, updatePassword,forgotPassword };
