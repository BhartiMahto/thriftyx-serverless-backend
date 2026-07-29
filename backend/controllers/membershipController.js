const Membership = require("../models/membershipModel");
const Counter = require("../models/counterModel");
const s3 = require("../utils/s3");
const { buildPassPdf } = require("../utils/pdf");
const { createGatewayOrder, verifyGatewaySignature, MOCK_PAYMENTS, RZP_KEY_ID } = require("./paymentController");

/**
 * Golden Pass memberships — a yearly pass of N event credits (default 30),
 * usable in any city. Payments are mocked like the rest of the app, so a
 * purchase activates immediately; wire the Razorpay step where noted for live.
 */

const PASS = {
  events: Number(process.env.GOLDEN_PASS_EVENTS || 30),
  days: Number(process.env.GOLDEN_PASS_DAYS || 365),
  price: Number(process.env.GOLDEN_PASS_PRICE || 4999),
};

/** Public-safe shape for the customer + admin UIs. */
const publicMembership = (m) => ({
  _id: m._id,
  memberId: m.memberId || null,
  tier: m.tier,
  status: m.status,
  eventsTotal: m.eventsTotal,
  eventsUsed: m.eventsUsed,
  eventsRemaining: Math.max(0, (m.eventsTotal || 0) - (m.eventsUsed || 0)),
  price: m.price,
  city: m.city || null,
  startsAt: m.startsAt,
  expiresAt: m.expiresAt,
  passUrl: m.passUrl || null,
  user: m.user_id && m.user_id.name
    ? { _id: m.user_id._id, name: m.user_id.name, email: m.user_id.email, phone: m.user_id.phone }
    : undefined,
  createdBy: m.createdBy,
});

/* --------------------------- shared helpers --------------------------- */

/** The customer's currently-usable pass, or null. Exported for checkout. */
async function getActiveMembership(userId) {
  const now = new Date();
  return Membership.findOne({
    user_id: userId,
    status: "active",
    $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    $expr: { $lt: ["$eventsUsed", "$eventsTotal"] },
  }).sort({ createdBy: -1 });
}

/**
 * Atomically spends one credit for a booking. Returns the updated membership
 * doc, or null if the user has no usable pass (caller then charges normally).
 */
async function consumeCredit(userId) {
  const now = new Date();
  return Membership.findOneAndUpdate(
    {
      user_id: userId,
      status: "active",
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
      $expr: { $lt: ["$eventsUsed", "$eventsTotal"] },
    },
    { $inc: { eventsUsed: 1 }, $set: { updatedBy: now } },
    { new: true }
  );
}

/** Gives a credit back (e.g. a pass-covered booking is cancelled). */
async function refundCredit(membershipId) {
  if (!membershipId) return;
  await Membership.updateOne(
    { _id: membershipId, eventsUsed: { $gt: 0 } },
    { $inc: { eventsUsed: -1 }, $set: { updatedBy: new Date() } }
  );
}

/** Builds + stores the pass PDF (snapshot at issue/edit time). Non-fatal. */
async function generatePassPdf(membership, user) {
  if (!s3.isConfigured) return null;
  try {
    const buffer = await buildPassPdf({
      qrText: membership.memberId,
      tierLabel: `${membership.eventsTotal} Events · 1 Year`,
      eventsUsed: membership.eventsUsed,
      eventsTotal: membership.eventsTotal,
      name: user?.name || null,
      city: membership.city || user?.city || null,
      memberId: membership.memberId,
      validThrough: membership.expiresAt
        ? new Date(membership.expiresAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })
        : "—",
    });
    const { url } = await s3.uploadBuffer(buffer, {
      originalName: `pass-${membership.memberId}.pdf`,
      mimetype: "application/pdf",
      prefix: "passes/",
    });
    return url;
  } catch (err) {
    console.error("generatePassPdf failed:", err.message);
    return null;
  }
}

/* ----------------------------- customer ----------------------------- */

