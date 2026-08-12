const Lead = require("../models/leadModel");
const { toE164 } = require("../utils/phone");

/* Pagination helpers (kept local so this controller is self-contained). */
const paging = (query) => {
  const limit = Math.min(Math.max(Number(query.limit) || 25, 1), 200);
  const page = Math.max(Number(query.page) || 1, 1);
  return { limit, page, skip: (page - 1) * limit };
};
const meta = (total, limit, page) => ({
  total,
  page,
  limit,
  pages: Math.ceil(total / limit) || 1,
});
/** Escapes user input before it goes into a regex, so "a+b" can't blow up. */
const safeRegex = (text) =>
  new RegExp(String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");

/**
 * PUBLIC. Upsert a checkout lead.
 *
 * Called (debounced) by the customer site as a guest fills the checkout form, so
 * we keep the latest snapshot of their details even if they never pay. Deduped
 * per (event + contact): matching an existing row by whichever contact we have.
 *
 * `status` is only ever moved TO "converted" (once they book) — a later
 * abandoned upsert never demotes a converted lead.
 */
const upsertLead = async (req, res) => {
  try {
    const b = req.body || {};
    const email = b.email ? String(b.email).toLowerCase().trim() : "";
    const phone = b.phone ? toE164(b.phone) || String(b.phone).trim() : "";

    // Need at least one way to reach them.
    if (!email && !phone) {
      return res
        .status(400)
        .json({ message: "An email or phone is required", statusCode: 400 });
    }

    // Match an existing lead for this event by whichever contact we have.
    const contactOr = [];
    if (email) contactOr.push({ email });
    if (phone) contactOr.push({ phone });
    const match = {
      ...(b.event_id ? { event_id: b.event_id } : {}),
      $or: contactOr,
    };

    // Only write fields that were actually provided, so a partial upsert (e.g.
    // the debounced snapshot, or the "converted" ping that carries just the
    // contact) never blanks details captured earlier.
    const set = {};
    const put = (key, val) => {
      if (val !== undefined && val !== null && val !== "") set[key] = val;
    };
    put("email", email);
    put("phone", phone);
    put("name", b.name);
    put("city", b.city);
    put("gender", b.gender);
    put("DOB", b.DOB);
    put("maritalStatus", b.maritalStatus);
    put("reasonToJoin", b.reasonToJoin);
    put("event_title", b.event_title);
    put("event_city", b.event_city);
    put("ticket_name", b.ticket_name);
    if (b.ticket_price !== undefined && b.ticket_price !== null && b.ticket_price !== "") {
      set.ticket_price = Number(b.ticket_price) || 0;
    }
    if (b.quantity !== undefined && b.quantity !== null && b.quantity !== "") {
      set.quantity = Number(b.quantity) || 1;
    }
    put("source", b.source);
    if (typeof b.wasGuest === "boolean") set.wasGuest = b.wasGuest;
    if (b.event_id) set.event_id = b.event_id;

    const update = {};
    if (Object.keys(set).length) update.$set = set;
    // Only flip forward to "converted"; never overwrite it back to "abandoned".
    if (b.status === "converted") {
      update.$set = { ...(update.$set || {}), status: "converted" };
    } else {
      update.$setOnInsert = { status: "abandoned" };
    }

    const lead = await Lead.findOneAndUpdate(match, update, {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    });

    return res
      .status(200)
      .json({ message: "Lead saved", data: { _id: lead._id }, statusCode: 200 });
  } catch (error) {
    console.error("upsertLead error:", error.message);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * ADMIN. Paginated list of leads for the marketing team, newest activity first.
 * Filterable by status, event, and a free-text search over name/email/phone/
 * city/event title.
 */
const listLeads = async (req, res) => {
  try {
    const { limit, page, skip } = paging(req.query);
    const filter = {};

    if (req.query.status && ["abandoned", "converted"].includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (req.query.event_id) filter.event_id = req.query.event_id;
    if (req.query.search) {
      const rx = safeRegex(req.query.search);
      filter.$or = [
        { name: rx },
        { email: rx },
        { phone: rx },
        { city: rx },
        { event_title: rx },
      ];
    }

    const [rows, total] = await Promise.all([
      Lead.find(filter).sort({ updatedAt: -1, _id: -1 }).skip(skip).limit(limit).lean(),
      Lead.countDocuments(filter),
    ]);

    // Quick totals so the UI can show a summary without a second call.
    const [abandoned, converted] = await Promise.all([
      Lead.countDocuments({ ...filter, status: "abandoned" }),
      Lead.countDocuments({ ...filter, status: "converted" }),
    ]);

    res.status(200).json({
      message: "Leads",
      data: rows,
      meta: { ...meta(total, limit, page), abandoned, converted },
      statusCode: 200,
    });
  } catch (error) {
    console.error("listLeads error:", error.message);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

module.exports = { upsertLead, listLeads };
