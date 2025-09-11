require("dotenv").config();
const express = require("express");
const app = express();
const adminRoutes = require("./routes/adminRoutes");
const subAdminRoutes = require("./routes/subAdminRoutes")
const authRoutes = require("./routes/authRoutes")
const supportRoutes = require("./routes/supportRoutes");
const storyRoutes = require("./routes/storyRoutes");
const eventRoutes = require("./routes/eventRoutes")
const cartRoutes = require("./routes/cartRoutes");
const ratingRoutes = require("./routes/ratingRoutes")
const reviewRoutes = require("./routes/reviewRoutes");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));


app.use("/api/cart", cartRoutes);
// app.use("/api/order", orderRoutes)
app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/subadmin", subAdminRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/ratring", ratingRoutes)
app.use("/api/events", eventRoutes)
app.use("/api/story", storyRoutes)
app.use("/api/reviews", reviewRoutes);

module.exports = app;
