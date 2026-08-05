const mongoose = require("mongoose");
const { isDeployed } = require("../utils/runtimeEnv");
let isConnected;

/**
 * Which database to use:
 *   Deployed (Lambda) → MONGO_URI            (production)
 *   Local             → MONGO_URI_DEV        (dev; falls back to MONGO_URI if unset)
 */
const activeMongoUri = () =>
  isDeployed
    ? process.env.MONGO_URI
    : process.env.MONGO_URI_DEV || process.env.MONGO_URI;

/** Pulls the database name and host out of a Mongo URI, credentials stripped. */
const describeUri = (uri = "") => {
  const m = uri.match(/^mongodb(?:\+srv)?:\/\/(?:[^@]*@)?([^/?]+)\/?([^?]*)/);
  const host = m ? m[1] : "unknown-host";
  const db = (m && m[2]) || "(default db)";
  return { host, db };
};

const connectDB = async () => {
  if (isConnected) return;

  const uri = activeMongoUri();
  const { host, db } = describeUri(uri);
  console.log(`Connecting to MongoDB → db "${db}" @ ${host} (${isDeployed ? "deployed" : "local"})`);

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 10000,
    });
    isConnected = true;
    // Loud so it's never a mystery which database the app is pointed at.
    console.log(`MongoDB connected → ${db}${/prod/i.test(db) ? "  ⚠️  PRODUCTION" : ""}`);
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    throw error;
  }
};

module.exports = connectDB;
module.exports.describeUri = describeUri;