/** GET /api/membership/me — the customer's active pass (or null). */
const getMyMembership = async (req, res) => {
  try {
    const m = await getActiveMembership(req.user._id);
    return res.status(200).json({
      message: "Membership",
      data: m ? publicMembership(m) : null,
      // Pricing so the site can show a purchase CTA when there's no pass.
      plan: { tier: "golden", events: PASS.events, days: PASS.days, price: PASS.price },
      statusCode: 200,
    });
  } catch (error) {
    console.error("getMyMembership error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * POST /api/membership/purchase — buy a Golden Pass.
 * Creates a PENDING membership and a Razorpay order; the pass is only activated
 * after payment is verified (POST /api/membership/verify). In mock mode it
 * activates immediately (no gateway).
 */
const purchaseMembership = async (req, res) => {
  try {
    const existing = await getActiveMembership(req.user._id);
    if (existing) {
      return res.status(409).json({ message: "You already have an active Golden Pass", statusCode: 409 });
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + PASS.days * 24 * 3600 * 1000);
    const seq = await Counter.next("member:golden");
    const memberId = `TX-GOLD-${String(seq).padStart(4, "0")}`;

    const membership = await Membership.create({
      user_id: req.user._id,
      tier: "golden",
      memberId,
      eventsTotal: PASS.events,
      eventsUsed: 0,
      status: "pending",
      price: PASS.price,
      city: req.body.city || req.user.city || null,
      startsAt: now,
      expiresAt,
      createdBy: now,
      updatedBy: now,
    });

    // Mock mode → activate straight away (dev only).
    if (MOCK_PAYMENTS) {
      membership.status = "active";
      membership.payment_id = `mock_pass_${seq}`;
      membership.passUrl = await generatePassPdf(membership, req.user);
      await membership.save();
      return res.status(201).json({
        message: "Golden Pass activated",
        data: publicMembership(membership),
        payment: { mock: true },
        statusCode: 201,
      });
    }

    // Real payment: create a Razorpay order for the pass price.
    const amountInPaise = Math.round(PASS.price * 100);
    const gateway = await createGatewayOrder(amountInPaise, `PASS-${memberId}`);

    return res.status(201).json({
      message: "Golden Pass reserved — complete payment",
      data: publicMembership(membership),
      payment: {
        paymentOrderId: gateway.paymentOrderId,
        keyId: RZP_KEY_ID || null,
        amount: amountInPaise,
        currency: "INR",
        mock: false,
      },
      statusCode: 201,
    });
  } catch (error) {
    console.error("purchaseMembership error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * POST /api/membership/verify — confirm the Golden Pass payment and activate it.
 * Body: { membershipId, razorpay_order_id, razorpay_payment_id, razorpay_signature }
 */
const verifyMembership = async (req, res) => {
  try {
    const { membershipId, razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;
    const membership = await Membership.findById(membershipId);
    if (!membership) return res.status(404).json({ message: "Membership not found", statusCode: 404 });
    if (String(membership.user_id) !== String(req.user._id)) {
      return res.status(403).json({ message: "This pass is not yours", statusCode: 403 });
    }
    if (membership.status === "active") {
      return res.status(200).json({ message: "Already active", data: publicMembership(membership), statusCode: 200 });
    }

    const ok = verifyGatewaySignature({ razorpay_order_id, razorpay_payment_id, razorpay_signature });
    if (!ok) {
      return res.status(400).json({ message: "Payment verification failed", statusCode: 400 });
    }

    membership.status = "active";
    membership.payment_id = razorpay_payment_id;
    membership.updatedBy = new Date();
    membership.passUrl = await generatePassPdf(membership, req.user);
    await membership.save();

    return res.status(200).json({
      message: "Golden Pass activated",
      data: publicMembership(membership),
      statusCode: 200,
    });
  } catch (error) {
    console.error("verifyMembership error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/* ------------------------------- admin ------------------------------- */

/** GET /api/admin/memberships — paginated list. */
const listMemberships = async (req, res) => {
  try {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 20));
    const search = (req.query.search || "").trim();
    const status = (req.query.status || "").trim();

    const filter = {};
    if (status) filter.status = status;
    if (search) filter.memberId = { $regex: search, $options: "i" };

    const [rows, total] = await Promise.all([
      Membership.find(filter)
        .populate("user_id", "name email phone")
        .sort({ createdBy: -1 })
        .skip((page - 1) * limit)
        .limit(limit),
      Membership.countDocuments(filter),
    ]);

    return res.status(200).json({
      message: "Memberships",
      data: rows.map(publicMembership),
      meta: { page, limit, total, pages: Math.ceil(total / limit) },
      statusCode: 200,
    });
  } catch (error) {
    console.error("listMemberships error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/**
 * PATCH /api/admin/memberships/:id — extend, adjust credits, or change status.
 * Body may include: { addDays, eventsTotal, status }.
 */
const updateMembership = async (req, res) => {
  try {
    const m = await Membership.findById(req.params.id).populate("user_id", "name email city");
    if (!m) return res.status(404).json({ message: "Membership not found", statusCode: 404 });

    const { addDays, eventsTotal, status } = req.body;
    if (addDays) {
      const base = m.expiresAt && m.expiresAt > new Date() ? m.expiresAt : new Date();
      m.expiresAt = new Date(new Date(base).getTime() + Number(addDays) * 24 * 3600 * 1000);
    }
    if (eventsTotal != null) m.eventsTotal = Math.max(m.eventsUsed, Number(eventsTotal));
    if (status && ["active", "expired", "cancelled"].includes(status)) {
      m.status = status;
      if (status === "cancelled") m.cancelledAt = new Date();
    }
    m.updatedBy = new Date();

    // Refresh the printed snapshot to reflect the edit.
    m.passUrl = (await generatePassPdf(m, m.user_id)) || m.passUrl;
    await m.save();

    return res.status(200).json({ message: "Membership updated", data: publicMembership(m), statusCode: 200 });
  } catch (error) {
    console.error("updateMembership error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

/** DELETE /api/admin/memberships/:id — revoke (soft cancel). */
const revokeMembership = async (req, res) => {
  try {
    const m = await Membership.findById(req.params.id);
    if (!m) return res.status(404).json({ message: "Membership not found", statusCode: 404 });
    m.status = "cancelled";
    m.cancelledAt = new Date();
    m.updatedBy = new Date();
    await m.save();
    return res.status(200).json({ message: "Membership revoked", data: { _id: m._id, status: m.status }, statusCode: 200 });
  } catch (error) {
    console.error("revokeMembership error:", error);
    return res.status(500).json({ message: "Server Error", statusCode: 500 });
  }
};

module.exports = {
  getMyMembership,
  purchaseMembership,
  verifyMembership,
  listMemberships,
  updateMembership,
  revokeMembership,
  // shared with the order flow
  getActiveMembership,
  consumeCredit,
  refundCredit,
};
