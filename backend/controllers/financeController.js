const FinanceEntry = require("../models/financeEntryModel");
const Order = require("../models/orderModel");

/**
 * Financial Insights — a full P&L, not just website revenue.
 *
 *  - Website booking revenue: computed live from PAID, non-refunded orders.
 *  - Manual income (direct payments, Discord, sponsorships, pre-launch history)
 *    and ALL expenses: stored as FinanceEntry rows (added one-by-one or bulk CSV).
 *
 * The summary merges both into income vs expense vs net, by month and category.
 */

const PAID = "completed";
const NOT_REFUNDED = { "refund.id": null };

const round2 = (n) => Math.round((Number(n) || 0) * 100) / 100;
const monthKey = { $dateToString: { format: "%Y-%m", date: "$date" } };

/** Parses ?from/?to. Defaults to all time (finance includes pre-launch history). */
const parseRange = (query) => {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date("2000-01-01");
  from.setHours(0, 0, 0, 0);
  to.setHours(23, 59, 59, 999);
  const valid = !Number.isNaN(from.getTime()) && !Number.isNaN(to.getTime()) && from <= to;
  return { from, to, valid };
};

const paging = (query) => {
  const limit = Math.min(Math.max(Number(query.limit) || 50, 1), 500);
  const page = Math.max(Number(query.page) || 1, 1);
  return { limit, page, skip: (page - 1) * limit };
};

/* ------------------------------ Entry CRUD ------------------------------ */

/** Validate + normalise one entry from the client (form or CSV row). */
const cleanEntry = (b, adminId) => {
  const kind = b.kind === "expense" ? "expense" : b.kind === "income" ? "income" : null;
  const amount = Number(b.amount);
  const date = b.date ? new Date(b.date) : null;
  if (!kind) return { error: "kind must be 'income' or 'expense'" };
  if (!Number.isFinite(amount) || amount < 0) return { error: "amount must be a positive number" };
  if (!date || Number.isNaN(date.getTime())) return { error: "a valid date is required" };
  return {
    doc: {
      kind,
      amount: round2(amount),
      date,
      category: String(b.category || "Other").trim() || "Other",
      method: String(b.method || "").trim(),
      note: String(b.note || "").trim(),
      reference: String(b.reference || "").trim(),
      city: String(b.city || "").trim(),
      source: b.source === "csv-import" ? "csv-import" : "manual",
      reconciled: b.reconciled === true,
      bankRef: String(b.bankRef || "").trim(),
      createdByAdmin: adminId || null,
    },
  };
};

