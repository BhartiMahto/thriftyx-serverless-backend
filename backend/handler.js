const serverless = require("serverless-http");
const app = require("./app");

module.exports.api = serverless(app);

// Scheduled (EventBridge cron) — sends due pre-event reminders (24h + 3h).
module.exports.reminders = async () => {
  const connectDB = require("./config/db");
  const { sendDueReminders } = require("./controllers/reminderController");
  await connectDB();
  const summary = await sendDueReminders();
  console.log("reminders run:", JSON.stringify(summary));
  return summary;
};
