const express = require("express");
const router = express.Router();
const reviewController = require("../controllers/reviewController");
const connectDB = require("../config/db");

router.get(
  "/",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  reviewController.getReviews
);

module.exports = router;