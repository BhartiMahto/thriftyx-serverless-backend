const Founder = require("../models/founderModel");
const s3 = require("../utils/s3");

/**
 * Leadership / founders shown on the public About page.
 * Photos are uploaded to S3 (same bucket as the gallery). Create and update
 * accept multipart with an optional `image` file; the file wins over any
 * `image` URL in the body.
 */

const publicFounder = (f) => ({
  _id: f._id,
  name: f.name ?? null,
  designation: f.designation ?? null,
  description: f.description ?? null,
  image: f.image ?? null,
  order: f.order ?? 0,
});

/** Uploads req.file to S3 if present; returns a URL or null. */
const uploadIfPresent = async (req) => {
  if (!req.file) return null;
  if (!String(req.file.mimetype || "").startsWith("image/")) {
    throw new Error("Only image files are allowed");
  }
  const { url } = await s3.uploadBuffer(req.file.buffer, {
    originalName: req.file.originalname,
    mimetype: req.file.mimetype,
    prefix: "founders/",
  });
  return url;
};

const addFounder = async (req, res) => {
  try {
    const image = (await uploadIfPresent(req)) || req.body.image || null;
    const created = await Founder.create({
      name: req.body.name,
      designation: req.body.designation,
      description: req.body.description,
      order: Number(req.body.order) || 0,
      image,
      createdBy: new Date(),
    });
    res.status(201).json({ message: "Founder added", data: publicFounder(created), statusCode: 201 });
  } catch (err) {
    console.error("addFounder error:", err.message);
    res.status(500).json({ message: err.message, statusCode: 500 });
  }
};

/** Admin list (sorted). */
const getfounders = async (req, res) => {
  try {
    const founders = await Founder.find({}).sort({ order: 1, createdBy: 1 }).lean();
    res.status(200).json({ message: "Founders", data: founders.map(publicFounder), statusCode: 200 });
  } catch (err) {
    res.status(500).json({ message: err.message, statusCode: 500 });
  }
};

/** Public list for the About page — always 200, never 404. */
const getPublicFounders = async (req, res) => {
  try {
    const founders = await Founder.find({}).sort({ order: 1, createdBy: 1 }).lean();
    res.status(200).json({ message: "Founders", data: founders.map(publicFounder), statusCode: 200 });
  } catch (err) {
    res.status(500).json({ message: err.message, statusCode: 500 });
  }
};

const getFounderById = async (req, res) => {
  try {
    const founder = await Founder.findById(req.params.id).lean();
    if (!founder) return res.status(404).json({ message: "No such founder", statusCode: 404 });
    res.status(200).json({ message: "Founder", data: publicFounder(founder), statusCode: 200 });
  } catch (err) {
    res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

const updateFounder = async (req, res) => {
  try {
    const updates = {};
    for (const f of ["name", "designation", "description"]) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }
    if (req.body.order !== undefined) updates.order = Number(req.body.order) || 0;

    const uploaded = await uploadIfPresent(req);
    if (uploaded) updates.image = uploaded;
    else if (req.body.image !== undefined) updates.image = req.body.image;

    const founder = await Founder.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true });
    if (!founder) return res.status(404).json({ message: "No such founder", statusCode: 404 });

    res.status(200).json({ message: "Founder updated", data: publicFounder(founder), statusCode: 200 });
  } catch (err) {
    console.error("updateFounder error:", err.message);
    res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

const deleteFounder = async (req, res) => {
  try {
    const founder = await Founder.findByIdAndDelete(req.params.id);
    if (!founder) return res.status(404).json({ message: "No such founder", statusCode: 404 });
    // Best-effort: remove the S3 photo too (ignores non-S3 / legacy URLs).
    try { await s3.deleteByUrl(founder.image); } catch { /* leave orphan rather than fail */ }
    res.status(200).json({ message: "deleted successfully", statusCode: 200 });
  } catch (err) {
    res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

module.exports = {
  addFounder,
  getfounders,
  getPublicFounders,
  getFounderById,
  updateFounder,
  deleteFounder,
};
