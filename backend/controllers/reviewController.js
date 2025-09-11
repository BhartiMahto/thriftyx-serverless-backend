const Review = require('../models/reviewModel');

const getReviews = async (req, res) => {
    try {
        const reviews = await Review.find()
            .sort({ date: -1 })
            .populate('eventId', 'eventName'); // Fetches the event and includes only its 'eventName' field

        res.status(200).json(reviews);
    } catch (error) {
        res.status(500).json({ message: "Error fetching reviews", error: error.message });
    }
};

module.exports = { getReviews };