const PDFDocument = require("pdfkit");
const QRCode = require("qrcode");

/**
 * PDF builders for the three customer documents: event ticket, GST tax
 * invoice, and the Golden Pass membership card. Each returns a Promise<Buffer>
 * so the caller can upload it to S3.
 *
 * Layouts mirror the approved mockups: green→blue→purple brand for tickets,
 * a formal document for invoices, and a charcoal+gold card for the pass.
 */

/* --------------------------------- helpers -------------------------------- */

const BRAND = { green: "#22c55e", blue: "#3b82f6", purple: "#a855f7" };
const INK = "#1a1d24";
const MUTED = "#6b7280";
const LINE = "#e6e8ee";

/** Collects a finished PDFDocument stream into a single Buffer. */
function renderToBuffer(doc) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    doc.on("data", (c) => chunks.push(c));
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
    doc.end();
  });
}

/** PNG buffer for a QR code, dark on white. */
function qrPng(text, size = 320) {
  return QRCode.toBuffer(String(text || ""), {
    margin: 1,
    width: size,
    errorCorrectionLevel: "M",
    color: { dark: "#111318", light: "#ffffff" },
  });
}

/** Indian-grouped currency, e.g. 1234567.5 -> "12,34,567.50". */
function inr(n) {
  const num = Number(n || 0);
  const neg = num < 0;
  const [whole, frac = "00"] = Math.abs(num).toFixed(2).split(".");
  let last3 = whole.slice(-3);
  const rest = whole.slice(0, -3);
  if (rest) last3 = "," + last3;
  const grouped = rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",") + last3;
  return `${neg ? "-" : ""}${grouped}.${frac}`;
}

/** Amount in words (Indian system), e.g. 2230.2 -> "Two thousand ... and twenty paise". */
function inrWords(amount) {
  const ones = ["", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
    "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen",
    "eighteen", "nineteen"];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

  const twoDigit = (n) => (n < 20 ? ones[n] : `${tens[Math.floor(n / 10)]}${n % 10 ? " " + ones[n % 10] : ""}`);
  const threeDigit = (n) => {
    const h = Math.floor(n / 100);
    const r = n % 100;
    return `${h ? ones[h] + " hundred" + (r ? " " : "") : ""}${r ? twoDigit(r) : ""}`;
  };

  const num = Math.floor(Math.abs(Number(amount || 0)));
  const paise = Math.round((Math.abs(Number(amount || 0)) - num) * 100);

  const words = (n) => {
    if (n === 0) return "zero";
    const crore = Math.floor(n / 10000000);
    const lakh = Math.floor((n % 10000000) / 100000);
    const thousand = Math.floor((n % 100000) / 1000);
    const rest = n % 1000;
    let out = "";
    if (crore) out += `${words(crore)} crore `;
    if (lakh) out += `${twoDigit(lakh)} lakh `;
    if (thousand) out += `${twoDigit(thousand)} thousand `;
    if (rest) out += threeDigit(rest);
    return out.trim();
  };

  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  let out = `${cap(words(num))} rupees`;
  if (paise) out += ` and ${twoDigit(paise)} paise`;
  return out + " only";
}

/* ================================= TICKET ================================= */

/**
 * @param {Object} t
 * @param {string} t.qrToken   signed ticket token (goes in the QR)
 */
