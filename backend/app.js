require("dotenv").config();
const express = require("express");
const cors = require("cors");
const app = express();
const adminRoutes = require("./routes/adminRoutes");
const subAdminRoutes = require("./routes/subAdminRoutes")
const authRoutes = require("./routes/authRoutes")
const supportRoutes = require("./routes/supportRoutes");
const storyRoutes = require("./routes/storyRoutes");
const eventRoutes = require("./routes/eventRoutes")
const cartRoutes = require("./routes/cartRoutes");
const orderRoutes = require("./routes/orderRoutes");
const publicRoutes = require("./routes/publicRoutes");
const userRoutes = require("./routes/userRoutes");
const paymentRoutes = require("./routes/paymentRoutes");
const couponRoutes = require("./routes/couponRoutes");
const membershipRoutes = require("./routes/membershipRoutes");
const ratingRoutes = require("./routes/ratingRoutes")
const reviewRoutes = require("./routes/reviewRoutes");

// Browsers block cross-origin calls without this. The frontend and admin panel
// run on their own Vite dev ports, so both must be allowed explicitly.
const allowedOrigins = (process.env.CORS_ORIGINS || "http://localhost:8080,http://localhost:8081,http://localhost:5173")
  .split(",")
  .map((o) => o.trim())
  .filter(Boolean);

app.use(
  cors({
    origin(origin, callback) {
      // Allow tools with no Origin header (curl, Postman, server-to-server).
      if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
      // Reject by withholding the CORS headers rather than throwing — throwing
      // surfaces a 500 with a stack trace instead of a clean browser-side block.
      return callback(null, false);
    },
    credentials: true,
  })
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.get("/api/health", (req, res) => res.status(200).json({ ok: true }));

// Public read-only endpoints (FAQ, gallery) for the customer website.
app.use("/api", publicRoutes);

app.use("/api/cart", cartRoutes);
app.use("/api/order", orderRoutes);
app.use("/api/user", userRoutes);
app.use("/api/payment", paymentRoutes);
app.use("/api/coupon", couponRoutes);
app.use("/api/membership", membershipRoutes);
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/subadmin", subAdminRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/rating", ratingRoutes)
// Legacy misspelling kept so any already-deployed client keeps working.
app.use("/api/ratring", ratingRoutes)
app.use("/api/events", eventRoutes)
app.use("/api/story", storyRoutes)
app.use("/api/reviews", reviewRoutes);

// Centralised error handler so thrown errors return JSON instead of HTML.
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  res.status(err.status || 500).json({ message: err.message || "Internal Server Error" });
});

module.exports = app;
