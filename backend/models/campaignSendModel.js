const mongoose = require("mongoose");
const Schema = mongoose.Schema;

/**
 * One row per (campaign, recipient) WhatsApp marketing send. Used to LOG results
 * and to DEDUPE — the unique (campaign, phone) index guarantees a person is
 * never messaged twice for the same campaign, even across batched sends or a
 * re-run.
 */
const CampaignSend = new Schema(
  {
    campaign: { type: String, required: true, index: true }, // e.g. "WELCOMEBACK70"
    user_id: { type: Schema.Types.ObjectId, ref: "users", default: null },
    phone: { type: String, required: true },
    firstName: { type: String, default: "" },
    status: { type: String, enum: ["sent", "failed"], required: true },
    messageSid: { type: String, default: "" },
    error: { type: String, default: "" },
  },
  { timestamps: true }
);

CampaignSend.index({ campaign: 1, phone: 1 }, { unique: true });

module.exports = mongoose.model("campaignSend", CampaignSend);