async function buildTicketPdf(t) {
  const W = 340;
  const doc = new PDFDocument({ size: [W, 560], margin: 0 });
  const png = await qrPng(t.qrToken, 300);

  // Header band with the brand gradient.
  const grad = doc.linearGradient(0, 0, W, 150);
  grad.stop(0, BRAND.green).stop(0.55, BRAND.blue).stop(1, BRAND.purple);
  doc.rect(0, 0, W, 150).fill(grad);

  doc.fillColor("#ffffff").font("Helvetica-Bold").fontSize(11)
    .text("✦  IRL SOCIAL", 24, 26, { characterSpacing: 1.5 });
  doc.fontSize(23).text(t.event?.name || "Event", 24, 52, { width: W - 48 });
  doc.font("Helvetica").fontSize(10).fillColor("#eef2ff")
    .text("Hosted by ThriftyX", 24, doc.y + 2);

  // Body detail rows.
  let y = 172;
  const row = (label, value) => {
    doc.fillColor(MUTED).font("Helvetica").fontSize(8.5)
      .text(String(label).toUpperCase(), 24, y, { characterSpacing: 0.6 });
    doc.fillColor(INK).font("Helvetica-Bold").fontSize(13)
      .text(value || "—", 24, y + 11, { width: W - 48 });
    y += 44;
  };
  const d = t.event?.date ? new Date(t.event.date) : null;
  const dateStr = d
    ? d.toLocaleDateString("en-IN", { weekday: "short", day: "numeric", month: "short", year: "numeric" })
    : "Date to be announced";
  const timeStr = t.event?.startTime ? ` · ${t.event.startTime}` : "";
  row("When", `${dateStr}${timeStr}`);
  row("Where", [t.event?.venue, t.event?.city].filter(Boolean).join(", ") || "Venue TBA");
  row("Ticket", t.ticketLabel || "General");

  // Attendee + booking id, two columns.
  doc.fillColor(MUTED).font("Helvetica").fontSize(8.5).text("ATTENDEE", 24, y);
  doc.fillColor(MUTED).text("BOOKING ID", W / 2 + 6, y);
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(13).text(t.attendee || "—", 24, y + 11, { width: W / 2 - 30 });
  doc.font("Courier-Bold").fontSize(13).text(t.bookingId || "—", W / 2 + 6, y + 11, { width: W / 2 - 30 });
  y += 52;

  // Perforation.
  doc.save();
  doc.circle(0, y, 12).fill("#ffffff");
  doc.circle(W, y, 12).fill("#ffffff");
  doc.restore();
  doc.moveTo(16, y).lineTo(W - 16, y).dash(4, { space: 4 }).strokeColor("#c7ccd6").lineWidth(1.4).stroke().undash();

  // Stub: status pill + QR.
  y += 22;
  const confirmed = t.status === "confirmed";
  const pillText = confirmed ? "● CONFIRMED" : t.status === "checked_in" ? "● CHECKED IN" : "● PENDING";
  const pillColor = confirmed ? "#15803d" : t.status === "checked_in" ? BRAND.blue : "#b45309";
  const pillBg = confirmed ? "#dcfce7" : t.status === "checked_in" ? "#dbeafe" : "#fef3c7";

  doc.fillColor(MUTED).font("Helvetica").fontSize(9).text("SHOW THIS AT ENTRY", 24, y);
  const pw = doc.widthOfString(pillText) + 20;
  doc.roundedRect(24, y + 16, pw, 20, 10).fill(pillBg);
  doc.fillColor(pillColor).font("Helvetica-Bold").fontSize(9).text(pillText, 34, y + 22);

  doc.roundedRect(W - 24 - 96, y, 96, 96, 10).fill("#ffffff").strokeColor(LINE).lineWidth(1).stroke();
  doc.image(png, W - 24 - 96 + 6, y + 6, { width: 84, height: 84 });

  return renderToBuffer(doc);
}

/* ================================ INVOICE ================================ */

