const express = require("express");
const router = express.Router();
const supportController = require("../controllers/supportController");
const connectDB = require("../config/db");

router.get(
  "/:id",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  supportController.getSupport
);

router.post(
  "/",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  supportController.createSupport
);


module.exports = router;
