const Order = require("../models/orderModel");
const MessageHistory = require("../models/messageHistoryModel");
const Support = require("../models/supportModel");
const Lead = require("../models/leadModel");

/**
 * GET /api/admin/alerts — an operational "what needs my attention" feed for the
 * admin, aggregated read-only from existing collections. Each alert carries a
 * count and a `link` (an admin tab id) the UI can deep-link to.
 */
const getAdminAlerts = async (req, res) => {
  try {
    const since = new Date(Date.now() - 30 * 24 * 3600 * 1000); // 30-day window for time-bounded counts

    const [waitlist, pendingRefunds, failedPayments, failedMessages, openSupport, abandonedLeads] =
      await Promise.all([
        Order.countDocuments({ status: "completed", applicationStatus: "waitlist", cancelledAt: null }),
        Order.countDocuments({ "refund.status": { $in: ["pending", "failed", "processing"] } }),
        Order.countDocuments({ status: "failed", createdBy: { $gte: since } }),
        MessageHistory.countDocuments({ status: "failed", createdAt: { $gte: since } }),
        Support.countDocuments({ status: "open" }),
        Lead.countDocuments({ status: "abandoned", createdAt: { $gte: since } }),
      ]);

    // severity: "action" = needs a decision, "warn" = likely a problem, "info" = FYI.
    const alerts = [
      { kind: "waitlist", label: "Applications awaiting review", count: waitlist, link: "waitlist", severity: "action" },
      { kind: "open_support", label: "Open support tickets", count: openSupport, link: "support", severity: "action" },
      { kind: "pending_refunds", label: "Refunds pending / failed", count: pendingRefunds, link: "bookings", severity: "warn" },
      { kind: "failed_messages", label: "Failed message deliveries (30d)", count: failedMessages, link: "notifications", severity: "warn" },
      { kind: "failed_payments", label: "Failed payments (30d)", count: failedPayments, link: "bookings", severity: "info" },
      { kind: "abandoned_leads", label: "Abandoned checkouts (30d)", count: abandonedLeads, link: "leads", severity: "info" },
    ];

    return res.status(200).json({ message: "Admin alerts", data: { alerts }, statusCode: 200 });
  } catch (err) {
    console.error("getAdminAlerts error:", err);
    return res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

module.exports = { getAdminAlerts };
