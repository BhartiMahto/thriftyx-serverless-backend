const express = require("express");
const router = express.Router();
const eventController = require("../controllers/eventController");
const connectDB = require("../config/db");
const upload = require("../middlewares/uploadImage");

router.get(
  "/",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  eventController.getEvents
);

router.post(
  "/",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  eventController.createEvent
);

module.exports = router;
