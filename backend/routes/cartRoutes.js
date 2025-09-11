const express = require("express")
const connectDB = require("../config/db")
const router = express.Router();
const cartController = require("../controllers/cartController")

router.post("/", async (req, res, next) => {
    await connectDB();
    next();
}, cartController.addToCart)

router.get("/", async (req, res, next) => {
    await connectDB();
    next();
}, cartController.getCartItems)

module.exports = router