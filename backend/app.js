require("dotenv").config();
const express = require("express");
const app = express();
const adminRoutes = require("./routes/adminRoutes");
const authRoutes = require("./routes/authRoutes")
const supportRoutes = require("./routes/supportRoutes");
const storyRoutes = require("./routes/storyRoutes");
const eventRoutes = require("./routes/eventRoutes")
const reviewRoutes = require("./routes/reviewRoutes");

app.use(express.json());
app.use(express.urlencoded({ extended: true }));


app.use("/api/auth", authRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/support", supportRoutes);
app.use("/api/events", eventRoutes)
app.use("/api/story", storyRoutes)
app.use("/api/reviews", reviewRoutes);

module.exports = app;
