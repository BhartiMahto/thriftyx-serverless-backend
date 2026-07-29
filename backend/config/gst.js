/**
 * GST / seller configuration for tax invoices.
 *
 * Everything here comes from the environment so the real, legally-binding
 * values live only in `.env` (never committed). The defaults are OBVIOUS
 * placeholders — a valid Indian tax invoice requires your registered legal
 * name, GSTIN, address and state, plus confirmed SAC codes.
 *
 * `GST_ENABLED=true` turns the "Tax Invoice" wording + CGST/SGST/IGST split on.
 * While it's false the same document renders as a plain "Payment Receipt".
 */

const gstConfig = {
  enabled: String(process.env.GST_ENABLED || "").toLowerCase() === "true",

  seller: {
    legalName: process.env.SELLER_LEGAL_NAME || "IRL Social Hive (Legal Entity Pvt Ltd)",
    tradeName: process.env.SELLER_TRADE_NAME || "IRL Social Hive",
    gstin: process.env.SELLER_GSTIN || "29ABCDE1234F1Z5", // placeholder
    address:
      process.env.SELLER_ADDRESS ||
      "91 Residency Road, Bengaluru, Karnataka 560025",
    state: process.env.SELLER_STATE || "Karnataka",
    // Two-digit GST state code (Karnataka = 29). Drives intra vs inter-state.
    stateCode: process.env.SELLER_STATE_CODE || "29",
    email: process.env.SELLER_EMAIL || process.env.SMTP_FROM || "hello@irlsocial.in",
  },

  // Recreational / event admission services. Confirm with your accountant.
  sac: {
    event: process.env.SAC_EVENT || "998554",
    platformFee: process.env.SAC_PLATFORM_FEE || "998559",
  },

  // Combined GST rate (%). Split half/half into CGST + SGST for intra-state.
  rate: Number(process.env.GST_RATE || 18),

  // Invoice number format: <prefix>/<FY>/<zero-padded seq>
  invoicePrefix: process.env.INVOICE_PREFIX || "INV",
};

/** Indian financial year label for a date, e.g. 2026-07-27 -> "2026-27". */
function financialYear(date = new Date()) {
  const y = date.getFullYear();
  const m = date.getMonth(); // 0 = Jan
  // FY runs Apr–Mar. Before April, we're still in the previous FY.
  const startYear = m >= 3 ? y : y - 1;
  const endYY = String((startYear + 1) % 100).padStart(2, "0");
  return `${startYear}-${endYY}`;
}

/**
 * Splits a combined GST amount into the correct heads.
 * Intra-state (buyer state code === seller) -> CGST + SGST (half each).
 * Inter-state -> a single IGST line.
 */
function taxBreakup(taxableValue, buyerStateCode) {
  return splitGstAmount(Math.round(taxableValue * gstConfig.rate) / 100, buyerStateCode);
}

/**
 * Splits an ALREADY-CHARGED GST amount into heads, so the invoice reconciles
 * exactly with what the customer paid (the app charges GST at cart time; we
 * never recompute it here and risk a rounding mismatch with grand_total).
 */
function splitGstAmount(gstAmount, buyerStateCode) {
  const rate = gstConfig.rate;
  const total = Math.round(Number(gstAmount || 0) * 100) / 100;
  const intra = !buyerStateCode || String(buyerStateCode) === gstConfig.seller.stateCode;

  if (intra) {
    const half = Math.round((total / 2) * 100) / 100;
    return {
      intra: true,
      cgst: { rate: rate / 2, amount: half },
      sgst: { rate: rate / 2, amount: Math.round((total - half) * 100) / 100 },
      igst: null,
      total,
    };
  }
  return { intra: false, cgst: null, sgst: null, igst: { rate, amount: total }, total };
}

/**
 * Place of supply for admission to an event is where the event is held
 * (GST s.12(4)). We only store a city, so this maps the common metros to their
 * state + GST state code; anything unknown falls back to the seller's state
 * (treated as intra-state).
 */
const CITY_STATE = {
  bengaluru: ["Karnataka", "29"], bangalore: ["Karnataka", "29"], mysuru: ["Karnataka", "29"],
  mumbai: ["Maharashtra", "27"], pune: ["Maharashtra", "27"], nagpur: ["Maharashtra", "27"],
  delhi: ["Delhi", "07"], "new delhi": ["Delhi", "07"],
  gurugram: ["Haryana", "06"], gurgaon: ["Haryana", "06"], faridabad: ["Haryana", "06"],
  noida: ["Uttar Pradesh", "09"], lucknow: ["Uttar Pradesh", "09"],
  hyderabad: ["Telangana", "36"], secunderabad: ["Telangana", "36"],
  chennai: ["Tamil Nadu", "33"], coimbatore: ["Tamil Nadu", "33"],
  kolkata: ["West Bengal", "19"],
  ahmedabad: ["Gujarat", "24"], surat: ["Gujarat", "24"], vadodara: ["Gujarat", "24"],
  jaipur: ["Rajasthan", "08"], chandigarh: ["Chandigarh", "04"],
  kochi: ["Kerala", "32"], thiruvananthapuram: ["Kerala", "32"],
  indore: ["Madhya Pradesh", "23"], bhopal: ["Madhya Pradesh", "23"],
  goa: ["Goa", "30"], panaji: ["Goa", "30"],
};

function stateForCity(city) {
  const hit = city && CITY_STATE[String(city).trim().toLowerCase()];
  if (hit) return { state: hit[0], code: hit[1] };
  return { state: gstConfig.seller.state, code: gstConfig.seller.stateCode };
}

module.exports = { gstConfig, financialYear, taxBreakup, splitGstAmount, stateForCity };
