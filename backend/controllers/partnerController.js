const Partner = require("../models/partnerModel");

const addPartner = async (req, res) => {
  try {
    const newParter = new Partner(req.body);
    const savedParter = await newParter.save();
    return res.status(200).json(savedParter);
  } catch (err) {
    console.log("Error", err.message);
    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

module.exports = { addPartner };
