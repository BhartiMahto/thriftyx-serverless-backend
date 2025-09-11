const User = require("../models/userModel");
const { sendWhatsapp, sendSMS } = require("../utils/sendMessage");
const MessageHistory = require("../models/messageHistoryModel")
const sendMail = require("../utils/sendMail");
const nodemailer = require("nodemailer");

const getAllUsers = async (req, res) => {
  try {
    const users = await User.find();
    res.status(200).json(users);
  } catch (error) {
    res.status(400).json({
      message: error.message,
    });
  }
};

const sendReviewLink = async (req, res) => {
  try {
    const { userIds } = req.body;

    if (!userIds || !Array.isArray(userIds) || userIds.length === 0) {
      return res.status(400).json({ message: "No user IDs provided" });
    }

    const users = await User.find({ _id: { $in: userIds } });

    if (users.length === 0) {
      return res.status(404).json({ message: "Users not found" });
    }

    const transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    for (const user of users) {
      const reviewLink = `https://thriftyx.com/submit-review/${user._id}`;

      const mailOptions = {
        from: '"ThriftyX Reviews" <no-reply@thriftyx.com>',
        to: user.email,
        subject: "We value your feedback!",
        html: `
          <p>Hi ${user.name},</p>
          <p>Please take a moment to leave us a review by clicking the link below:</p>
          <a href="${reviewLink}">${reviewLink}</a>
          <p>Thank you!</p>
        `,
      };

      await transporter.sendMail(mailOptions);
    }

    return res.status(200).json({ message: "Review links sent successfully." });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ message: "Failed to send review links" });
  }
};

const sendWhatsappMessage = async (req, res) => {
  const { users, message } = req.body;

  try {
    for (const user of users) {
      await sendWhatsapp(user.phone, message);
    }

    await MessageHistory.create({
      type: "whatsapp",
      recipients: users.map(u => u.phone),
      message,
      status: "success"
    });

    return res.json({ success: true, message: "WhatsApp messages sent successfully" });
  } catch (error) {
    console.error("Error sending WhatsApp messages:", error);

    await MessageHistory.create({
      type: "whatsapp",
      recipients: users.map(u => u.phone),
      message,
      status: "failed"
    });

    return res.status(500).json({ message: "Error sending WhatsApp messages" });
  }
};

const sendSms = async (req, res) => {
  const { users, message } = req.body;

  try {
    for (const user of users) {
      await sendSMS(user.phone, message);
    }

    await MessageHistory.create({
      type: "sms",
      recipients: users.map(u => u.phone),
      message,
      status: "success"
    });

    return res.json({ success: true, message: "SMS sent successfully" });
  } catch (error) {
    console.error("Error sending SMS:", error);

    await MessageHistory.create({
      type: "sms",
      recipients: users.map(u => u.phone),
      message,
      status: "failed"
    });

    return res.status(500).json({ message: "Error sending SMS" });
  }
};

const sendEmail = async (req, res) => {
  const { users, subject, message } = req.body;

  try {
    for (const user of users) {
      await sendMail(user.email, subject, message);
    }

    await MessageHistory.create({
      type: "email",
      recipients: users.map(u => u.email),
      subject,
      message,
      status: "success"
    });

    return res.json({ success: true, message: "Emails sent successfully" });
  } catch (error) {
    console.error("Error sending mails:", error);

    await MessageHistory.create({
      type: "email",
      recipients: users.map(u => u.email),
      subject,
      message,
      status: "failed"
    });

    return res.status(500).json({ message: "Error sending mails" });
  }
};

const getHistory = async (req, res) => {
  try {
    const history = await MessageHistory.find().sort({ createdAt: -1 });
    return res.json({ success: true, history });
  } catch (error) {
    console.error("Error fetching history:", error);
    return res.status(500).json({ message: "Error fetching history" });
  }
};

module.exports = { sendWhatsappMessage, sendSms, sendEmail, getHistory };


module.exports = {
  getAllUsers,
  sendReviewLink,
  sendWhatsappMessage,
  sendSms,
  sendEmail,
  getHistory
};
