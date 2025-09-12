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

router.delete("/:id", async (req, res, next) => {
    await connectDB();
    next();
}, cartController.deleteCartItem);

router.patch("/:id", async (req, res, next) => {
    await connectDB();
    next();
}, cartController.updateCartItem);

module.exports = router