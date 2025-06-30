const Gallery = require("../models/galleryModel");
const cloudinary = require("../utils/cloudinary");
const fs = require("fs");
const path = require("path");
const archiver = require("archiver");
const { Readable } = require("stream");

const getGallery = async (req, res) => {
  try {
    const gallery = await Gallery.find();
    res.status(200).json(gallery);
  } catch (error) {
    res.status(400).json({
      message: error.message,
    });
  }
};

const uploadImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "eventImages" },
        (error, result) => {
          if (error) reject(error);
          else resolve(result);
        }
      );

      const bufferStream = new Readable();
      bufferStream.push(req.file.buffer);
      bufferStream.push(null);
      bufferStream.pipe(stream);
    });

    const newGallery = new Gallery({
      image: result.secure_url,
      category: req.body.category,
      tag: req.body.tag,
    });

    const savedGallery = await newGallery.save();
    res.status(201).json(savedGallery);
  } catch (error) {
    console.error("Upload error:", error);
    res.status(400).json({ message: error.message });
  }
};

const delteImage = async (req, res) => {
  try {
    const deletedImage = await Gallery.findByIdAndDelete(req.params.id);
    if (!deletedImage) {
      res.status(404).json({
        message: "image not found to delete",
      });
    }
    res.status(200).json({
      message: "Image deleted successfully",
    });
  } catch (err) {
    res.status(500).json({
      message: "Internal server error",
      error: err.message,
    });
  }
};

const downloadAllImage = async (req, res) => {
  try {
    const images = await Gallery.find();

    if (!images.length) {
      return res.status(404).json({ message: "No images found" });
    }

    res.setHeader("Content-Disposition", "attachment; filename=gallery_images.zip");
    res.setHeader("Content-Type", "application/zip");

    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.pipe(res);
    archive.on("error", (err) => {
      throw err;
    });

    images.forEach((img) => {
      const filePath = path.join(__dirname, "../public", img.image);
      if (fs.existsSync(filePath)) {
        archive.file(filePath, { name: img.image });
      }
    });

    await archive.finalize();
  } catch (err) {
    console.error("Download error:", err.message);
    res.status(500).json({
      message: "Download failed",
    });
  }
}

module.exports = { uploadImage, getGallery, delteImage, downloadAllImage };
