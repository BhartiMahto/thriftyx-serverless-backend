const express = require("express");
const router = express.Router();
const connectDB = require("../config/db");
const profileController = require("../controllers/profileController");
const { protectUser } = require("../middlewares/userAuthMiddleware");
const upload = require("../middlewares/uploadImage");

const withDb = async (req, res, next) => {
  await connectDB();
  next();
};

// Every route here is scoped to the authenticated customer ("me"), so there is
// no id in the path and no way to read another user's profile.
router.get("/me", withDb, protectUser, profileController.getMyProfile);
router.patch("/me", withDb, protectUser, profileController.updateMyProfile);
router.get("/me/stats", withDb, protectUser, profileController.getMyStats);
// Email/phone change is OTP-gated: request sends a code to the NEW value,
// verify commits it. Uniqueness is enforced against all other accounts.
router.post("/me/contact/request", withDb, protectUser, profileController.requestContactChange);
router.post("/me/contact/verify", withDb, protectUser, profileController.verifyContactChange);
router.post(
  "/me/avatar",
  withDb,
  protectUser,
  upload.single("profilePicture"),
  profileController.updateMyAvatar
);

module.exports = router;
