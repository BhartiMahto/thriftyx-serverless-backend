const crypto = require('crypto');
const nodemailer = require('nodemailer');
const { capitalizeText } = require('./capitalizeText');
const { toWhatsAppAddress } = require('./phone');
const {
    client,
    isConfigured,
    messagingServiceSid,
    whatsappOtpTemplateSid,
} = require('./twilioClient');

/**
 * OTP generation and delivery.
 *
 * Twilio credentials, the Mailtrap SMTP password, and the Textlocal API key
 * were all hardcoded in this file and committed to git. They now come from the
 * environment. The Textlocal SMS path was dead placeholder code ("thank you for
 * sending your first test message from Textlocal") and has been removed —
 * SMS goes through Twilio in utils/sendMessage.js.
 */

/** Cryptographically random OTP — Math.random() is predictable and unsuitable here. */
const generateOtp = (otpLength) => {
    let otp = "";
    for (let i = 0; i < otpLength; i++) {
        otp += crypto.randomInt(0, 10).toString();
    }
    return otp;
};

let transporter;
const getTransporter = () => {
    if (transporter) return transporter;

    transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST,
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
            user: process.env.SMTP_USER,
            pass: process.env.SMTP_PASS,
        },
    });

    return transporter;
};

/**
 * Sends an OTP by email. Resolves on success, rejects on failure — the previous
 * version used a callback and swallowed errors, so callers reported "OTP sent"
 * even when nothing was delivered.
 */
const sendOtpToEmail = async (otp, email, name) => {
    if (!process.env.SMTP_HOST || !process.env.SMTP_USER) {
        throw new Error('SMTP is not configured (SMTP_HOST / SMTP_USER)');
    }

    const message = `Dear ${capitalizeText(name || 'there')},\n\nYour ThriftyX OTP is ${otp}. Do not share this OTP with anyone.\n\nThanks,\nTeam Thrifty X`;

    await getTransporter().sendMail({
        from: process.env.MAIL_FROM || 'ThriftyX <no-reply@thriftyx.com>',
        to: email,
        subject: 'ThriftyX OTP',
        text: message,
    });
};

/** Sends an OTP over WhatsApp via Twilio. Rejects if delivery fails. */
const sendMessageToWhatsapp = async (otp, number) => {
    if (!isConfigured) {
        throw new Error('Twilio is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)');
    }

    const to = toWhatsAppAddress(number);
    if (!to) {
        throw new Error(`Cannot send WhatsApp OTP: "${number}" is not a usable phone number`);
    }

    const payload = {
        to,
        contentVariables: JSON.stringify({ 1: otp }),
    };

    if (whatsappOtpTemplateSid) payload.contentSid = whatsappOtpTemplateSid;
    if (messagingServiceSid) payload.messagingServiceSid = messagingServiceSid;

    const message = await client.messages.create(payload);
    return message.sid;
};

module.exports = {
    generateOtp,
    sendOtpToEmail,
    sendMessageToWhatsapp,
};
