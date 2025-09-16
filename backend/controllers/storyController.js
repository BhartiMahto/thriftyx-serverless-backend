const Story = require("../models/storyModel");
const cloudinary = require("../utils/cloudinary");
const streamifier = require("streamifier");

const addStory = async (req, res) => {
  try {
    const { storyTitle, yourStory, author, tags } = req.body;
    const file = req.file;

    if (!file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const tagsArray = Array.isArray(tags) ? tags : (tags ? [tags] : []);

    const result = await cloudinary.uploader.upload_stream(
      { resource_type: "auto", folder: "stories" },
      async (error, result) => {
        if (error) {
          console.error("Cloudinary Upload Error:", error);
          return res.status(500).json({ message: error.message });
        }

        const newStory = new Story({
          storyTitle,
          yourStory,
          author,
          tags: tagsArray,
          imageOrVideoUrl: result.secure_url,
          fileType: file.mimetype,
        });

        const savedStory = await newStory.save();
        res.status(201).json(savedStory);
      }
    );

    streamifier.createReadStream(file.buffer).pipe(result);
  } catch (err) {
    console.error("Server Error in addStory:", err);
    res.status(500).json({ message: err.message });
  }
};

const getStories = async (req, res) => {
  try {
    const filter = {};

    if (req.query.status) {
      filter.status = req.query.status;
    }

    const stories = await Story.find(filter).sort({ createdAt: -1 });

    if (!stories) {
      return res.status(404).json({
        message: "Story not found",
      });
    }
    return res.status(200).json(stories);
  } catch (err) {
    res.status(500).json({
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

const getStoryById = async (req, res) => {
  try {
    const story = await Story.findById(req.params.id);
    if (!story) {
      return res.status(404).json({ message: "Story not found" });
    }
    return res.status(200).json(story);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

const updateStoryStatus = async (req, res) => {
    try {
        const { status } = req.body;
        if (!['accepted', 'rejected'].includes(status)) {
            return res.status(400).json({ message: "Invalid status provided." });
        }

        const story = await Story.findByIdAndUpdate(
            req.params.id,
            { status },
            { new: true }
        );

        if (!story) {
            return res.status(404).json({ message: "Story not found" });
        }

        res.status(200).json(story);
    } catch (err) {
        res.status(500).json({ message: "Internal server error", error: err.message });
    }
};

const updateStory = async (req, res) => {
  try {
    const { storyTitle, yourStory, author, tags, date } = req.body;
    const file = req.file;

    let updateData = { storyTitle, yourStory, author, date, tags: tags ? tags.split(',').map(t => t.trim()) : [] };

    if (file) {
      const result = await new Promise((resolve, reject) => {
        const uploadStream = cloudinary.uploader.upload_stream(
          { resource_type: "auto", folder: "stories" },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        streamifier.createReadStream(file.buffer).pipe(uploadStream);
      });
      updateData.imageOrVideoUrl = result.secure_url;
    }

    const updatedStory = await Story.findByIdAndUpdate(req.params.id, updateData, { new: true });

    if (!updatedStory) {
      return res.status(404).json({ message: "Story not found" });
    }
    res.status(200).json(updatedStory);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { addStory, getStories, deleteStory, getStoryById, updateStoryStatus, updateStory };
