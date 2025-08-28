const nodemailer = require("nodemailer");

const sendMail = async (to, subject, message) => {
  try {
    const transporter = nodemailer.createTransport({
      host: "live.smtp.mailtrap.io",
      port: 587,
      secure: false,
      auth: {
        user: "api",
        pass: "558f6b5336ec2cf46825fe6e9baec965",
      },
    });

    await transporter.sendMail({
      from: '"Thrifty X" <no-reply@thriftyx.com>',
      to,
      subject,
      text: message,
    });

    console.log(`Email sent to ${to}`);
  } catch (error) {
    console.error(`Failed to send email to ${to}:`, error);
  }
};

module.exports = sendMail;
