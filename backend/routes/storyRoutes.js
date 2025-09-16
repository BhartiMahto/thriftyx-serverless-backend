const express = require("express");
const router = express.Router();
const storyController = require("../controllers/storyController");
const connectDB = require("../config/db");
const upload = require("../middlewares/uploadImage");

router.post(
  "/",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  upload.single("imageOrVideoUrl"),
  storyController.addStory
);

router.get(
  "/",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  storyController.getStories
);

router.get(
  "/:id",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  storyController.getStoryById
);

router.patch(
  "/:id/status",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  storyController.updateStoryStatus
);

router.delete(
  "/:id",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  storyController.deleteStory
);

router.patch(
  "/:id",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  upload.single("imageOrVideoUrl"),
  storyController.updateStory
);

module.exports = router;
