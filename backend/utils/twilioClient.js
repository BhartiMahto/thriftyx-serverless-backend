const twilio = require("twilio");

/**
 * Single shared Twilio client.
 *
 * Credentials previously sat hardcoded in utils/otp.js AND utils/sendMessage.js
 * (two separate clients, same plaintext secrets, both committed to git).
 * They now come from the environment only.
 */

const {
  TWILIO_ACCOUNT_SID,
  TWILIO_AUTH_TOKEN,
  TWILIO_MESSAGING_SERVICE_SID,
  TWILIO_WHATSAPP_OTP_TEMPLATE_SID,
  TWILIO_SMS_FROM,
  TWILIO_WHATSAPP_FROM,
} = process.env;

const isConfigured = Boolean(TWILIO_ACCOUNT_SID && TWILIO_AUTH_TOKEN);

if (!isConfigured) {
  console.warn(
    "[twilio] TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN are not set — WhatsApp and SMS delivery is disabled."
  );
}

const client = isConfigured ? twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN) : null;

module.exports = {
  client,
  isConfigured,
  messagingServiceSid: TWILIO_MESSAGING_SERVICE_SID,
  whatsappOtpTemplateSid: TWILIO_WHATSAPP_OTP_TEMPLATE_SID,
  smsFrom: TWILIO_SMS_FROM,
  // Business WhatsApp sender number (E.164, no "whatsapp:" prefix). Optional —
  // when set, the inbox can fetch inbound replies precisely by filtering on
  // `to` = this number instead of scanning all recent messages.
  whatsappFrom: TWILIO_WHATSAPP_FROM,
};
