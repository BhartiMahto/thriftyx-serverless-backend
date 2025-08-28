const { Reject } = require("twilio/lib/twiml/VoiceResponse");
const Event = require("../models/eventModel");
const cloudinary = require("../utils/cloudinary");
const streamifier = require("streamifier");

const getEvents = async (req, res) => {
  try {
    const events = await Event.find({});

    res.status(200).json({ size: events.length, events });
  } catch (err) {
    console.error("Error fetching events:", err);
    res.status(500).json({ message: "Internal server error" });
  }
};

const createEvent = async (req, res) => {
  try {
    const {
      name,
      type,
      city,
      venue,
      date,
      tickets,
      min_age,
      max_age,
      venue_name,
      start_time,
      end_time,
      coordinates,
      description,
      instruction,
      status,
    } = req.body;

    const file = req.file;
    console.log(file)
    if (!file) {
      return res.status(400).json({ message: "File not uploaded" });
    }

    const uploadToCloudinary = (fileBuffer) => {
      return new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: "image" },
          (error, result) => {
            if (error) reject(error);
            else resolve(result);
          }
        );
        stream.end(fileBuffer);
      });
    };

    const result = await uploadToCloudinary(file.buffer);

    const newEvent = new Event({
      name,
      type,
      city,
      venue,
      date,
      tickets,
      min_age,
      max_age,
      venue_name,
      start_time,
      end_time,
      coordinates,
      description,
      instruction,
      status,
      image: result.secure_url,
    });

    const savedEvent = await newEvent.save();

    res.status(201).json(savedEvent);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

module.exports = { getEvents, createEvent };
