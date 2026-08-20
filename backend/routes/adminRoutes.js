const express = require("express");
const eventController = require("../controllers/eventController");
const galleryController = require("../controllers/galleryController");
const orderController = require("../controllers/orderController");
const userController = require("../controllers/userController");
const faqController = require("../controllers/faqController");
const supportController = require("../controllers/supportController");
const founderController = require("../controllers/founderController");
const membershipController = require("../controllers/membershipController");
const partnerController = require("../controllers/partnerController");
const upload = require("../middlewares/uploadImage");
const connectDB = require("../config/db");
const { protect, requireModule, isSuperAdmin } = require("../middlewares/authMiddleware");

const router = express.Router();

router.get("/", async (req, res, next) => {
  return res.json({ message: "admin route" });
});

// Every route below requires a valid admin JWT.
// Previously the whole /api/admin surface (user lists, orders, gallery
// deletion, bulk mail/SMS) was publicly callable with no authentication.
router.use(
  async (req, res, next) => {
    await connectDB();
    next();
  },
  protect
);

router.get(
  "/events",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  eventController.getEvents
);

// --- Cities, blogs, ratings, bookings, customers, support ---
const content = require("../controllers/adminContentController");

router.get("/cities", content.listCities);
router.post("/cities", content.createCity);
router.patch("/cities/:id", content.updateCity);
router.delete("/cities/:id", content.deleteCity);

router.get("/stories", content.listStories);
router.patch("/stories/:id/status", content.setStoryStatus);
router.delete("/stories/:id", content.deleteStory);

router.get("/reviews", content.listReviews);
router.delete("/reviews/:id", content.deleteReview);

router.get("/support-tickets", content.listSupportTickets);
router.patch("/support-tickets/:id", content.updateSupportTicket);

router.get("/customers", content.listCustomers);
router.get("/bookings", content.listBookings);

// Marketing leads (abandoned + converted checkouts).
router.get("/leads", require("../controllers/leadController").listLeads);

// Data exports: guest list (per-attendee, full profile) + sales by city.
const reports = require("../controllers/reportController");
router.get("/reports/guests", reports.guestList);
router.get("/reports/sales-by-city", reports.salesByCity);

// --- Coupons ---
const couponController = require("../controllers/couponController");

router.get("/coupons", couponController.listCoupons);
router.post("/coupons", couponController.createCoupon);
router.patch("/coupons/:id", couponController.updateCoupon);
router.delete("/coupons/:id", couponController.deleteCoupon);

// --- Financial analytics (FinanceInsights / RevenueAnalytics) ---
const analyticsController = require("../controllers/analyticsController");

router.get("/analytics/summary", analyticsController.getSummary);
router.get("/analytics/revenue-timeseries", analyticsController.getRevenueTimeseries);
router.get("/analytics/by-city", analyticsController.getRevenueByCity);
router.get("/analytics/top-events", analyticsController.getTopEvents);
router.get("/analytics/ticket-mix", analyticsController.getTicketMix);
// Website traffic from Google Analytics (GA4 Data API).
router.get("/analytics/traffic", require("../controllers/webTrafficController").getWebTraffic);
router.get("/analytics/realtime", require("../controllers/webTrafficController").getRealtime);
router.get("/analytics/traffic-export", require("../controllers/webTrafficController").getWebTrafficExport);

// --- Financial Insights ledger (super-admin, or sub-admins with "finance" perm) ---
const finance = require("../controllers/financeController");
router.get("/finance/summary", requireModule("finance", "VIEW"), finance.financeSummary);
router.get("/finance/entries", requireModule("finance", "VIEW"), finance.listEntries);
router.post("/finance/entries", requireModule("finance", "EDIT"), finance.createEntry);
router.post("/finance/import", requireModule("finance", "EDIT"), finance.importEntries);
router.patch("/finance/entries/:id", requireModule("finance", "EDIT"), finance.updateEntry);
router.delete("/finance/entries/:id", requireModule("finance", "EDIT"), finance.deleteEntry);
router.post("/finance/reconcile", requireModule("finance", "VIEW"), finance.reconcile);
router.post("/finance/reconcile/confirm", requireModule("finance", "EDIT"), finance.markReconciled);

// --- WhatsApp marketing campaigns (SUPER_ADMIN only — mass outbound messaging) ---
const campaign = require("../controllers/campaignController");
router.get("/campaigns/:campaign/preview", isSuperAdmin, campaign.preview);
router.get("/campaigns/:campaign/recipients", isSuperAdmin, campaign.recipients);
router.post("/campaigns/:campaign/send", isSuperAdmin, campaign.send);
router.get("/campaigns/:campaign/delivery", isSuperAdmin, campaign.delivery);
router.post("/campaigns/:campaign/delivery/refresh", isSuperAdmin, campaign.refreshDelivery);

// --- WhatsApp / SMS inbox: replies customers send to our Twilio number ---
const inbox = require("../controllers/inboxController");
router.get("/inbox", inbox.listInbound);

// --- Attendees (admin panel: AttendeesTab / CheckInView) ---
router.get(
  "/events/:eventId/attendees",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  orderController.getEventAttendees
);

router.patch(
  "/attendees/:orderId/check-in",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  orderController.toggleCheckIn
);

// Confirm or reject a waitlisted application (reject auto-refunds if paid).
router.patch(
  "/bookings/:id/decision",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  orderController.decideApplication
);

// Refund + cancel a single booking.
router.patch(
  "/bookings/:id/refund",
  async (req, res, next) => { await connectDB(); next(); },
  orderController.refundBooking
);

// Reschedule a whole event (moves all its bookings) / cancel an event and
// refund every member.
router.patch(
  "/events/:id/reschedule",
  async (req, res, next) => { await connectDB(); next(); },
  eventController.rescheduleEvent
);
router.post(
  "/events/:id/cancel",
  async (req, res, next) => { await connectDB(); next(); },
  eventController.cancelEvent
);
// Open a "Coming soon" (interest) event for booking and notify interested users.
router.post(
  "/events/:id/go-live",
  async (req, res, next) => { await connectDB(); next(); },
  eventController.goLive
);

// Door check-in: verify a scanned ticket QR token and mark the attendee in.
router.post(
  "/tickets/verify",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  orderController.verifyTicketScan
);

// --- Golden Pass memberships ---
router.get(
  "/memberships",
  async (req, res, next) => { await connectDB(); next(); },
  membershipController.listMemberships
);
router.patch(
  "/memberships/:id",
  async (req, res, next) => { await connectDB(); next(); },
  membershipController.updateMembership
);
router.delete(
  "/memberships/:id",
  async (req, res, next) => { await connectDB(); next(); },
  membershipController.revokeMembership
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

// Browse the S3 bucket and pull existing objects into the gallery.
router.get(
  "/gallery/s3",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  galleryController.listS3Objects
);

router.post(
  "/gallery/import",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  galleryController.importFromS3
);

router.delete(
  "/gallery/:id",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  galleryController.deleteImage
);

router.get(
  "/gallery/download",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  galleryController.downloadAllImage
);

router.patch(
  "/gallery/hero/:id",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  galleryController.setHeroImage
);

router.patch(
  "/gallery/hero/unset/:id",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  galleryController.unsetHeroImage
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

router.get(
  "/FAQ",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  faqController.faqs
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

router.patch(
  "/supports/:id",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  supportController.updateSupport
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
  upload.single("image"),
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
  upload.single("image"),
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
