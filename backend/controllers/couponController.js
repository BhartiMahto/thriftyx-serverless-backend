const Coupon = require("../models/couponModel");
const Order = require("../models/orderModel");
const User = require("../models/userModel");

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * The booking-history + profile facts a coupon's targeting is checked against.
 * Computed once per request so per-coupon checks are in-memory.
 */
const userSegment = async (userId) => {
  if (!userId) return null;
  const [user, completedCount, last] = await Promise.all([
    User.findById(userId).select("gender").lean(),
    Order.countDocuments({ user_id: userId, status: "completed" }),
    Order.find({ user_id: userId, status: "completed" }).select("createdBy").sort({ createdBy: -1 }).limit(1).lean(),
  ]);
  return {
    gender: (user?.gender || "").trim().toLowerCase(),
    completedCount,
    lastCompleted: last[0]?.createdBy || null,
  };
};

/**
 * Checks a coupon's audience/gender/city targeting. Returns null when the
 * coupon applies, or a human reason string when it doesn't.
 * `seg` is the userSegment (null if not signed in); `eventCity` is the city the
 * booking is for.
 */
const targetingReason = (coupon, seg, eventCity, ctx = {}) => {
  // Buy-1-get-1 needs enough qualifying participants to form a pair. Only
  // enforce this when attendees are known (validate/order) — in the browse
  // list (no attendees) the offer should still be shown.
  if (
    coupon.discountType === "bogo" &&
    ctx.attendees && ctx.attendees.length &&
    bogoFreeCount(coupon, ctx) <= 0
  ) {
    const g = norm(coupon.bogoGender);
    return `This buy-1-get-1 offer needs at least 2 ${g ? g + " " : ""}participants`;
  }
  // City targeting is on the BOOKING's city.
  if (coupon.cities && coupon.cities.length) {
    const allowed = coupon.cities.map((c) => String(c).trim().toLowerCase());
    if (!eventCity || !allowed.includes(String(eventCity).trim().toLowerCase())) {
      return `This offer is only for ${coupon.cities.join(", ")}`;
    }
  }

  const needsUser = (coupon.genders && coupon.genders.length) || (coupon.audience && coupon.audience !== "all");
  if (needsUser && !seg) return "Sign in to use this offer";

  if (coupon.genders && coupon.genders.length) {
    const allowed = coupon.genders.map((g) => String(g).trim().toLowerCase());
    if (!seg.gender || !allowed.includes(seg.gender)) return "This offer isn't available for your profile";
  }

  if (coupon.audience === "first_time") {
    if (seg.completedCount > 0) return "This is a first-booking-only offer";
  } else if (coupon.audience === "lapsed") {
    if (!seg.lastCompleted) return "This win-back offer is for returning members";
    const days = coupon.lapsedDays || 90;
    const ageMs = Date.now() - new Date(seg.lastCompleted).getTime();
    if (ageMs < days * 24 * 3600 * 1000) return `This offer unlocks ${days}+ days after your last booking`;
  }

  return null;
};

const norm = (s) => String(s || "").trim().toLowerCase();

/**
 * How many attendees match a BOGO coupon's gender (all of them when no gender
 * is set), and how many free tickets that earns (1 per pair).
 */
const bogoFreeCount = (coupon, ctx) => {
  const g = norm(coupon.bogoGender);
  const genders = (ctx?.attendees || []).map(norm);
  const qualifying = g ? genders.filter((x) => x === g).length : genders.length;
  return Math.floor(qualifying / 2);
};

/**
 * Discount for a coupon against a subtotal. Never returns more than the
 * subtotal, and caps percentage coupons at maxDiscount when set.
 * `ctx` = { attendees: [gender...], unitPrices: [number...] } for BOGO.
 */
const computeDiscount = (coupon, subtotal, ctx = {}) => {
  if (coupon.discountType === "bogo") {
    const free = bogoFreeCount(coupon, ctx);
    if (free <= 0) return 0;
    // The freed seats are the cheapest ones (standard buy-1-get-1).
    const prices = [...(ctx.unitPrices || [])].map((p) => Number(p) || 0).sort((a, b) => a - b);
    const discount = prices.slice(0, free).reduce((s, p) => s + p, 0);
    return round2(Math.max(0, Math.min(discount, subtotal)));
  }

  let discount =
    coupon.discountType === "percent"
      ? (subtotal * coupon.discountValue) / 100
      : coupon.discountValue;

  if (coupon.discountType === "percent" && coupon.maxDiscount != null) {
    discount = Math.min(discount, coupon.maxDiscount);
  }
  return round2(Math.max(0, Math.min(discount, subtotal)));
};

