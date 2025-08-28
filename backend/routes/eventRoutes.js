const express = require("express");
const router = express.Router();
const eventController = require("../controllers/eventController");
const connectDB = require("../config/db");
const upload = require("../middlewares/uploadImage");

router.route(
  "/",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  eventController.getEvents
);

module.exports = router;
