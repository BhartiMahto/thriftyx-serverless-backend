const express = require("express");
const router = express.Router();
const ratingConroller = require("../controllers/ratingController");
const connectDB = require("../config/db");

router.get(
  "/",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  ratingConroller.getRatings
);

router.post(
  "/",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  ratingConroller.addRating
);

module.exports = router;