/**
 * Shared validation. Returns { ok, coupon, discount } or { ok:false, reason }.
 * `userId` is optional — per-user limits are only enforced when it's known
 * (i.e. at order time, not on the public preview).
 */
const evaluateCoupon = async (rawCode, subtotal, userId, opts = {}) => {
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return { ok: false, reason: "Enter a coupon code" };

  const coupon = await Coupon.findOne({ code });
  if (!coupon || !coupon.active) return { ok: false, reason: "Invalid coupon code" };

  const now = Date.now();
  if (coupon.validFrom && now < new Date(coupon.validFrom).getTime()) {
    return { ok: false, reason: "This coupon isn't active yet" };
  }
  if (coupon.validTo && now > new Date(coupon.validTo).getTime()) {
    return { ok: false, reason: "This coupon has expired" };
  }
  if (subtotal < (coupon.minOrderValue || 0)) {
    return { ok: false, reason: `Minimum order of ₹${coupon.minOrderValue} required` };
  }
  if (coupon.usageLimit != null && coupon.usedCount >= coupon.usageLimit) {
    return { ok: false, reason: "This coupon has reached its usage limit" };
  }
  if (coupon.perUserLimit != null && userId) {
    const used = await Order.countDocuments({
      user_id: userId,
      coupon_code: code,
      status: { $ne: "cancelled" },
    });
    if (used >= coupon.perUserLimit) {
      return { ok: false, reason: "You've already used this coupon" };
    }
  }

  // Audience / gender / city / BOGO-participant targeting.
  const ctx = { attendees: opts.attendees || [], unitPrices: opts.unitPrices || [] };
  const targeted =
    coupon.discountType === "bogo" ||
    (coupon.cities && coupon.cities.length) ||
    (coupon.genders && coupon.genders.length) ||
    (coupon.audience && coupon.audience !== "all");
  if (targeted) {
    const seg = opts.segment !== undefined ? opts.segment : await userSegment(userId);
    const reason = targetingReason(coupon, seg, opts.eventCity, ctx);
    if (reason) return { ok: false, reason };
  }

  const discount = computeDiscount(coupon, subtotal, ctx);
  // A BOGO with no free seats (e.g. only 1 qualifying attendee) shouldn't apply.
  if (coupon.discountType === "bogo" && discount <= 0) {
    const g = norm(coupon.bogoGender);
    return { ok: false, reason: `This buy-1-get-1 offer needs at least 2 ${g ? g + " " : ""}participants` };
  }
  return { ok: true, coupon, discount };
};

/* ------------------------------ Public ------------------------------ */

