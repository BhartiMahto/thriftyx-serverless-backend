const { body, validationResult } = require("express-validator");

exports.registerValidator = [
    // body("name").notEmpty()
    //             .withMessage("Name Is Required")
    //             .isAlpha()
    //             .withMessage("Invalid Name"),
    // body("email").isEmail().withMessage("Invalid Email"),
    // body("phone").isMobilePhone("en-IN").withMessage("Invalid Phone Number"),
    body("password").isStrongPassword().withMessage("Weak Password"),
    async(req, res, next) => {
        let error = validationResult(req)
        error = error.array()
        if(error.length > 0) return res.status(400).json({error:error})
        next()
    }
]

exports.adminValidator = [
    // body("name").notEmpty()
    //             .withMessage("Name Is Required")
    //             .isAlpha()
    //             .withMessage("Invalid Name"),
    body("email").isEmail().withMessage("Invalid Email"),
    body("password").isStrongPassword().withMessage("Weak Password"),
    async(req, res, next) => {
        let error = validationResult(req)
        error = error.array()
        if(error.length > 0) return res.status(400).json({error:error})
        next()
    }
]

exports.loginValidator = [
    body("phone"),
    body("email"),
    body("password"),
    async(req, res, next) => {
        let error = validationResult(req)
        error = error.array()
        if(error.length > 0) return res.status(400).json({error})
        next();
    }
]
exports.passwordValidator = [
    body("password").isStrongPassword().withMessage("Weak Password"),
    async(req, res, next) => {
        let error = validationResult(req)
        error = error.array()
        if(error.length > 0) return res.status(400).json({error})
        next();
    }
]