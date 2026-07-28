/**
 * Imports the previous website's gallery into the current Gallery collection.
 *
 * The old admin stored the gallery as a SINGLE document in `gallery_images`
 * holding an array of S3 URLs (see the old AdminController.addGallery, which
 * called GalleryService.updateImage(id, { image }) and errored with "Image Array
 * Not Found"). The current code uses `galleries` — one document per image with
 * category/tag/isHeroImage — so the old images were invisible to it.
 *
 * Idempotent: URLs already present are skipped.
 *
 *   node scripts/importLegacyGallery.js            # dry run
 *   node scripts/importLegacyGallery.js --apply    # write
 */
require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../config/db");
const Gallery = require("../models/galleryModel");

const APPLY = process.argv.includes("--apply");

(async () => {
  try {
    await connectDB();
    const db = mongoose.connection.db;

    const legacy = await db.collection("gallery_images").findOne({});
    const urls = Array.isArray(legacy?.image)
      ? legacy.image.filter((u) => typeof u === "string" && u.startsWith("http"))
      : [];

    if (!urls.length) {
      console.log("No URLs found in gallery_images — nothing to import.");
      process.exit(0);
    }

    const existing = new Set(
      (await Gallery.find({ image: { $in: urls } }, "image").lean()).map((g) => g.image)
    );
    const toCreate = urls.filter((u) => !existing.has(u));

    console.log(`gallery_images holds ${urls.length} URL(s)`);
    console.log(`  already in galleries : ${urls.length - toCreate.length}`);
    console.log(`  to import            : ${toCreate.length}`);

    if (!APPLY) {
      console.log("\nDry run. Re-run with --apply to write these records.");
      process.exit(0);
    }

    if (toCreate.length) {
      await Gallery.insertMany(
        toCreate.map((image) => ({ image, category: "Events", tag: "Gallery" }))
      );
    }

    console.log(`\nImported ${toCreate.length} image(s). Total now: ${await Gallery.countDocuments()}`);
    process.exit(0);
  } catch (err) {
    console.error("Import failed:", err.message);
    process.exit(1);
  }
})();
