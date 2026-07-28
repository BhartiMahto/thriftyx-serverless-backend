const Coupon = require("../models/couponModel");
const Order = require("../models/orderModel");

const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Discount for a coupon against a subtotal. Never returns more than the
 * subtotal, and caps percentage coupons at maxDiscount when set.
 */
const computeDiscount = (coupon, subtotal) => {
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
const evaluateCoupon = async (rawCode, subtotal, userId) => {
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

  return { ok: true, coupon, discount: computeDiscount(coupon, subtotal) };
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

    const result = await evaluateCoupon(code, amount, undefined);
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
    const now = new Date();

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
      .map((c) => {
        const applicable = subtotal >= (c.minOrderValue || 0);
        return {
          code: c.code,
          description: c.description ?? null,
          discountType: c.discountType,
          discountValue: c.discountValue,
          minOrderValue: c.minOrderValue || 0,
          maxDiscount: c.maxDiscount ?? null,
          // Only compute a real number when it can actually be used.
          discount: applicable && subtotal > 0 ? computeDiscount(c, subtotal) : 0,
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
  minOrderValue: c.minOrderValue ?? 0,
  maxDiscount: c.maxDiscount ?? null,
  usageLimit: c.usageLimit ?? null,
  perUserLimit: c.perUserLimit ?? null,
  usedCount: c.usedCount ?? 0,
  validFrom: c.validFrom ?? null,
  validTo: c.validTo ?? null,
  active: c.active !== false,
  listed: c.listed !== false,
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
    if (!["percent", "flat"].includes(body.discountType)) {
      return { error: "discountType must be percent or flat" };
    }
    out.discountType = body.discountType;
  } else if (!partial) {
    return { error: "discountType is required" };
  }

  if (body.discountValue !== undefined) {
    const v = Number(body.discountValue);
    if (!Number.isFinite(v) || v <= 0) return { error: "discountValue must be a positive number" };
    const type = out.discountType || body.discountType;
    if (type === "percent" && v > 100) return { error: "A percentage can't exceed 100" };
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
