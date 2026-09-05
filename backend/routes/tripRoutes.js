const express = require("express");
const router = express.Router();
const connectDB = require("../config/db");
const tripController = require("../controllers/tripController");
const upload = require("../middlewares/uploadImage");
const { protect } = require("../middlewares/authMiddleware");

const withDb = async (req, res, next) => {
  await connectDB();
  next();
};

const tripPosters = upload.fields([
  { name: "image", maxCount: 1 },
  { name: "cardImage", maxCount: 1 },
]);

/* ---------------- Public reads ---------------- */
router.get("/", withDb, tripController.getTrips);

// Login-free payment (accepted registration) — more specific than "/:id".
router.get("/pay/:token", withDb, tripController.getRegistrationByToken);
router.post("/pay/:token", withDb, tripController.payRegistration);
router.post("/pay/:token/verify", withDb, tripController.verifyRegistrationPayment);

/* ---------------- Admin reads (before "/:id") ---------------- */
router.get("/admin/all", withDb, protect, tripController.listAllTrips);
router.get("/admin/registrations", withDb, protect, tripController.listRegistrations);
router.patch("/admin/registrations/:id", withDb, protect, tripController.updateRegistration);

/* ---------------- Admin trip writes ---------------- */
router.post("/", withDb, protect, tripPosters, tripController.createTrip);

/* ---------------- Public: single trip + request (after literal paths) ---------------- */
router.get("/:id", withDb, tripController.getTripById);
router.post("/:id/request", withDb, tripController.createRegistration);

/* ---------------- Admin trip writes (by id) ---------------- */
router.patch("/:id/status", withDb, protect, tripController.setTripStatus);
router.patch("/:id", withDb, protect, tripPosters, tripController.updateTrip);
router.delete("/:id", withDb, protect, tripController.deleteTrip);

module.exports = router;
