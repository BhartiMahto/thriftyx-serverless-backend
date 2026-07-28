const nodemailer = require("nodemailer");

/**
 * SMTP credentials were hardcoded here and committed to git; they now come from
 * the environment. Shares the same config as utils/otp.js.
 */
let transporter;
const getTransporter = () => {
  if (transporter) return transporter;

  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 587,
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });

  return transporter;
};

const sendMail = async (to, subject, message) => {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    throw new Error("SMTP is not configured (SMTP_HOST / SMTP_USER)");
  }

  await getTransporter().sendMail({
    from: process.env.MAIL_FROM || '"Thrifty X" <no-reply@thriftyx.com>',
    to,
    subject,
    text: message,
  });

  console.log(`Email sent to ${to}`);
};

module.exports = sendMail;
