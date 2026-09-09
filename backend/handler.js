const serverless = require("serverless-http");
const app = require("./app");

module.exports.api = serverless(app);

// Scheduled (EventBridge cron) — sends due pre-event reminders (24h + 3h) and
// cleans up manually admin-added attendees the day after their event has passed.
module.exports.reminders = async () => {
  const connectDB = require("./config/db");
  const { sendDueReminders } = require("./controllers/reminderController");
  const { cleanupExpiredManualAttendees } = require("./controllers/orderController");
  await connectDB();
  const summary = await sendDueReminders();
  console.log("reminders run:", JSON.stringify(summary));
  // Idempotent daily cleanup — runs on every tick but only deletes past-event
  // manual attendees, so after the first run of the day it's a no-op.
  const cleanup = await cleanupExpiredManualAttendees();
  console.log("manual-attendee cleanup:", JSON.stringify(cleanup));
  return { ...summary, manualCleanup: cleanup };
};
