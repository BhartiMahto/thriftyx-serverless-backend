const express = require("express");
const router = express.Router();
const connectDB = require("../config/db");
const uploadController = require("../controllers/uploadController");
const { protectUser } = require("../middlewares/userAuthMiddleware");

// Signature for a direct browser -> Cloudinary video upload (checkout answers).
// Authenticated: only a signed-in customer can request one.
router.get(
  "/video-signature",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  protectUser,
  uploadController.getVideoUploadSignature
);

module.exports = router;
