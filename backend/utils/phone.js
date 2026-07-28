/**
 * Phone number handling for WhatsApp/SMS delivery.
 *
 * The old code did `whatsapp:+91${number}` unconditionally, which produced
 * broken recipients like `whatsapp:+91+919876543210` whenever the stored number
 * already carried a country code.
 */

const DEFAULT_COUNTRY_CODE = process.env.DEFAULT_COUNTRY_CODE || "91";

/**
 * Normalises a number to E.164 (e.g. "+919876543210").
 * Returns null when the input can't plausibly be a phone number.
 */
function toE164(raw) {
  if (!raw) return null;

  const trimmed = String(raw).trim();
  const hadPlus = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");

  if (!digits) return null;

  // Already international: keep as-is.
  if (hadPlus) return `+${digits}`;

  // A bare 10-digit national number gets the default country code.
  if (digits.length === 10) return `+${DEFAULT_COUNTRY_CODE}${digits}`;

  // Already prefixed with the country code but missing the '+'.
  if (digits.startsWith(DEFAULT_COUNTRY_CODE) && digits.length > 10) return `+${digits}`;

  // Anything else is ambiguous — assume it's already international.
  return digits.length >= 8 ? `+${digits}` : null;
}

/** Twilio's WhatsApp channel requires the `whatsapp:` scheme prefix. */
function toWhatsAppAddress(raw) {
  const e164 = toE164(raw);
  return e164 ? `whatsapp:${e164}` : null;
}

module.exports = { toE164, toWhatsAppAddress, DEFAULT_COUNTRY_CODE };
