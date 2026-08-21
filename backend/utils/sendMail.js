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

/**
 * @param {string} to
 * @param {string} subject
 * @param {string} message  plain-text body
 * @param {Array<{filename:string,path:string}>} [attachments]  files to attach;
 *        `path` may be a public URL (nodemailer streams it) — used for the
 *        ticket/invoice PDFs on their S3 URLs.
 */
const sendMail = async (to, subject, message, attachments) => {
  if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
    throw new Error("SMTP is not configured (SMTP_HOST / SMTP_USER)");
  }

  const mail = {
    from: process.env.MAIL_FROM || '"Thrifty X" <no-reply@thriftyx.com>',
    to,
    subject,
    text: message,
  };
  if (Array.isArray(attachments) && attachments.length) mail.attachments = attachments;

  await getTransporter().sendMail(mail);

  console.log(`Email sent to ${to}${mail.attachments ? ` (+${mail.attachments.length} attachment)` : ""}`);
};

module.exports = sendMail;
