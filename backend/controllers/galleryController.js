const Gallery = require("../models/galleryModel");
const cloudinary = require("../utils/cloudinary");
const { Readable } = require("stream");
const archiver = require("archiver");
const axios = require("axios"); // <<<< ----- ADD THIS LINE

const getGallery = async (req, res) => {
  try {
    const gallery = await Gallery.find().sort({ createdAt: -1 });
    res.status(200).json(gallery);
  } catch (error) {
    res.status(500).json({ message: "Error fetching gallery", error: error.message });
  }
};

const uploadImage = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No file uploaded" });
    }
    const { category, tag } = req.body;

    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream({ folder: "eventImages" }, (error, result) => {
        if (error) reject(error);
        else resolve(result);
      });
      Readable.from(req.file.buffer).pipe(stream);
    });

    const newGalleryItem = new Gallery({
      image: result.secure_url,
      category: category,
      tag: tag,
    });

    const savedGallery = await newGalleryItem.save();
    res.status(201).json(savedGallery);
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ message: "Error uploading image", error: error.message });
  }
};

const deleteImage = async (req, res) => {
  try {
    // Note: This delete function should also remove the image from Cloudinary
    // to be fully effective, which requires the 'image' to be an object with a public_id.
    const deletedImage = await Gallery.findByIdAndDelete(req.params.id);
    if (!deletedImage) {
      return res.status(404).json({ message: "Image not found to delete" });
    }
    res.status(200).json({ message: "Image deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
};

const setHeroImage = async (req, res) => {
  try {
    const { id } = req.params;
    await Gallery.updateMany({ isHeroImage: true }, { $set: { isHeroImage: false } });
    const newHero = await Gallery.findByIdAndUpdate(
      id,
      { $set: { isHeroImage: true } },
      { new: true }
    );
    if (!newHero) {
      return res.status(404).json({ message: 'No image found with that ID' });
    }
    res.status(200).json(newHero);
  } catch (err) {
    res.status(500).json({ message: "Failed to set hero image", error: err.message });
  }
};

const unsetHeroImage = async (req, res) => {
  try {
    const { id } = req.params;
    const unsetImage = await Gallery.findByIdAndUpdate(
      id,
      { $set: { isHeroImage: false } },
      { new: true }
    );
    if (!unsetImage) {
      return res.status(404).json({ message: 'No image found with that ID' });
    }
    res.status(200).json(unsetImage);
  } catch (err) {
    res.status(500).json({ message: "Failed to unset hero image", error: err.message });
  }
};

const downloadAllImage = async (req, res) => {
  try {
    const images = await Gallery.find();
    if (!images || images.length === 0) {
      return res.status(404).json({ message: "No images found to download" });
    }

    res.setHeader("Content-Disposition", "attachment; filename=gallery_images.zip");
    res.setHeader("Content-Type", "application/zip");

    const archive = archiver("zip", { zlib: { level: 9 } });
    archive.on("error", (err) => { throw err; });
    archive.pipe(res);

    for (const img of images) {
      try {
        const response = await axios({
          url: img.image, 
          method: "GET",
          responseType: "stream",
        });
        
        const extension = img.image.split(".").pop();
        const fileName = `${(img.category || 'image').replace(/[^\w\s]/gi, "").replace(/ /g, "_")}_${img._id}.${extension}`;
        archive.append(response.data, { name: fileName });
      } catch (error) {
        console.error(`Could not download image ${img.image}: ${error.message}`);
        archive.append(`Failed to download image ${img._id}`, { name: `error_${img._id}.txt` });
      }
    }
    await archive.finalize();
  } catch (err) {
    console.error("Download error:", err);
    if (!res.headersSent) {
      res.status(500).json({ message: "Download failed", error: err.message });
    }
  }
};

module.exports = {
  uploadImage,
  getGallery,
  deleteImage,
  setHeroImage,
  unsetHeroImage,
  downloadAllImage,
};