const mongoose = require("mongoose");

/**
 * Discount coupons applied at checkout.
 *
 * `usedCount` is the source of truth for total redemptions and is incremented
 * only when an order is actually created (see orderController), never on the
 * public preview endpoint.
 */
const couponSchema = new mongoose.Schema(
  {
    // Stored uppercase; matching is case-insensitive at entry.
    code: { type: String, required: true, unique: true, uppercase: true, trim: true },
    description: { type: String, default: null },

    discountType: { type: String, enum: ["percent", "flat"], required: true },
    discountValue: { type: Number, required: true, min: 0 },

    // Order subtotal must reach this before the coupon applies.
    minOrderValue: { type: Number, default: 0, min: 0 },
    // Caps the rupee value of a percentage discount (null = no cap).
    maxDiscount: { type: Number, default: null },

    // null = unlimited.
    usageLimit: { type: Number, default: null },
    perUserLimit: { type: Number, default: null },
    usedCount: { type: Number, default: 0 },

    validFrom: { type: Date, default: null },
    validTo: { type: Date, default: null },

    active: { type: Boolean, default: true },
    // Whether the coupon appears in the customer's "available offers" list at
    // checkout. Targeted/secret codes can be unlisted but still work if typed.
    listed: { type: Boolean, default: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Coupon", couponSchema);
