const AuthController = require("../controllers/authController");
const connectDB = require("../config/db");
const router = require("express").Router();

router.post(
  "/register",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  AuthController.register
);

router.post(
  "/login",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  AuthController.userLogin
);

router.post(
  "/verify-code",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  AuthController.verifyCode
);

router.post(
  "/resend-otp",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  AuthController.resendOTP
);

router.post(
  "/forgot-password",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  AuthController.forgotPassword
);

router.post(
  "/update-password",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  AuthController.updatePassword
);

router.post(
  "/google",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  AuthController.googleLogin
);

// Returns the signed-in admin from the database, so the dashboard can refresh
// a cached profile after a role or permission change.
router.get(
  "/admin/me",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  require("../middlewares/authMiddleware").protect,
  AuthController.adminMe
);

router.post(
  "/admin/login",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  AuthController.adminLogin
);

module.exports = router;
