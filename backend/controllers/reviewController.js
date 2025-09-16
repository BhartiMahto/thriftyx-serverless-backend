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

const updateReview = async (req, res) => {
    try {
        const { name, rating, description } = req.body;
        const review = await Review.findByIdAndUpdate(
            req.params.id,
            { name, rating, description },
            { new: true }
        );
        if (!review) {
            return res.status(404).json({ message: "Review not found" });
        }
        res.status(200).json(review);
    } catch (error) {
        res.status(500).json({ message: "Error updating review", error: error.message });
    }
};

const deleteReview = async (req, res) => {
    try {
        const review = await Review.findByIdAndDelete(req.params.id);
        if (!review) {
            return res.status(404).json({ message: "Review not found" });
        }
        res.status(200).json({ message: "Review deleted successfully" });
    } catch (error) {
        res.status(500).json({ message: "Error deleting review", error: error.message });
    }
};

module.exports = { getReviews, updateReview, deleteReview };