/**
 * Plain Node entry point for local development.
 *
 * `handler.js` wraps the same Express app for AWS Lambda. Serverless Framework
 * v4 requires a login/licence key even just to run `serverless offline`, so this
 * lets you develop locally without one. Deployment still goes through
 * serverless/handler.js and is unaffected.
 */
require("dotenv").config();
const app = require("./app");
const connectDB = require("./config/db");

const PORT = process.env.PORT || 3000;

app.listen(PORT, async () => {
  console.log(`API listening on http://localhost:${PORT}`);
  try {
    await connectDB();
  } catch (err) {
    // Routes call connectDB() themselves, so a cold-start failure here is not
    // fatal — surface it rather than crashing the process.
    console.error("Initial MongoDB connection failed:", err.message);
  }
});
