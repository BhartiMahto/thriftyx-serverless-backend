require("dotenv").config();
const express = require("express");
const app = express();
const adminRoutes = require("./routes/adminRoutes");

app.use(express.json());
app.use("/api/admin", adminRoutes);

module.exports = app;