/** POST /api/coupon/validate — preview a discount. No usage is recorded. */
const validate = async (req, res) => {
  try {
    const { code, subtotal } = req.body;
    const amount = Number(subtotal);
    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({ message: "A valid subtotal is required", statusCode: 400 });
    }

    // Coupons are for signed-in members only.
    if (!req.user) {
      return res.status(200).json({ valid: false, reason: "Please sign in to use a coupon", statusCode: 200 });
    }

    // req.user is set by optional auth when the shopper is signed in; eventCity
    // is the city the booking is for (multi-city events).
    const result = await evaluateCoupon(code, amount, req.user?._id, {
      eventCity: req.body.eventCity,
      // Attendee genders + per-ticket prices, for buy-1-get-1 coupons.
      attendees: Array.isArray(req.body.attendees) ? req.body.attendees : [],
      unitPrices: Array.isArray(req.body.unitPrices) ? req.body.unitPrices : [],
    });
    if (!result.ok) {
      return res.status(200).json({ valid: false, reason: result.reason, statusCode: 200 });
    }

    return res.status(200).json({
      valid: true,
      code: result.coupon.code,
      description: result.coupon.description,
      discountType: result.coupon.discountType,
      discountValue: result.coupon.discountValue,
      discount: result.discount,
      statusCode: 200,
    });
  } catch (error) {
    console.error("coupon validate error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * GET /api/coupon/available?subtotal=NNN — coupons a customer can pick from at
 * checkout. Only listed, active, in-window, not-exhausted coupons are returned.
 * Each is annotated with the discount for this subtotal and whether it applies
 * (subtotal meets the minimum). Unlisted/secret codes never appear here.
 */
const listAvailable = async (req, res) => {
  try {
    const subtotal = Number(req.query.subtotal) || 0;
    const eventCity = req.query.city || "";
    // Current attendee genders + per-ticket prices (comma lists), so a BOGO
    // coupon can show whether it's usable yet for this booking.
    const genders = String(req.query.genders || "").split(",").map((s) => s.trim()).filter(Boolean);
    const unitPrices = String(req.query.unitPrices || "").split(",").map(Number).filter((n) => Number.isFinite(n));
    const ctx = { attendees: genders.map((g) => ({ gender: g })), unitPrices };
    const now = new Date();

    // Coupons are for signed-in members only — guests see no offers.
    if (!req.user) {
      return res.status(200).json({ message: "Available coupons", data: [], statusCode: 200 });
    }

    // Personalise to the signed-in shopper's segment (null if a guest).
    const seg = await userSegment(req.user?._id);

    const coupons = await Coupon.find({
      active: true,
      listed: { $ne: false },
      $and: [
        { $or: [{ validFrom: null }, { validFrom: { $lte: now } }] },
        { $or: [{ validTo: null }, { validTo: { $gte: now } }] },
      ],
    })
      .sort({ discountValue: -1 })
      .lean();

    const data = coupons
      // Drop ones that have hit their global usage limit.
      .filter((c) => c.usageLimit == null || (c.usedCount || 0) < c.usageLimit)
      // Only show coupons this shopper is actually eligible for (segment match).
      .filter((c) => targetingReason(c, seg, eventCity) === null)
      .map((c) => {
        const minOk = subtotal >= (c.minOrderValue || 0);
        const discount = minOk && subtotal > 0 ? computeDiscount(c, subtotal, ctx) : 0;
        // A BOGO coupon is only usable once there are enough qualifying
        // attendees to free a seat (discount > 0).
        const applicable = minOk && (c.discountType !== "bogo" || discount > 0);
        return {
          code: c.code,
          description: c.description ?? null,
          discountType: c.discountType,
          discountValue: c.discountValue,
          bogoGender: c.bogoGender ?? null,
          minOrderValue: c.minOrderValue || 0,
          maxDiscount: c.maxDiscount ?? null,
          discount,
          applicable,
        };
      });

    res.status(200).json({ message: "Available coupons", data, statusCode: 200 });
  } catch (error) {
    console.error("listAvailable error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/* ------------------------------ Admin CRUD ------------------------------ */

const publicCoupon = (c) => ({
  _id: c._id,
  code: c.code,
  description: c.description ?? null,
  discountType: c.discountType,
  discountValue: c.discountValue,
  bogoGender: c.bogoGender ?? null,
  minOrderValue: c.minOrderValue ?? 0,
  maxDiscount: c.maxDiscount ?? null,
  usageLimit: c.usageLimit ?? null,
  perUserLimit: c.perUserLimit ?? null,
  usedCount: c.usedCount ?? 0,
  validFrom: c.validFrom ?? null,
  validTo: c.validTo ?? null,
  active: c.active !== false,
  listed: c.listed !== false,
  audience: c.audience ?? "all",
  lapsedDays: c.lapsedDays ?? 90,
  genders: c.genders ?? [],
  cities: c.cities ?? [],
  createdAt: c.createdAt ?? null,
});

const listCoupons = async (req, res) => {
  try {
    const coupons = await Coupon.find().sort({ createdAt: -1 }).lean();
    res.status(200).json({ message: "Coupons", data: coupons.map(publicCoupon), statusCode: 200 });
  } catch (error) {
    console.error("listCoupons error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** Validates and normalises a coupon body for create/update. */
const parseCouponBody = (body, { partial = false } = {}) => {
  const out = {};

  if (body.code !== undefined) {
    const code = String(body.code).trim().toUpperCase();
    if (!code) return { error: "Code is required" };
    if (!/^[A-Z0-9_-]{3,24}$/.test(code)) {
      return { error: "Code must be 3–24 letters, numbers, - or _" };
    }
    out.code = code;
  } else if (!partial) {
    return { error: "Code is required" };
  }

  if (body.discountType !== undefined) {
    if (!["percent", "flat", "bogo"].includes(body.discountType)) {
      return { error: "discountType must be percent, flat or bogo" };
    }
    out.discountType = body.discountType;
  } else if (!partial) {
    return { error: "discountType is required" };
  }

  const effectiveType = out.discountType || body.discountType;

  // BOGO ignores discountValue (the free seat is a whole ticket); allow it to
  // be omitted and store 0.
  if (effectiveType === "bogo") {
    out.discountValue = 0;
    out.bogoGender = body.bogoGender ? String(body.bogoGender).trim().toLowerCase() : null;
  } else if (body.discountValue !== undefined) {
    const v = Number(body.discountValue);
    if (!Number.isFinite(v) || v <= 0) return { error: "discountValue must be a positive number" };
    if (effectiveType === "percent" && v > 100) return { error: "A percentage can't exceed 100" };
    out.discountValue = v;
  } else if (!partial) {
    return { error: "discountValue is required" };
  }

  for (const [field, key] of [["minOrderValue", "minOrderValue"], ["maxDiscount", "maxDiscount"], ["usageLimit", "usageLimit"], ["perUserLimit", "perUserLimit"]]) {
    if (body[field] !== undefined) {
      if (body[field] === null || body[field] === "") { out[key] = field === "minOrderValue" ? 0 : null; continue; }
      const n = Number(body[field]);
      if (!Number.isFinite(n) || n < 0) return { error: `${field} must be a non-negative number` };
      out[key] = n;
    }
  }

  for (const field of ["validFrom", "validTo"]) {
    if (body[field] !== undefined) {
      if (!body[field]) { out[field] = null; continue; }
      const d = new Date(body[field]);
      if (Number.isNaN(d.getTime())) return { error: `${field} is not a valid date` };
      out[field] = d;
    }
  }

  if (body.validFrom && body.validTo && new Date(body.validFrom) > new Date(body.validTo)) {
    return { error: "validFrom must be before validTo" };
  }

  if (body.description !== undefined) out.description = String(body.description).trim() || null;
  if (body.active !== undefined) out.active = Boolean(body.active);
  if (body.listed !== undefined) out.listed = Boolean(body.listed);

  // --- Targeting ---
  if (body.audience !== undefined) {
    if (!["all", "first_time", "lapsed"].includes(body.audience)) {
      return { error: "audience must be all, first_time or lapsed" };
    }
    out.audience = body.audience;
  }
  if (body.lapsedDays !== undefined) {
    const n = Number(body.lapsedDays);
    if (!Number.isFinite(n) || n < 1) return { error: "lapsedDays must be a positive number" };
    out.lapsedDays = Math.round(n);
  }
  const cleanList = (v) =>
    (Array.isArray(v) ? v : String(v).split(","))
      .map((x) => String(x).trim())
      .filter(Boolean);
  if (body.genders !== undefined) out.genders = cleanList(body.genders);
  if (body.cities !== undefined) out.cities = cleanList(body.cities);

  return { value: out };
};

const createCoupon = async (req, res) => {
  try {
    const { value, error } = parseCouponBody(req.body);
    if (error) return res.status(400).json({ message: error, statusCode: 400 });

    if (await Coupon.findOne({ code: value.code })) {
      return res.status(409).json({ message: "A coupon with this code already exists", statusCode: 409 });
    }

    const created = await Coupon.create(value);
    res.status(201).json({ message: "Coupon created", data: publicCoupon(created), statusCode: 201 });
  } catch (error) {
    console.error("createCoupon error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

const updateCoupon = async (req, res) => {
  try {
    const { value, error } = parseCouponBody(req.body, { partial: true });
    if (error) return res.status(400).json({ message: error, statusCode: 400 });
    if (!Object.keys(value).length) {
      return res.status(400).json({ message: "Nothing to update", statusCode: 400 });
    }

    // A code change must not collide with another coupon.
    if (value.code) {
      const clash = await Coupon.findOne({ code: value.code, _id: { $ne: req.params.id } });
      if (clash) return res.status(409).json({ message: "Another coupon already uses this code", statusCode: 409 });
    }

    const updated = await Coupon.findByIdAndUpdate(req.params.id, { $set: value }, { new: true });
    if (!updated) return res.status(404).json({ message: "Coupon not found", statusCode: 404 });

    res.status(200).json({ message: "Coupon updated", data: publicCoupon(updated), statusCode: 200 });
  } catch (error) {
    if (error.name === "CastError") {
      return res.status(404).json({ message: "Coupon not found", statusCode: 404 });
    }
    console.error("updateCoupon error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

const deleteCoupon = async (req, res) => {
  try {
    const deleted = await Coupon.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: "Coupon not found", statusCode: 404 });
    res.status(200).json({ message: "Coupon deleted", statusCode: 200 });
  } catch (error) {
    if (error.name === "CastError") {
      return res.status(404).json({ message: "Coupon not found", statusCode: 404 });
    }
    console.error("deleteCoupon error:", error);
    res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

module.exports = {
  evaluateCoupon,
  computeDiscount,
  validate,
  listAvailable,
  listCoupons,
  createCoupon,
  updateCoupon,
  deleteCoupon,
};
