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
      { $match: { status: PAID, ...NOT_REFUNDED, createdBy: { $gte: from, $lte: to } } },
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

module.exports = {
  listEntries,
  createEntry,
  updateEntry,
  deleteEntry,
  importEntries,
  financeSummary,
  reconcile,
  markReconciled,
};
