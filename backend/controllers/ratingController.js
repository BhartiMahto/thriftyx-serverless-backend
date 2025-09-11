const Rating = require("../models/reviewModel");

const getRatings = async (req, res) => {
  try {
    const ratings = await Rating.find({});
    if (ratings.length === 0) {
      return res.status(404).json({ 
        message: "No ratings found",
      });
    }
    return res.status(200).json(ratings);
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

const addRating = async (req, res) => {
  try {
    const newRating = new Rating(req.body);
    const savedRating = await newRating.save();
    return res.status(201).json({ 
      savedRating,
      message: "Successfully added",
    });
  } catch (err) {
    console.error(err.message);
    return res.status(500).json({
      message: "Internal server error",
    });
  }
};

module.exports = {
  getRatings,
  addRating,
};
