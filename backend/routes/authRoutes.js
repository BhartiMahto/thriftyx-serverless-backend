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
  "/admin/login",
  async (req, res, next) => {
    await connectDB();
    next();
  },
  AuthController.adminLogin
);

module.exports = router;
