const express = require("express");
const eventController = require("../controllers/eventController");
const galleryController = require("../controllers/galleryController");
const orderController = require("../controllers/orderController");
const userController = require("../controllers/userController");
const faqController = require("../controllers/faqController");
const supportController = require("../controllers/supportController");
const founderController = require("../controllers/founderController");
const partnerController = require("../controllers/partnerController");
const upload = require("../middlewares/uploadImage");
const connectDB = require("../config/db");

const router = express.Router();

router.get("/", async (req, res, next) => {
  return res.json({ message: "admin route" });
  next();
});

router.get(
  "/events",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  eventController.getEvents
);

router.get(
  "/gallery",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  galleryController.getGallery
);

router.post(
  "/gallery/upload",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  upload.single("image"),
  galleryController.uploadImage
);

router.delete(
  "/gallery/:id",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  galleryController.delteImage
);

router.get(
  "/gallery/download",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  galleryController.downloadAllImage
);

router.get(
  "/orders",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  orderController.getAllOrders
);

router.get(
  "/orders/download",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  orderController.downloadOrders
);

router.get(
  "/users",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  userController.getAllUsers
);

router.get(
  "/customer-count",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  orderController.customerCount
);

router.get(
  "/paid-customer-count",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  orderController.paidCustomerCount
);

router.get(
  "/pending-customer-count",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  orderController.pendingCustomerCount
);

router.get(
  "/avg-spend",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  orderController.avgSpend
);

router.post(
  "/send-reveiw-lnk",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  userController.sendReviewLink
);

router.post(
  "/send-whatsapp",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  userController.sendWhatsappMessage
);

router.post(
  "/send-sms",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  userController.sendSms
);

router.post(
  "/send-mail",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  userController.sendEmail
);

router.post(
  "/addFAQ",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  faqController.addFAQ
);

router.patch(
  "/faq/:id",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  faqController.updateFAQ
);

router.delete(
  "/faq/:id",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  faqController.deleteFAQ
);

router.get(
  "/supports",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  supportController.getSupports
);

router.delete(
  "/supports/:id",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  supportController.deleteSupport
);

router.get(
  "/supports/:id",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  supportController.getSupport
);

router.post(
  "/founder",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  founderController.addFounder
);

router.get(
  "/founder",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  founderController.getfounders
);

router.get(
  "/founder/:id",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  founderController.getFounderById
);

router.patch(
  "/founder/:id",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  founderController.updateFounder
);

router.delete(
  "/founder/:id",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  founderController.deleteFounder
);

router.post(
  "/partner",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  partnerController.addPartner
);

module.exports = router;
