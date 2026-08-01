const express = require("express");
const router = express.Router();
const eventController = require("../controllers/eventController");
const connectDB = require("../config/db");
const upload = require("../middlewares/uploadImage");
const { protect } = require("../middlewares/authMiddleware");

const withDb = async (req, res, next) => {
  await connectDB();
  next();
};

/* ---------------- Public reads ---------------- */

router.get("/", withDb, eventController.getEvents);
// More specific route first so "going" isn't captured by "/:id".
router.get("/:id/going", withDb, eventController.getEventGoing);
router.get("/:id", withDb, eventController.getEventById);

/* ---------------- Admin-only writes ----------------
 * POST /api/events was previously unauthenticated — anyone could create an
 * event. All mutations now require an admin JWT.
 */

router.post("/", withDb, protect, upload.single("image"), eventController.createEvent);
router.patch("/:id", withDb, protect, eventController.updateEvent);
router.patch("/:id/status", withDb, protect, eventController.updateEventStatus);
router.delete("/:id", withDb, protect, eventController.deleteEvent);

module.exports = router;