async function buildInvoicePdf(v) {
  const doc = new PDFDocument({ size: "A4", margin: 0 });
  const M = 40;
  const W = doc.page.width;
  const contentW = W - M * 2;
  const gstEnabled = v.gstEnabled;
  const title = gstEnabled ? "TAX INVOICE" : "PAYMENT RECEIPT";

  // Top brand hairline.
  const grad = doc.linearGradient(0, 0, W, 6);
  grad.stop(0, BRAND.green).stop(0.55, BRAND.blue).stop(1, BRAND.purple);
  doc.rect(0, 0, W, 6).fill(grad);

  // Seller / title.
  let y = 40;
  doc.fillColor(INK).font("Helvetica-Bold").fontSize(16).text(v.seller.legalName, M, y);
  doc.font("Helvetica").fontSize(9).fillColor(MUTED)
    .text(v.seller.address, M, doc.y + 3, { width: contentW * 0.55 });
  if (gstEnabled) {
    doc.text(`GSTIN: ${v.seller.gstin}  ·  State: ${v.seller.state} (${v.seller.stateCode})`, M, doc.y + 2);
  }

  doc.font("Helvetica-Bold").fontSize(18).fillColor(INK)
    .text(title, W - M - 220, y, { width: 220, align: "right", characterSpacing: 1 });
  const metaTop = y + 26;
  const metaRow = (k, val, yy) => {
    doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(k, W - M - 220, yy, { width: 110, align: "right" });
    doc.font("Courier").fontSize(9).fillColor(INK).text(val, W - M - 110, yy, { width: 110, align: "right" });
  };
  metaRow("Invoice #", v.invoiceNo, metaTop);
  metaRow("Date", v.dateStr, metaTop + 14);
  metaRow("Booking", v.bookingId, metaTop + 28);

  y = 140;
  doc.moveTo(M, y).lineTo(W - M, y).strokeColor(LINE).lineWidth(1).stroke();

  // Bill to / place of supply.
  y += 16;
  doc.font("Helvetica").fontSize(8).fillColor(MUTED).text("BILLED TO", M, y, { characterSpacing: 0.6 });
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(v.buyer.name || "—", M, y + 12);
  if (v.buyer.email) doc.font("Helvetica").fontSize(9).fillColor(MUTED).text(v.buyer.email, M, doc.y + 1);

  doc.font("Helvetica").fontSize(8).fillColor(MUTED)
    .text("PLACE OF SUPPLY", W - M - 200, y, { width: 200, align: "right", characterSpacing: 0.6 });
  doc.font("Helvetica-Bold").fontSize(11).fillColor(INK)
    .text(`${v.placeOfSupplyState || "—"}${v.placeOfSupplyCode ? ` (${v.placeOfSupplyCode})` : ""}`,
      W - M - 200, y + 12, { width: 200, align: "right" });
  if (gstEnabled) {
    doc.font("Helvetica").fontSize(8).fillColor(MUTED)
      .text(v.tax.intra ? "Intra-state → CGST + SGST" : "Inter-state → IGST",
        W - M - 200, doc.y + 1, { width: 200, align: "right" });
  }

  // Items table.
  y += 54;
  const cols = gstEnabled
    ? { desc: M, sac: M + 250, qty: M + 320, rate: M + 380, amt: W - M - 90 }
    : { desc: M, sac: null, qty: M + 320, rate: M + 380, amt: W - M - 90 };
  const th = (txt, x, w, align) => doc.font("Helvetica-Bold").fontSize(8).fillColor(MUTED)
    .text(txt.toUpperCase(), x, y, { width: w, align, characterSpacing: 0.5 });
  th("Description", cols.desc, 240, "left");
  if (gstEnabled) th("SAC", cols.sac, 60, "left");
  th("Qty", cols.qty, 50, "right");
  th("Rate", cols.rate, 70, "right");
  th("Amount", cols.amt, 90, "right");
  y += 14;
  doc.moveTo(M, y).lineTo(W - M, y).strokeColor("#c7ccd6").lineWidth(1.2).stroke();
  y += 8;

  v.lineItems.forEach((it) => {
    doc.font("Helvetica-Bold").fontSize(10).fillColor(INK).text(it.desc, cols.desc, y, { width: 240 });
    if (gstEnabled) doc.font("Courier").fontSize(9).fillColor(MUTED).text(it.sac || "—", cols.sac, y, { width: 60 });
    doc.font("Courier").fontSize(10).fillColor(INK).text(String(it.qty), cols.qty, y, { width: 50, align: "right" });
    doc.text(inr(it.rate), cols.rate, y, { width: 70, align: "right" });
    doc.text(inr(it.amount), cols.amt, y, { width: 90, align: "right" });
    y += 24;
    doc.moveTo(M, y - 6).lineTo(W - M, y - 6).strokeColor(LINE).lineWidth(0.7).stroke();
  });

  // Totals block (right aligned).
  y += 8;
  const tx = W - M - 240;
  const tRow = (label, val, opts = {}) => {
    doc.font(opts.bold ? "Helvetica-Bold" : "Helvetica").fontSize(opts.big ? 14 : 10)
      .fillColor(opts.color || INK).text(label, tx, y, { width: 150 });
    doc.font(opts.bold ? "Courier-Bold" : "Courier").fontSize(opts.big ? 14 : 10)
      .fillColor(opts.color || INK).text(val, tx + 130, y, { width: 110, align: "right" });
    y += opts.big ? 22 : 17;
  };
  tRow("Subtotal", inr(v.subtotal));
  if (gstEnabled) {
    if (v.tax.intra) {
      tRow(`CGST @ ${v.tax.cgst.rate}%`, inr(v.tax.cgst.amount));
      tRow(`SGST @ ${v.tax.sgst.rate}%`, inr(v.tax.sgst.amount));
    } else {
      tRow(`IGST @ ${v.tax.igst.rate}%`, inr(v.tax.igst.amount));
    }
  }
  if (v.discount && v.discount.amount > 0) {
    tRow(`Coupon ${v.discount.code || ""}`.trim(), `- ${inr(v.discount.amount)}`, { color: "#15803d" });
  }
  doc.moveTo(tx, y + 2).lineTo(W - M, y + 2).strokeColor(INK).lineWidth(1.4).stroke();
  y += 10;
  tRow("Total", `${inr(v.grandTotal)}`, { bold: true, big: true });

  // Amount in words + tax base footnote.
  y += 6;
  doc.font("Helvetica").fontSize(9).fillColor(MUTED)
    .text(`Amount in words: `, M, y, { continued: true })
    .font("Helvetica-Bold").fillColor(INK).text(inrWords(v.grandTotal), { width: contentW });
  if (gstEnabled) {
    doc.font("Helvetica").fontSize(8).fillColor(MUTED)
      .text(`GST charged on taxable value of ${inr(v.taxableValue)} (event admission). Platform fee is a facilitation charge.`,
        M, doc.y + 4, { width: contentW });
  }

  // Footer.
  const fy = doc.page.height - 90;
  doc.font("Helvetica").fontSize(8).fillColor(MUTED)
    .text(
      gstEnabled
        ? "This is a computer-generated invoice and does not require a physical signature. Interstate bookings are billed IGST in place of CGST + SGST."
        : "This is a computer-generated receipt and does not require a physical signature.",
      M, fy, { width: contentW * 0.6 }
    );
  doc.moveTo(W - M - 150, fy + 24).lineTo(W - M, fy + 24).strokeColor("#c7ccd6").stroke();
  doc.text(`For ${v.seller.tradeName}`, W - M - 150, fy + 28, { width: 150, align: "center" });

  return renderToBuffer(doc);
}

