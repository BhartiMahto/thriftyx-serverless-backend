const mongoose = require("mongoose");

/**
 * Atomic named counters. Used to allocate gap-free sequential invoice numbers
 * per financial year (id = `invoice:2026-27`), so two concurrent payments can
 * never be issued the same number.
 */
const Counter = new mongoose.Schema({
  _id: { type: String }, // e.g. "invoice:2026-27"
  seq: { type: Number, default: 0 },
});

/** Atomically increments and returns the next value for a counter key. */
Counter.statics.next = async function (key) {
  const doc = await this.findByIdAndUpdate(
    key,
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  );
  return doc.seq;
};

module.exports = mongoose.model("counter", Counter);
