const express = require("express");
const router = express.Router();
const connectDB = require("../config/db");
const seriesController = require("../controllers/seriesController");
const upload = require("../middlewares/uploadImage");
const { protect } = require("../middlewares/authMiddleware");
const { protectUser } = require("../middlewares/userAuthMiddleware");

const withDb = async (req, res, next) => {
  await connectDB();
  next();
};

const seriesImage = upload.fields([{ name: "image", maxCount: 1 }]);

/* ---------------- Public reads ---------------- */
router.get("/", withDb, seriesController.getSeries);

/* ---------------- Buyer payment (auth) — before "/:id" ---------------- */
router.post("/verify", withDb, protectUser, seriesController.verifySeriesPayment);

/* ---------------- Admin reads (before "/:id") ---------------- */
router.get("/admin/all", withDb, protect, seriesController.listAllSeries);
router.get("/admin/orders", withDb, protect, seriesController.listSeriesOrders);

/* ---------------- Admin create ---------------- */
router.post("/", withDb, protect, seriesImage, seriesController.createSeries);

/* ---------------- Public single + buy (after literal paths) ---------------- */
router.get("/:id", withDb, seriesController.getSeriesById);
router.post("/:id/order", withDb, protectUser, seriesController.createSeriesOrder);

/* ---------------- Admin writes by id ---------------- */
router.patch("/:id/status", withDb, protect, seriesController.setSeriesStatus);
router.patch("/:id", withDb, protect, seriesImage, seriesController.updateSeries);
router.delete("/:id", withDb, protect, seriesController.deleteSeries);

module.exports = router;
