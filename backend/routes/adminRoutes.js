const express = require("express");
const eventController = require("../controllers/eventController");
const galleryController = require("../controllers/galleryController");
const upload = require("../middlewares/uploadImage");
const connectDB = require("../config/db");

const router = express.Router();

router.get(
  "/events",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  eventController.getEvents
);

router.get(
  "/gallery",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  galleryController.getGallery
);

router.post(
  "/gallery/upload",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  upload.single("image"),
  galleryController.uploadImage
);

router.delete(
  "/gallery/:id",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  galleryController.delteImage
);

router.get(
  "/gallery/download",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  galleryController.downloadAllImage
);

module.exports = router;
