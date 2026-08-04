const s3 = require("./s3");
const Counter = require("../models/counterModel");
const { buildTicketPdf, buildInvoicePdf } = require("./pdf");
const { signTicket } = require("./ticketToken");
const { gstConfig, financialYear, splitGstAmount, stateForCity } = require("../config/gst");

/**
 * Lazy generation of the two order documents (ticket + invoice).
 *
 * Both are idempotent: if the URL already exists on the order they return it
 * unchanged. They never throw into the payment path — an S3 or render failure
 * is logged and returns null so the customer's payment/confirmation still
 * succeeds; the document is retried next time the customer opens it.
 */

/**
 * The list of people on an order, one per ticket. Uses the `attendees` array
 * when present; otherwise falls back to the single `attendee_details` (older
 * orders / single-ticket bookings) so every code path has at least one.
 */
function attendeesOf(order) {
  if (Array.isArray(order.attendees) && order.attendees.length) return order.attendees;
  if (order.attendee_details && order.attendee_details.name) return [order.attendee_details];
  return [{ name: null }];
}

/** Human ticket label from the order's ticket lines, e.g. "Premium · Qty 2". */
function ticketLabel(order) {
  const lines = Array.isArray(order.tickets) ? order.tickets : [];
  if (!lines.length) return "General";
  return lines
    .map((t) => {
      const qty = t.count ?? t.quantity ?? t.qty;
      return `${t.name || "Ticket"}${qty ? ` · Qty ${qty}` : ""}`;
    })
    .join(", ");
}

/**
 * Generates + stores the event ticket PDF once the booking is paid AND
 * confirmed. Returns the S3 URL, or null if not eligible / storage unavailable.
 */
async function ensureTicket(order) {
  if (order.ticket_url) return order.ticket_url;
  if (order.status === "cancelled") return null;

  const paid = order.status === "completed";
  const confirmed = order.applicationStatus === "confirmed";
  if (!paid || !confirmed) return null;
  if (!s3.isConfigured) return null;

  if (!order.populated || !order.event_id?.name) {
    await order.populate("event_id", "name date start_time venue venue_name city locations");
  }
  const event = order.event_id || {};

  // For a multi-city event, show the venue/city the booking is actually for.
  let venueName = event.venue_name || event.venue;
  let cityName = event.city;
  if (order.event_city && Array.isArray(event.locations)) {
    const loc = event.locations.find(
      (l) => (l.city || "").trim().toLowerCase() === order.event_city.trim().toLowerCase()
    );
    if (loc) { venueName = loc.venue || venueName; cityName = loc.city || cityName; }
  }

  // One ticket page per attendee. Fall back to the single booker for older
  // (pre-multi-attendee) orders that only have attendee_details.
  const people = attendeesOf(order);
  const attendees = people.map((p, i) => ({
    name: p.name || null,
    qrToken: signTicket(order, event.date, i),
    status: p.checkedIn ? "checked_in" : "confirmed",
  }));

  const buffer = await buildTicketPdf({
    attendees,
    event: {
      name: event.name,
      date: event.date,
      startTime: event.start_time,
      venue: venueName,
      city: cityName,
    },
    ticketLabel: ticketLabel(order),
    bookingId: order.order_id || String(order._id).slice(-8).toUpperCase(),
    status: order.checkedIn ? "checked_in" : "confirmed",
  });

  const { url } = await s3.uploadBuffer(buffer, {
    originalName: `ticket-${order.order_id || order._id}.pdf`,
    mimetype: "application/pdf",
    prefix: "tickets/",
  });

  order.ticket_url = url;
  await order.save();
  return url;
}

/**
 * Generates + stores the GST tax invoice once the booking is paid. Skips
 * zero-value (pass-covered) bookings. Allocates a gap-free invoice number.
 */
async function ensureInvoice(order) {
  if (order.invoice_url) return order.invoice_url;
  if (order.status !== "completed") return null;
  if ((order.grand_total ?? 0) <= 0 || order.paidByPass) return null; // nothing to tax
  if (!s3.isConfigured) return null;

  if (!order.event_id?.name) {
    await order.populate("event_id", "name city");
  }
  let user = null;
  if (!order.attendee_details?.name || !order.attendee_details?.email) {
    await order.populate("user_id", "name email city");
    user = order.user_id;
  }
  const event = order.event_id || {};
  const details = order.attendee_details || {};

  // Allocate the invoice number once (atomic per financial year).
  if (!order.invoice_no) {
    const fy = financialYear(new Date());
    const seq = await Counter.next(`invoice:${fy}`);
    order.invoice_no = `${gstConfig.invoicePrefix}/${fy}/${String(seq).padStart(5, "0")}`;
    order.invoiced_at = new Date();
  }

  const subtotalItems = Math.round(((order.total_price || 0) + (order.booking_fee || 0)) * 100) / 100;
  const pos = stateForCity(event.city);
  const tax = splitGstAmount(order.gst || 0, pos.code);

  const lineItems = [
    {
      desc: `${event.name || "Event"} — admission`,
      sac: gstConfig.sac.event,
      qty: 1,
      rate: order.total_price || 0,
      amount: order.total_price || 0,
    },
  ];
  if ((order.booking_fee || 0) > 0) {
    lineItems.push({
      desc: "Platform fee (5%)",
      sac: gstConfig.sac.platformFee,
      qty: 1,
      rate: order.booking_fee,
      amount: order.booking_fee,
    });
  }

  const buffer = await buildInvoicePdf({
    gstEnabled: gstConfig.enabled,
    seller: gstConfig.seller,
    invoiceNo: order.invoice_no,
    dateStr: (order.invoiced_at || new Date()).toLocaleDateString("en-IN", {
      day: "numeric", month: "short", year: "numeric",
    }),
    bookingId: order.order_id || String(order._id).slice(-8).toUpperCase(),
    buyer: {
      name: details.name || user?.name || "Customer",
      email: details.email || user?.email || null,
    },
    placeOfSupplyState: pos.state,
    placeOfSupplyCode: pos.code,
    lineItems,
    subtotal: subtotalItems,
    taxableValue: order.total_price || 0,
    tax,
    discount: { code: order.coupon_code, amount: order.discount || 0 },
    grandTotal: order.grand_total || 0,
  });

  const { url } = await s3.uploadBuffer(buffer, {
    originalName: `invoice-${order.order_id || order._id}.pdf`,
    mimetype: "application/pdf",
    prefix: "invoices/",
  });

  order.invoice_url = url;
  await order.save();
  return url;
}

module.exports = { ensureTicket, ensureInvoice, ticketLabel, attendeesOf };
