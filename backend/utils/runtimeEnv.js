/**
 * Runtime environment detection.
 *
 * AWS Lambda sets AWS_LAMBDA_FUNCTION_NAME automatically for every function
 * invocation; it is never present when the app runs locally via `node server.js`.
 * We use it as the single source of truth for "am I the deployed backend?".
 *
 *   Deployed (Lambda) → production database + live/real Razorpay
 *   Local            → dev database + Razorpay TEST mode (no real charges)
 */
const isDeployed = Boolean(process.env.AWS_LAMBDA_FUNCTION_NAME);

/**
 * When NOT deployed (local / dev DB), every outgoing email/WhatsApp/SMS is
 * REDIRECTED to these test recipients instead of the real customer — so you can
 * see exactly what would be sent without ever messaging real people. Overridable
 * via env; defaults are the team's test inbox + number.
 */
const DEV_NOTIFY_EMAIL = process.env.DEV_NOTIFY_EMAIL || "help@thriftyx.com";
const DEV_NOTIFY_PHONE = process.env.DEV_NOTIFY_PHONE || "7091845291";

module.exports = { isDeployed, DEV_NOTIFY_EMAIL, DEV_NOTIFY_PHONE };
