const express = require("express");
const router = express.Router();
const connectDB = require("../config/db");
const faqController = require("../controllers/faqController");
const galleryController = require("../controllers/galleryController");
const leadController = require("../controllers/leadController");

/**
 * Read-only endpoints the public website needs.
 *
 * FAQ and gallery previously existed only under /api/admin, which now requires
 * an admin JWT — so the customer site could not reach them. These expose just
 * the GET handlers; all mutations remain admin-only.
 */
const withDb = async (req, res, next) => {
  await connectDB();
  next();
};

router.get("/faq", withDb, faqController.faqs);
router.get("/gallery", withDb, galleryController.getGallery);
router.get("/founders", withDb, require("../controllers/founderController").getPublicFounders);
router.get("/stats", withDb, require("../controllers/statsController").getPublicStats);

// Marketing lead capture — the customer site upserts a guest's checkout details
// (debounced) so abandoned checkouts are still captured. Public (no auth).
router.post("/leads", withDb, leadController.upsertLead);

module.exports = router;
