const Event = require("../models/EventModel");

const getEvents = async (req, res) => {
  try {
    const events = await Event.find().limit(5);

    res.status(200).json(events);
  } catch (err) {
    console.error("Error fetching events:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

module.exports = { getEvents };
