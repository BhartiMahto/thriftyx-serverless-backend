const Gallery = require("../models/galleryModel");
const s3 = require("../utils/s3");
const archiver = require("archiver");
const axios = require("axios");

/**
 * Gallery images are stored in S3 (bucket from S3_BUCKET). Records created
 * before this change hold Cloudinary URLs — those still display fine, and
 * deleting one removes the database row without touching Cloudinary.
 */

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
    if (!s3.isConfigured) {
      return res.status(503).json({ message: "S3 is not configured on the server" });
    }
    if (!String(req.file.mimetype || "").startsWith("image/")) {
      return res.status(400).json({ message: "Only image files are allowed" });
    }

    const { category, tag } = req.body;

    const { url } = await s3.uploadBuffer(req.file.buffer, {
      originalName: req.file.originalname,
      mimetype: req.file.mimetype,
    });

    const savedGallery = await new Gallery({ image: url, category, tag }).save();
    res.status(201).json(savedGallery);
  } catch (error) {
    console.error("Upload error:", error);
    res.status(500).json({ message: "Error uploading image", error: error.message });
  }
};

const deleteImage = async (req, res) => {
  try {
    const deletedImage = await Gallery.findByIdAndDelete(req.params.id);
    if (!deletedImage) {
      return res.status(404).json({ message: "Image not found to delete" });
    }

    // The previous version deleted only the database row, orphaning the file in
    // storage forever. Remove the S3 object too — deleteByUrl returns false for
    // non-S3 (legacy Cloudinary) URLs rather than throwing.
    let fileRemoved = false;
    try {
      fileRemoved = await s3.deleteByUrl(deletedImage.image);
    } catch (err) {
      // The record is already gone; report the orphan rather than failing.
      console.error("S3 delete failed for", deletedImage.image, err.message);
    }

    res.status(200).json({
      message: "Image deleted successfully",
      fileRemoved,
      note: fileRemoved ? undefined : "Record removed; the stored file was not on S3.",
    });
  } catch (err) {
    res.status(500).json({ message: "Internal server error", error: err.message });
  }
};

/**
 * GET /api/admin/gallery/s3 — lists objects in the bucket, flagging which are
 * already in the gallery. Lets the dashboard pull in files uploaded to S3
 * outside the app.
 */
const listS3Objects = async (req, res) => {
  try {
    if (!s3.isConfigured) {
      return res.status(503).json({ message: "S3 is not configured on the server" });
    }

    const { prefix = "", token, onlyNew } = req.query;
    const pageSize = Math.min(Number(req.query.limit) || 60, 200);
    const imageExt = /\.(jpe?g|png|gif|webp|avif|bmp|svg)$/i;

    const known = new Set((await Gallery.find({}, "image").lean()).map((g) => g.image));

    // The bucket mixes images with ~1000 non-image files (PDFs, tickets), so a
    // single S3 page can contain almost no images. Keep paging until we've
    // collected a full page of images rather than returning a near-empty list.
    const collected = [];
    let continuationToken = token || undefined;
    let isTruncated = false;
    let pagesScanned = 0;

    do {
      const page = await s3.listObjects({ prefix, maxKeys: 1000, continuationToken });
      pagesScanned += 1;

      for (const obj of page.objects) {
        if (!imageExt.test(obj.key)) continue;
        const inGallery = known.has(obj.url);
        if (onlyNew === "true" && inGallery) continue;
        collected.push({ ...obj, inGallery });
        if (collected.length >= pageSize) break;
      }

      continuationToken = page.nextToken || undefined;
      isTruncated = page.isTruncated;
    } while (collected.length < pageSize && continuationToken && pagesScanned < 10);

    res.status(200).json({
      objects: collected,
      nextToken: continuationToken || null,
      isTruncated,
      bucket: s3.BUCKET,
    });
  } catch (error) {
    console.error("listS3Objects error:", error);
    res.status(500).json({ message: "Error listing S3 objects", error: error.message });
  }
};

/** POST /api/admin/gallery/import — adds already-in-S3 objects to the gallery. */
const importFromS3 = async (req, res) => {
  try {
    if (!s3.isConfigured) {
      return res.status(503).json({ message: "S3 is not configured on the server" });
    }

    const { urls, category, tag } = req.body;
    if (!Array.isArray(urls) || urls.length === 0) {
      return res.status(400).json({ message: "urls must be a non-empty array" });
    }

    // Only accept URLs actually in our bucket — this endpoint must not become a
    // way to write arbitrary third-party links into the gallery.
    const valid = urls.filter((u) => s3.keyFromUrl(u));
    const rejected = urls.length - valid.length;

    const existing = new Set(
      (await Gallery.find({ image: { $in: valid } }, "image").lean()).map((g) => g.image)
    );
    const toCreate = valid.filter((u) => !existing.has(u));

    const created = toCreate.length
      ? await Gallery.insertMany(toCreate.map((image) => ({ image, category, tag })))
      : [];

    res.status(201).json({
      message: "Import complete",
      imported: created.length,
      skippedAlreadyPresent: valid.length - toCreate.length,
      rejectedNotInBucket: rejected,
      data: created,
    });
  } catch (error) {
    console.error("importFromS3 error:", error);
    res.status(500).json({ message: "Error importing from S3", error: error.message });
  }
};

const setHeroImage = async (req, res) => {
  try {
    const { id } = req.params;
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

    res.setHeader("Content-Disposition", "attachment; filename=gallery_images.zip");
    res.setHeader("Content-Type", "application/zip");

    const archive = archiver("zip");

    // IMPORTANT: This tells the response to end only when the archive is finished.
    archive.on('end', () => {
      console.log('Archive stream has ended.');
      res.end();
    });

    // Handle any errors that occur during archiving
    archive.on('error', (err) => {
      console.error("Archive error:", err);
      // End the response abruptly on error
      res.status(500).send({ error: err.message });
    });

    // Pipe the archive data to the response
    archive.pipe(res);

    if (!images || images.length === 0) {
      archive.finalize();
      return;
    }

    // Use Promise.all to fetch all images before finalizing
    await Promise.all(images.map(async (img) => {
      try {
        const response = await axios({
          url: img.image,
          method: 'GET',
          responseType: 'stream'
        });
        const extension = img.image.split('.').pop() || 'jpg';
        const fileName = `${(img.category || 'image').replace(/[^\w\s]/gi, "").replace(/ /g, "_")}_${img._id}.${extension}`;
        archive.append(response.data, { name: fileName });
      } catch (error) {
        console.error(`Could not download image ${img.image}: ${error.message}`);
        archive.append(`Failed to download: ${img.image}`, { name: `error_${img._id}.txt` });
      }
    }));
    
    // Finalize the archive. This will trigger the 'end' event when done.
    archive.finalize();

  } catch (err) {
    console.error("Error in downloadAllImage function:", err);
    if (!res.headersSent) {
      res.status(500).json({ message: "Download failed due to a server error." });
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
  listS3Objects,
  importFromS3,
};