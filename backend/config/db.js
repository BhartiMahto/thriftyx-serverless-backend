const mongoose = require("mongoose");
let isConnected;

const connectDB = async () => {
  if (isConnected) return;

  console.log("Connecting to MongoDB...");

  try {
    await mongoose.connect(process.env.MONGO_URI, {
      serverSelectionTimeoutMS: 10000,
    });
    isConnected = true;
    console.log("MongoDB connected");
  } catch (error) {
    console.error("MongoDB connection failed:", error.message);
    throw error;
  }
};

module.exports = connectDB;
