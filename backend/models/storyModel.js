const mongoose = require("mongoose");
const StoryModel = new mongoose.Schema({
  storyTitle: {
    type: String,
    required: true,
    trim: true,
  },
  yourStory: {
    type: String,
    required: true,
    time: true,
  },
  imageOrVideoUrl: {
    type: String,
    required: true,
  },
});

module.exports = mongoose.model("story", StoryModel);
