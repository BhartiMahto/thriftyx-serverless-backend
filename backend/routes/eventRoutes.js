const express = require("express");
const router = express.Router();
const eventController = require("../controllers/eventController");
const connectDB = require("../config/db");
const upload = require("../middlewares/uploadImage");
const { protect } = require("../middlewares/authMiddleware");
const { protectUser, optionalUser } = require("../middlewares/userAuthMiddleware");

const withDb = async (req, res, next) => {
  await connectDB();
  next();
};

/* ---------------- Public reads ---------------- */

router.get("/", withDb, eventController.getEvents);
// The signed-in user's interested event ids — must precede "/:id".
router.get("/interested/mine", withDb, protectUser, eventController.myInterests);
// More specific routes first so they aren't captured by "/:id".
router.get("/:id/going", withDb, eventController.getEventGoing);
router.get("/:id/interest", withDb, optionalUser, eventController.getInterest);
router.get("/:id", withDb, eventController.getEventById);

/* ---------------- Interest ("Coming soon") — signed-in users ---------------- */

router.post("/:id/interest", withDb, protectUser, eventController.markInterest);
router.delete("/:id/interest", withDb, protectUser, eventController.unmarkInterest);

/* ---------------- Admin-only writes ----------------
 * POST /api/events was previously unauthenticated — anyone could create an
 * event. All mutations now require an admin JWT.
 */

router.post("/", withDb, protect, upload.single("image"), eventController.createEvent);
// upload.single("image") is a no-op for JSON requests and captures the poster
// when the edit form sends multipart (image replacement).
router.patch("/:id", withDb, protect, upload.single("image"), eventController.updateEvent);
router.patch("/:id/status", withDb, protect, eventController.updateEventStatus);
router.delete("/:id", withDb, protect, eventController.deleteEvent);

module.exports = router;
