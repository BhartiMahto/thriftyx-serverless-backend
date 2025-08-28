const Story = require("../models/storyModel");
const cloudinary = require("../utils/cloudinary");
const streamifier = require("streamifier");

const addStory = async (req, res) => {
  try {
    const { storyTitle, yourStory } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const result = await cloudinary.uploader.upload_stream(
      { resource_type: "auto" },
      async (error, result) => {
        if (error) {
          return res.status(500).json({ message: error.message });
        }

        const newStory = new Story({
          storyTitle,
          yourStory,
          imageOrVideoUrl: result.secure_url,
          fileType: file.mimetype,
        });

        const savedStory = await newStory.save();
        res.status(200).json(savedStory);
      }
    );

    streamifier.createReadStream(file.buffer).pipe(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const getStories = async (req, res) => {
  try {
    const strories = await Story.find({});
    // console.log(strories)
    if (!strories) {
      return res.status(404).json({
        message: "stroy not found",
      });
    }
    return res.status(200).json(strories);
  } catch (err) {
    res.status(500).jons({
      message: err.message,
    });
  }
};

const deleteStory = async (req, res) => {
  try {
    await Story.findByIdAndDelete(req.params.id);
    return res.status(200).json({
      message: "deleted successfully",
    });
  } catch (err) {
    console.log(err.message);
    res.status(500).json({
      message: "Internal server error",
    });
  }
};

module.exports = { addStory, getStories, deleteStory };
