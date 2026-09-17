const express = require("express");
const router = express.Router();
const connectDB = require("../config/db");
const ctrl = require("../controllers/eventApplicationController");
const { protect } = require("../middlewares/authMiddleware");

const withDb = async (req, res, next) => { await connectDB(); next(); };

/* ---- Login-free payment (approved application) — literal paths first ---- */
router.get("/pay/:token", withDb, ctrl.getApplicationPayInfo);
router.post("/pay/:token", withDb, ctrl.payApplication);
router.post("/pay/:token/verify", withDb, ctrl.verifyApplicationPayment);

/* ---- Admin (before "/:id") ---- */
router.get("/admin/list", withDb, protect, ctrl.listApplications);
router.post("/admin/create", withDb, protect, ctrl.adminCreateApplication);
router.patch("/admin/:id", withDb, protect, ctrl.updateApplication);

/* ---- Public apply form + submit ---- */
router.get("/:id/info", withDb, ctrl.getApplyInfo);
router.post("/:id", withDb, ctrl.submitApplication);

module.exports = router;
