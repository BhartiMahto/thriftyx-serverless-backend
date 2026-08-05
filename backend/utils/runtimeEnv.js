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

module.exports = { isDeployed };
