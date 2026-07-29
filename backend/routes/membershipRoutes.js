const express = require("express");
const router = express.Router();
const connectDB = require("../config/db");
const membershipController = require("../controllers/membershipController");
const { protectUser } = require("../middlewares/userAuthMiddleware");

const withDb = async (req, res, next) => {
  await connectDB();
  next();
};

// Customer Golden Pass endpoints.
router.get("/me", withDb, protectUser, membershipController.getMyMembership);
router.post("/purchase", withDb, protectUser, membershipController.purchaseMembership);
router.post("/verify", withDb, protectUser, membershipController.verifyMembership);

module.exports = router;