/* ================================== PASS ================================= */

async function buildPassPdf(p) {
  const W = 380, H = 240;
  const doc = new PDFDocument({ size: [W, H], margin: 0 });
  const png = await qrPng(p.qrText, 220);

  // Charcoal ground with a warm corner glow.
  doc.rect(0, 0, W, H).fill("#17140f");
  const glow = doc.radialGradient(W * 0.85, 0, 10, W * 0.85, 0, 260);
  glow.stop(0, "#4a3f22").stop(1, "#17140f");
  doc.rect(0, 0, W, H).fill(glow);
  doc.roundedRect(3, 3, W - 6, H - 6, 18).lineWidth(1).strokeColor("#6b5a2a").stroke();

  const GOLD = "#e7c96b";
  const GOLD_SOFT = "#cbb98a";

  // Header.
  doc.fillColor(GOLD).font("Helvetica-Bold").fontSize(10)
    .text("GOLDEN PASS", 24, 22, { characterSpacing: 3 });
  doc.fillColor("#fbf5e4").fontSize(20).text(p.tierLabel || "30 Events · 1 Year", 24, 36);
  doc.fillColor(GOLD).fontSize(20).text("✦", W - 44, 22);

  // Usage meter.
  const used = Number(p.eventsUsed || 0);
  const total = Number(p.eventsTotal || 30);
  const remaining = Math.max(0, total - used);
  const my = 78;
  doc.fillColor(GOLD_SOFT).font("Helvetica").fontSize(8)
    .text("EVENTS", 24, my, { characterSpacing: 1 });
  doc.fillColor("#fbf5e4").font("Helvetica-Bold").fontSize(8)
    .text(`${remaining} OF ${total} REMAINING · ANY CITY`, 24, my, { width: W - 48, align: "right" });
  const barW = W - 48;
  doc.roundedRect(24, my + 14, barW, 7, 4).fill("#3a3527");
  const frac = total ? remaining / total : 0;
  if (frac > 0) {
    const fillW = Math.max(6, barW * frac);
    const g = doc.linearGradient(24, 0, 24 + fillW, 0);
    g.stop(0, "#a9821f").stop(1, GOLD);
    doc.roundedRect(24, my + 14, fillW, 7, 4).fill(g);
  }

  // Member + QR.
  const cy = 120;
  doc.fillColor(GOLD_SOFT).font("Helvetica").fontSize(8).text("MEMBER", 24, cy, { characterSpacing: 1.4 });
  doc.fillColor("#fbf5e4").font("Helvetica-Bold").fontSize(16).text((p.name || "—").toUpperCase(), 24, cy + 11);
  doc.fillColor("#e7dcbf").font("Helvetica").fontSize(10).text(`City · ${p.city || "—"}`, 24, cy + 32);

  doc.roundedRect(W - 24 - 68, cy - 2, 68, 68, 8).fill("#ffffff");
  doc.image(png, W - 24 - 68 + 5, cy + 3, { width: 58, height: 58 });

  // Bottom: member id + valid through.
  const by = H - 42;
  doc.fillColor(GOLD_SOFT).font("Helvetica").fontSize(7).text("MEMBER ID", 24, by, { characterSpacing: 1.2 });
  doc.fillColor("#fbf5e4").font("Courier-Bold").fontSize(11).text(p.memberId || "—", 24, by + 9);
  doc.fillColor(GOLD_SOFT).font("Helvetica").fontSize(7)
    .text("VALID THROUGH", W - 24 - 140, by, { width: 140, align: "right", characterSpacing: 1.2 });
  doc.fillColor("#fbf5e4").font("Courier-Bold").fontSize(11)
    .text(p.validThrough || "—", W - 24 - 140, by + 9, { width: 140, align: "right" });

  return renderToBuffer(doc);
}

module.exports = { buildTicketPdf, buildInvoicePdf, buildPassPdf, inr, inrWords };