const listEntries = async (req, res) => {
  try {
    const { from, to } = parseRange(req.query);
    const { limit, page, skip } = paging(req.query);
    const filter = { date: { $gte: from, $lte: to } };
    if (req.query.kind === "income" || req.query.kind === "expense") filter.kind = req.query.kind;
    if (req.query.category) filter.category = new RegExp(`^${String(req.query.category).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i");

    const [rows, total, totals] = await Promise.all([
      FinanceEntry.find(filter).sort({ date: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      FinanceEntry.countDocuments(filter),
      FinanceEntry.aggregate([
        { $match: filter },
        { $group: { _id: "$kind", amount: { $sum: "$amount" } } },
      ]),
    ]);

    const byKind = totals.reduce((a, t) => ((a[t._id] = t.amount), a), {});
    res.status(200).json({
      message: "Finance entries",
      data: rows,
      meta: {
        total, page, limit, pages: Math.ceil(total / limit) || 1,
        income: round2(byKind.income || 0),
        expense: round2(byKind.expense || 0),
      },
      statusCode: 200,
    });
  } catch (e) {
    console.error("listEntries error:", e.message);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

const createEntry = async (req, res) => {
  try {
    const { doc, error } = cleanEntry(req.body, req.admin?._id);
    if (error) return res.status(400).json({ message: error, statusCode: 400 });
    const entry = await FinanceEntry.create(doc);
    res.status(201).json({ message: "Entry added", data: entry, statusCode: 201 });
  } catch (e) {
    console.error("createEntry error:", e.message);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

const updateEntry = async (req, res) => {
  try {
    const { doc, error } = cleanEntry(req.body, req.admin?._id);
    if (error) return res.status(400).json({ message: error, statusCode: 400 });
    delete doc.createdByAdmin; // don't overwrite the original creator
    const entry = await FinanceEntry.findByIdAndUpdate(req.params.id, { $set: doc }, { new: true });
    if (!entry) return res.status(404).json({ message: "Entry not found", statusCode: 404 });
    res.status(200).json({ message: "Entry updated", data: entry, statusCode: 200 });
  } catch (e) {
    console.error("updateEntry error:", e.message);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

const deleteEntry = async (req, res) => {
  try {
    const del = await FinanceEntry.findByIdAndDelete(req.params.id);
    if (!del) return res.status(404).json({ message: "Entry not found", statusCode: 404 });
    res.status(200).json({ message: "Entry deleted", statusCode: 200 });
  } catch (e) {
    console.error("deleteEntry error:", e.message);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** Bulk import — the client parses the CSV and posts { entries: [...] }. */
const importEntries = async (req, res) => {
  try {
    const rows = Array.isArray(req.body.entries) ? req.body.entries : [];
    if (!rows.length) return res.status(400).json({ message: "No entries to import", statusCode: 400 });
    if (rows.length > 5000) return res.status(400).json({ message: "Too many rows (max 5000 per import)", statusCode: 400 });

    const docs = [];
    const errors = [];
    rows.forEach((r, i) => {
      const { doc, error } = cleanEntry({ ...r, source: "csv-import" }, req.admin?._id);
      if (error) errors.push({ row: i + 1, error });
      else docs.push(doc);
    });

    let inserted = 0;
    if (docs.length) inserted = (await FinanceEntry.insertMany(docs, { ordered: false })).length;

    res.status(200).json({
      message: "Import complete",
      data: { inserted, failed: errors.length, errors: errors.slice(0, 20) },
      statusCode: 200,
    });
  } catch (e) {
    console.error("importEntries error:", e.message);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/* --------------------------- Combined P&L summary --------------------------- */

const financeSummary = async (req, res) => {
  try {
    const { from, to, valid } = parseRange(req.query);
    if (!valid) return res.status(400).json({ message: "Invalid date range", statusCode: 400 });

    // 1) Website booking revenue (paid, not refunded) — by month.
    const webAgg = await Order.aggregate([
      { $match: { status: PAID, ...NOT_REFUNDED, addedByAdmin: { $ne: true }, createdBy: { $gte: from, $lte: to } } },
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdBy" } }, revenue: { $sum: { $ifNull: ["$grand_total", 0] } } } },
    ]);
    const websiteTotal = round2(webAgg.reduce((s, r) => s + r.revenue, 0));
    const webByMonth = new Map(webAgg.map((r) => [r._id, round2(r.revenue)]));

    // 2) Manual ledger — grouped by kind + category + month.
    const entryAgg = await FinanceEntry.aggregate([
      { $match: { date: { $gte: from, $lte: to } } },
      { $group: { _id: { kind: "$kind", category: "$category", month: monthKey }, amount: { $sum: "$amount" } } },
    ]);

    const incomeByCat = new Map();
    const expenseByCat = new Map();
    const manualIncomeByMonth = new Map();
    const expenseByMonth = new Map();
    let manualIncomeTotal = 0;
    let expenseTotal = 0;

    for (const r of entryAgg) {
      const { kind, category, month } = r._id;
      const amt = round2(r.amount);
      if (kind === "income") {
        incomeByCat.set(category, round2((incomeByCat.get(category) || 0) + amt));
        manualIncomeByMonth.set(month, round2((manualIncomeByMonth.get(month) || 0) + amt));
        manualIncomeTotal = round2(manualIncomeTotal + amt);
      } else {
        expenseByCat.set(category, round2((expenseByCat.get(category) || 0) + amt));
        expenseByMonth.set(month, round2((expenseByMonth.get(month) || 0) + amt));
        expenseTotal = round2(expenseTotal + amt);
      }
    }

    // Income by category always shows "Website" (the auto source) first.
    const incomeCategories = [
      ...(websiteTotal > 0 ? [{ category: "Website", amount: websiteTotal }] : []),
      ...[...incomeByCat.entries()].map(([category, amount]) => ({ category, amount })),
    ].sort((a, b) => b.amount - a.amount);

    const expenseCategories = [...expenseByCat.entries()]
      .map(([category, amount]) => ({ category, amount }))
      .sort((a, b) => b.amount - a.amount);

    const totalIncome = round2(websiteTotal + manualIncomeTotal);

    // Monthly income vs expense (website + manual income).
    const months = new Set([...webByMonth.keys(), ...manualIncomeByMonth.keys(), ...expenseByMonth.keys()]);
    const monthly = [...months].sort().map((m) => {
      const income = round2((webByMonth.get(m) || 0) + (manualIncomeByMonth.get(m) || 0));
      const expense = round2(expenseByMonth.get(m) || 0);
      return { period: m, income, expense, net: round2(income - expense) };
    });

    res.status(200).json({
      message: "Finance summary",
      data: {
        range: { from, to },
        income: {
          website: websiteTotal,
          manual: manualIncomeTotal,
          total: totalIncome,
          byCategory: incomeCategories,
        },
        expense: {
          total: expenseTotal,
          byCategory: expenseCategories,
        },
        net: round2(totalIncome - expenseTotal),
        monthly,
      },
      statusCode: 200,
    });
  } catch (e) {
    console.error("financeSummary error:", e.message);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/* --------------------- City-wise sales export (per month) --------------------- */

const isoDay = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");
const isoDT = (d) => (d ? new Date(d).toISOString().slice(0, 16).replace("T", " ") : "");

/**
 * Turns ?month=YYYY-MM into a [from,to] window; falls back to ?from/?to, else the
 * current calendar month. Returns the label too (for the file name / heading).
 */
const monthRange = (query) => {
  if (query.month && /^\d{4}-\d{2}$/.test(query.month)) {
    const [y, m] = query.month.split("-").map(Number);
    const from = new Date(y, m - 1, 1, 0, 0, 0, 0);
    const to = new Date(y, m, 0, 23, 59, 59, 999); // day 0 of next month = last day
    return { from, to, label: query.month, valid: true };
  }
  const r = parseRange(query);
  const label = query.from || query.to ? `${isoDay(r.from)}_to_${isoDay(r.to)}` : "all";
  return { ...r, label };
};

/**
 * GET /api/admin/finance/city-sales?month=YYYY-MM  (or ?from=&to=)
 *
 * City-wise sales for the selected month, with the full payment breakdown the
 * finance team needs: ticket amount, platform fee, GST (18%), discount, total,
 * and refunds processed on those bookings. Returns BOTH a per-city summary and
 * the per-booking transactions (the frontend writes them into one CSV sheet).
 *
 * "Sales" = real money collected (paid orders with a payment id, grand_total>0,
 * excluding comp/manually-added bookings). A refund is counted when the gateway
 * actually processed it (refund.id set and not "failed"). Net = gross − refunds.
 */
const citySales = async (req, res) => {
  try {
    const { from, to, label, valid } = monthRange(req.query);
    if (!valid) return res.status(400).json({ message: "Invalid month/date range", statusCode: 400 });

    // Money that was actually collected in the window. We do NOT exclude refunded
    // orders here (unlike the P&L) — refunds are reported in their own columns.
    const orders = await Order.find({
      createdBy: { $gte: from, $lte: to },
      grand_total: { $gt: 0 },
      payment_id: { $ne: null },
      addedByAdmin: { $ne: true },
    })
      .populate("event_id", "name city")
      .select(
        "event_id event_city attendee_details attendees tickets total_price booking_fee gst discount grand_total " +
          "status payment_id paymentOrderId order_id invoice_no coupon_code refund createdBy"
      )
      .sort({ createdBy: 1 })
      .lean();

    const refundProcessed = (o) => !!(o.refund && o.refund.id && o.refund.status !== "failed");
    const cityOf = (o) =>
      (o.event_city && o.event_city.trim()) ||
      (o.attendee_details && o.attendee_details.city && o.attendee_details.city.trim()) ||
      (o.event_id && o.event_id.city && String(o.event_id.city).trim()) ||
      "Unknown";

    const transactions = [];
    const byCity = new Map();

    for (const o of orders) {
      const city = cityOf(o);
      const booker = o.attendee_details || {};
      const guests = Math.max(Array.isArray(o.attendees) ? o.attendees.length : 0, 1);
      const refunded = refundProcessed(o);
      const refundAmt = refunded ? round2(o.refund.amount || 0) : 0;
      const ticket = round2(o.total_price || 0);
      const platformFee = round2(o.booking_fee || 0);
      const gst = round2(o.gst || 0);
      const discount = round2(o.discount || 0);
      const total = round2(o.grand_total || 0);

      transactions.push({
        bookedAt: isoDay(o.createdBy),
        city,
        event: o.event_id?.name || "",
        customer: booker.name || "",
        email: booker.email || "",
        phone: booker.phone || "",
        invoiceNo: o.invoice_no || "",
        paymentId: o.payment_id || "",
        orderId: o.order_id || String(o._id),
        ticket,
        platformFee,
        gst,
        discount,
        total,
        status: o.status || "",
        refundAmount: refundAmt,
        refundStatus: refunded ? o.refund.status || "processed" : "",
        refundRef: refunded ? o.refund.rrn || o.refund.id || "" : "",
        refundAt: refunded ? isoDT(o.refund.at) : "",
        net: round2(total - refundAmt),
      });

      const c = byCity.get(city) || {
        city, bookings: 0, guests: 0, ticket: 0, platformFee: 0,
        gst: 0, discount: 0, grossTotal: 0, refundCount: 0, refundAmount: 0, net: 0,
      };
      c.bookings += 1;
      c.guests += guests;
      c.ticket = round2(c.ticket + ticket);
      c.platformFee = round2(c.platformFee + platformFee);
      c.gst = round2(c.gst + gst);
      c.discount = round2(c.discount + discount);
      c.grossTotal = round2(c.grossTotal + total);
      if (refunded) { c.refundCount += 1; c.refundAmount = round2(c.refundAmount + refundAmt); }
      c.net = round2(c.grossTotal - c.refundAmount);
      byCity.set(city, c);
    }

    const summary = [...byCity.values()].sort((a, b) => b.net - a.net);
    const totals = summary.reduce(
      (t, c) => ({
        bookings: t.bookings + c.bookings,
        guests: t.guests + c.guests,
        ticket: round2(t.ticket + c.ticket),
        platformFee: round2(t.platformFee + c.platformFee),
        gst: round2(t.gst + c.gst),
        discount: round2(t.discount + c.discount),
        grossTotal: round2(t.grossTotal + c.grossTotal),
        refundCount: t.refundCount + c.refundCount,
        refundAmount: round2(t.refundAmount + c.refundAmount),
        net: round2(t.net + c.net),
      }),
      { bookings: 0, guests: 0, ticket: 0, platformFee: 0, gst: 0, discount: 0, grossTotal: 0, refundCount: 0, refundAmount: 0, net: 0 }
    );

    res.status(200).json({
      message: "City-wise sales",
      data: { month: label, range: { from, to }, summary, transactions, totals },
      statusCode: 200,
    });
  } catch (e) {
    console.error("citySales error:", e.message);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/* --------------------------- Bank reconciliation --------------------------- */

/**
 * POST /api/admin/finance/reconcile — the client parses a bank statement CSV and
 * posts normalised lines: [{ date, amount, direction:"credit"|"debit", description }].
 * We match each line to a ledger entry (credit→income, debit→expense) by amount
 * (±₹1) and date (±windowDays). Read-only preview — nothing is persisted here.
 *
 * Returns matched pairs + unmatched bank lines (money moved that ISN'T recorded →
 * likely missing entries) + unmatched ledger rows (recorded but not seen in the
 * bank → pending / possibly missing money) + totals.
 */
const reconcile = async (req, res) => {
  try {
    const raw = Array.isArray(req.body.lines) ? req.body.lines : [];
    if (!raw.length) return res.status(400).json({ message: "No bank lines to reconcile", statusCode: 400 });
    if (raw.length > 5000) return res.status(400).json({ message: "Too many rows (max 5000)", statusCode: 400 });

    const windowMs = (Number(req.body.windowDays) || 3) * 864e5;

    const bank = raw
      .map((l, i) => ({
        i,
        date: new Date(l.date),
        amount: round2(Math.abs(Number(l.amount) || 0)),
        direction: l.direction === "credit" ? "credit" : "debit",
        description: String(l.description || "").trim(),
      }))
      .filter((b) => !Number.isNaN(b.date.getTime()) && b.amount > 0);

    if (!bank.length) return res.status(400).json({ message: "No usable rows (need date + amount)", statusCode: 400 });

    // Candidate ledger entries within the statement's window.
    const times = bank.map((b) => b.date.getTime());
    const from = new Date(Math.min(...times) - windowMs);
    const to = new Date(Math.max(...times) + windowMs);
    const entries = await FinanceEntry.find({ date: { $gte: from, $lte: to } }).lean();

    const used = new Set();
    const matched = [];
    for (const b of bank) {
      const wantKind = b.direction === "credit" ? "income" : "expense";
      let best = null, bestGap = Infinity;
      for (const e of entries) {
        if (used.has(String(e._id)) || e.kind !== wantKind) continue;
        if (Math.abs(round2(e.amount) - b.amount) > 1) continue;
        const gap = Math.abs(new Date(e.date).getTime() - b.date.getTime());
        if (gap <= windowMs && gap < bestGap) { best = e; bestGap = gap; }
      }
      if (best) { used.add(String(best._id)); matched.push({ bank: b, entryId: best._id, entry: best }); }
    }

    const matchedIdx = new Set(matched.map((m) => m.bank.i));
    const unmatchedBank = bank.filter((b) => !matchedIdx.has(b.i));
    const unmatchedLedger = entries.filter((e) => !used.has(String(e._id)));

    const sum = (arr, f) => round2(arr.reduce((s, x) => s + f(x), 0));
    const totals = {
      bankCredits: sum(bank.filter((b) => b.direction === "credit"), (b) => b.amount),
      bankDebits: sum(bank.filter((b) => b.direction === "debit"), (b) => b.amount),
      matchedCount: matched.length,
      unmatchedBankCount: unmatchedBank.length,
      unmatchedLedgerCount: unmatchedLedger.length,
      // "Money in the bank not in our books" — the gap to investigate.
      unmatchedBankCredits: sum(unmatchedBank.filter((b) => b.direction === "credit"), (b) => b.amount),
      unmatchedBankDebits: sum(unmatchedBank.filter((b) => b.direction === "debit"), (b) => b.amount),
      // "In our books but not seen in the bank" — pending / possibly missing.
      unmatchedLedgerIncome: sum(unmatchedLedger.filter((e) => e.kind === "income"), (e) => e.amount),
      unmatchedLedgerExpense: sum(unmatchedLedger.filter((e) => e.kind === "expense"), (e) => e.amount),
    };

    res.status(200).json({ message: "Reconciliation", data: { matched, unmatchedBank, unmatchedLedger, totals }, statusCode: 200 });
  } catch (e) {
    console.error("reconcile error:", e.message);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** POST /api/admin/finance/reconcile/confirm — mark matched ledger entries reconciled. */
const markReconciled = async (req, res) => {
  try {
    const ids = Array.isArray(req.body.ids) ? req.body.ids : [];
    if (!ids.length) return res.status(400).json({ message: "No entries to mark", statusCode: 400 });
    const r = await FinanceEntry.updateMany({ _id: { $in: ids } }, { $set: { reconciled: true } });
    res.status(200).json({ message: "Marked reconciled", data: { count: r.modifiedCount ?? ids.length }, statusCode: 200 });
  } catch (e) {
    console.error("markReconciled error:", e.message);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/* ------------------------------ Refund details ------------------------------ */

/**
 * Refund tracking for Financial Insights → Refunds (and the read-only summary on
 * Revenue Analytics). Mirrors the exact "who is owed a refund" logic the admin's
 * refund list already uses, so the numbers always agree:
 *
 *   Refundable universe = money was collected (grand_total > 0, not a comp /
 *   admin-added booking) AND the booking is cancelled OR the application was
 *   rejected.
 *
 * Each such order lands in ONE bucket:
 *   - processed : refund done & money returned (gateway refund, a manual/off-
 *                 gateway refund, or an "already fully refunded on Razorpay" note)
 *   - waived    : refund explicitly waived (closed, no money owed)
 *   - pending   : owed but not yet refunded  ← "kitne bache h"
 *   - skipped   : internal test booking, or a duplicate order sharing one payment
 *                 (refunded once) — kept out of the headline counts
 *
 * Month basis: a refund is counted in the month the booking was cancelled/
 * rejected (fallback: review date, then the order's own creation time).
 */

// A real Razorpay refund id looks like "rfnd_...". Those are the ONLY refunds the
// admin can never edit or undo from the UI — everything else (null, "MANUAL",
// "WAIVED", "OFFLINE_DIRECT") is hand-managed and therefore editable.
const isGatewayRefund = (r) => !!(r && r.id && /^rfnd_/i.test(String(r.id)));
const isTestBooking = (name) => /bharti\s*mahto/i.test(String(name || ""));
const refundWhen = (o) => new Date(o.cancelledAt || o.reviewedAt || o._id.getTimestamp());
const monthStr = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;

const buildRefundRow = (o, bucket, amount, when) => {
  const r = o.refund || {};
  const idIsSentinel = r.id && /^(MANUAL|WAIVED|OFFLINE_DIRECT)$/i.test(String(r.id));
  return {
    id: String(o._id),
    name: (o.attendee_details && o.attendee_details.name || "").trim() || "—",
    phone: (o.attendee_details && o.attendee_details.phone || "").trim(),
    email: (o.attendee_details && o.attendee_details.email || "").trim(),
    event: (o.event_id && (o.event_id.name || o.event_id.title)) || "",
    paid: round2(o.grand_total || 0),
    amount: round2(amount),
    bucket,
    status: r.status || "",
    method: r.method || "",
    manual: !!r.manual,
    gateway: isGatewayRefund(r),
    reference: r.rrn || (r.id && !idIsSentinel ? r.id : "") || "",
    note: r.note || r.error || "",
    paymentId: o.payment_id || "",
    month: monthStr(when),
    date: isoDay(when),
    refundAt: r.at ? isoDay(r.at) : "",
  };
};

const refundSummary = async (req, res) => {
  try {
    const { from, to, valid } = parseRange(req.query);
    if (!valid) return res.status(400).json({ message: "Invalid date range", statusCode: 400 });

    const orders = await Order.find({
      $or: [{ status: "cancelled" }, { applicationStatus: "rejected" }],
      grand_total: { $gt: 0 },
      addedByAdmin: { $ne: true },
    })
      .populate("event_id", "name title")
      .select(
        "attendee_details grand_total status applicationStatus refund payment_id order_id " +
          "invoice_no cancelledAt reviewedAt createdBy event_id"
      )
      .lean();

    // Oldest first so payment-dedupe keeps the earliest pending row.
    const enriched = orders.map((o) => ({ o, when: refundWhen(o) })).sort((a, b) => a.when - b.when);

    const lists = { processed: [], pending: [], waived: [] };
    const monthMap = new Map();
    const seenPendingPay = new Set();
    const totals = {
      processedCount: 0, processedAmount: 0,
      pendingCount: 0, pendingAmount: 0,
      waivedCount: 0,
    };

    for (const { o, when } of enriched) {
      const r = o.refund || {};
      const status = String(r.status || "").toLowerCase();
      const done = !!r.id || ["processed", "completed", "refunded", "waived"].includes(status);
      const waived = status === "waived" || String(r.id || "") === "WAIVED";
      const alreadyOnGateway = /fully refunded/i.test(String(r.error || ""));

      let bucket, amount;
      if (waived) {
        bucket = "waived"; amount = 0;
      } else if (done || alreadyOnGateway) {
        bucket = "processed"; amount = r.amount != null ? r.amount : o.grand_total;
      } else {
        amount = r.amount != null ? r.amount : o.grand_total;
        if (isTestBooking(o.attendee_details && o.attendee_details.name)) { bucket = "skipped"; }
        else if (o.payment_id && seenPendingPay.has(o.payment_id)) { bucket = "skipped"; }
        else { bucket = "pending"; if (o.payment_id) seenPendingPay.add(o.payment_id); }
      }

      // Keep the range filter here (dedupe stays global so a narrow range can't
      // resurface a duplicate just because its twin fell outside the window).
      if (when < from || when > to) continue;
      if (bucket === "skipped") continue;

      const row = buildRefundRow(o, bucket, amount, when);
      lists[bucket].push(row);

      const m = monthMap.get(row.month) || {
        period: row.month,
        processedCount: 0, processedAmount: 0,
        pendingCount: 0, pendingAmount: 0,
        waivedCount: 0,
      };
      if (bucket === "processed") {
        m.processedCount += 1; m.processedAmount = round2(m.processedAmount + row.amount);
        totals.processedCount += 1; totals.processedAmount = round2(totals.processedAmount + row.amount);
      } else if (bucket === "pending") {
        m.pendingCount += 1; m.pendingAmount = round2(m.pendingAmount + row.amount);
        totals.pendingCount += 1; totals.pendingAmount = round2(totals.pendingAmount + row.amount);
      } else if (bucket === "waived") {
        m.waivedCount += 1; totals.waivedCount += 1;
      }
      monthMap.set(row.month, m);
    }

    const monthly = [...monthMap.values()]
      .map((m) => ({
        ...m,
        totalCount: m.processedCount + m.pendingCount,
        totalAmount: round2(m.processedAmount + m.pendingAmount),
      }))
      .sort((a, b) => a.period.localeCompare(b.period));

    totals.totalCount = totals.processedCount + totals.pendingCount;
    totals.totalAmount = round2(totals.processedAmount + totals.pendingAmount);

    // Newest first for the tables; cap processed to keep the payload light.
    const byDateDesc = (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0);
    lists.pending.sort(byDateDesc);
    lists.processed.sort(byDateDesc);
    lists.waived.sort(byDateDesc);

    res.status(200).json({
      message: "Refund summary",
      data: {
        range: { from, to },
        totals,
        monthly,
        pending: lists.pending,
        processed: lists.processed.slice(0, 500),
        waived: lists.waived,
      },
      statusCode: 200,
    });
  } catch (e) {
    console.error("refundSummary error:", e.message);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * PATCH /api/admin/finance/refunds/:id — record (or correct) a MANUAL/off-gateway
 * refund on a booking. Never calls Razorpay. Setting refund.id makes the booking
 * count as "processed" and drops it out of website revenue. A real Razorpay
 * refund (rfnd_...) is protected and cannot be overwritten here.
 */
const markRefund = async (req, res) => {
  try {
    const existing = await Order.findById(req.params.id).select("refund grand_total").lean();
    if (!existing) return res.status(404).json({ message: "Booking not found", statusCode: 404 });
    if (isGatewayRefund(existing.refund)) {
      return res.status(409).json({ message: "This booking was refunded through Razorpay — it can't be edited here.", statusCode: 409 });
    }

    const b = req.body || {};
    const amount = Number(b.amount);
    if (!Number.isFinite(amount) || amount < 0) return res.status(400).json({ message: "amount must be a positive number", statusCode: 400 });
    const when = b.date ? new Date(b.date) : new Date();
    if (Number.isNaN(when.getTime())) return res.status(400).json({ message: "a valid date is required", statusCode: 400 });
    const reference = String(b.reference || "").trim();
    const method = String(b.method || "").trim();
    const note = String(b.note || "").trim();
    const status = ["processed", "pending", "failed"].includes(String(b.status)) ? b.status : "processed";

    const update = {
      "refund.id": reference || "MANUAL",   // non-null → counts as done, leaves revenue
      "refund.status": status,
      "refund.amount": round2(amount),
      "refund.rrn": reference || null,
      "refund.error": null,
      "refund.at": when,
      "refund.manual": true,
      "refund.method": method || null,
      "refund.note": note || null,
      "refund.manualBy": (req.admin && req.admin._id) || null,
    };
    const updated = await Order.findByIdAndUpdate(req.params.id, { $set: update }, { new: true })
      .select("attendee_details grand_total status applicationStatus refund payment_id")
      .lean();

    res.status(200).json({ message: "Refund recorded", data: updated, statusCode: 200 });
  } catch (e) {
    console.error("markRefund error:", e.message);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * DELETE /api/admin/finance/refunds/:id — undo a manual/off-gateway refund,
 * sending the booking back to "pending". A real Razorpay refund is protected.
 */
const unmarkRefund = async (req, res) => {
  try {
    const existing = await Order.findById(req.params.id).select("refund").lean();
    if (!existing) return res.status(404).json({ message: "Booking not found", statusCode: 404 });
    if (isGatewayRefund(existing.refund)) {
      return res.status(409).json({ message: "This is a Razorpay refund — it can't be undone here.", statusCode: 409 });
    }
    if (!existing.refund || !existing.refund.id) {
      return res.status(400).json({ message: "Nothing to undo — this booking has no recorded refund.", statusCode: 400 });
    }
    const cleared = {
      "refund.id": null, "refund.status": null, "refund.amount": null, "refund.rrn": null,
      "refund.error": null, "refund.at": null, "refund.manual": false, "refund.method": null,
      "refund.note": null, "refund.manualBy": null,
    };
    const updated = await Order.findByIdAndUpdate(req.params.id, { $set: cleared }, { new: true })
      .select("attendee_details grand_total status applicationStatus refund payment_id")
      .lean();
    res.status(200).json({ message: "Refund undone", data: updated, statusCode: 200 });
  } catch (e) {
    console.error("unmarkRefund error:", e.message);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

module.exports = {
  listEntries,
  createEntry,
  updateEntry,
  deleteEntry,
  importEntries,
  financeSummary,
  citySales,
  reconcile,
  markReconciled,
  refundSummary,
  markRefund,
  unmarkRefund,
};
