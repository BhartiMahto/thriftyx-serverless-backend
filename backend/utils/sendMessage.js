const { toE164, toWhatsAppAddress } = require("./phone");
const {
  client,
  isConfigured,
  messagingServiceSid,
  whatsappOtpTemplateSid,
  smsFrom,
} = require("./twilioClient");

/**
 * WhatsApp / SMS delivery via Twilio.
 *
 * Previously this file created its own Twilio client with the credentials
 * hardcoded (duplicated from utils/otp.js). It now shares utils/twilioClient.js
 * and reads everything from the environment.
 */

const sendWhatsapp = async (phone, message) => {
  if (!isConfigured) {
    throw new Error("Twilio is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)");
  }

  const to = toWhatsAppAddress(phone);
  if (!to) {
    throw new Error(`"${phone}" is not a usable phone number`);
  }

  const payload = { to, contentVariables: JSON.stringify({ 1: message }) };
  if (whatsappOtpTemplateSid) payload.contentSid = whatsappOtpTemplateSid;
  if (messagingServiceSid) payload.messagingServiceSid = messagingServiceSid;

  const instance = await client.messages.create(payload);
  console.log(`WhatsApp message sent to ${to}: SID ${instance.sid}`);
  return instance.sid;
};

/**
 * Sends an approved WhatsApp *template* (Content SID) — required for
 * business-initiated marketing messages. `variables` maps template placeholders
 * ({{1}}, {{2}}…) to values, e.g. { "1": "Priya" }. Throws on failure so the
 * caller can record per-recipient status.
 */
const sendWhatsappTemplate = async (phone, contentSid, variables = {}) => {
  if (!isConfigured) throw new Error("Twilio is not configured");
  if (!contentSid) throw new Error("No WhatsApp template Content SID configured");
  const to = toWhatsAppAddress(phone);
  if (!to) throw new Error(`"${phone}" is not a usable phone number`);

  const payload = { to, contentSid, contentVariables: JSON.stringify(variables) };
  if (messagingServiceSid) payload.messagingServiceSid = messagingServiceSid;

  const instance = await client.messages.create(payload);
  return instance.sid;
};

const sendSMS = async (phone, message) => {
  if (!isConfigured) {
    throw new Error("Twilio is not configured (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN)");
  }

  // The previous implementation referenced an undefined `fromPhone`, so every
  // call threw a ReferenceError that the catch block then swallowed.
  if (!smsFrom && !messagingServiceSid) {
    throw new Error("Set TWILIO_SMS_FROM or TWILIO_MESSAGING_SERVICE_SID to send SMS");
  }

  const to = toE164(phone);
  if (!to) {
    throw new Error(`"${phone}" is not a usable phone number`);
  }

  const payload = { body: message, to };
  if (smsFrom) payload.from = smsFrom;
  else payload.messagingServiceSid = messagingServiceSid;

  const instance = await client.messages.create(payload);
  console.log(`SMS sent to ${to}: SID ${instance.sid}`);
  return instance.sid;
};

module.exports = { sendWhatsapp, sendWhatsappTemplate, sendSMS };
