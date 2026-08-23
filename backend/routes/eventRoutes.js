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
// The signed-in user's wishlisted event ids — must precede "/:id".
router.get("/wishlist/mine", withDb, protectUser, eventController.myWishlist);
// More specific routes first so they aren't captured by "/:id".
router.get("/:id/going", withDb, eventController.getEventGoing);
router.get("/:id/interest", withDb, optionalUser, eventController.getInterest);
router.get("/:id/wishlist", withDb, optionalUser, eventController.getWishlist);
router.get("/:id", withDb, eventController.getEventById);

/* ---------------- Interest ("Coming soon") — signed-in users ---------------- */

router.post("/:id/interest", withDb, protectUser, eventController.markInterest);
router.delete("/:id/interest", withDb, protectUser, eventController.unmarkInterest);

/* ---------------- Wishlist (signed-in) + Share (optional auth) ---------------- */

router.post("/:id/wishlist", withDb, protectUser, eventController.addWishlist);
router.delete("/:id/wishlist", withDb, protectUser, eventController.removeWishlist);
router.post("/:id/share", withDb, optionalUser, eventController.recordShare);

/* ---------------- Admin-only writes ----------------
 * POST /api/events was previously unauthenticated — anyone could create an
 * event. All mutations now require an admin JWT.
 */

// Two posters: `image` (wide/horizontal, detail hero) + `cardImage` (square 1:1,
// list card). .fields is a no-op for JSON requests and captures either poster
// when the form sends multipart.
const eventPosters = upload.fields([
  { name: "image", maxCount: 1 },
  { name: "cardImage", maxCount: 1 },
]);
router.post("/", withDb, protect, eventPosters, eventController.createEvent);
router.patch("/:id", withDb, protect, eventPosters, eventController.updateEvent);
router.patch("/:id/status", withDb, protect, eventController.updateEventStatus);
router.delete("/:id", withDb, protect, eventController.deleteEvent);

module.exports = router;
