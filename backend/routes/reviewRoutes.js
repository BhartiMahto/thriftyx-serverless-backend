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

router.patch(
  "/:id",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  reviewController.updateReview
);

router.delete(
  "/:id",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  reviewController.deleteReview
);

module.exports = router;