const { Reject } = require("twilio/lib/twiml/VoiceResponse");
const Event = require("../models/EventModel");
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

/** GET /api/events/:id — single event, used by the public event detail page. */
const getEventById = async (req, res) => {
  try {
    const event = await Event.findById(req.params.id);

    if (!event) {
      return res.status(404).json({ message: "Event not found", statusCode: 404 });
    }

    res.status(200).json({ message: "Event", data: event, statusCode: 200 });
  } catch (err) {
    // A malformed ObjectId throws a CastError rather than returning null.
    if (err.name === "CastError") {
      return res.status(404).json({ message: "Event not found", statusCode: 404 });
    }
    console.error("Error fetching event:", err);
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

/** Fields an admin may change on an event. */
const EDITABLE_EVENT_FIELDS = [
  "name", "type", "city", "venue", "venue_name", "date", "start_time", "end_time",
  "tickets", "description", "instruction", "min_age", "max_age", "cordinates", "image",
];

const EVENT_STATUSES = ["Published", "Unpublished", "Cancelled"];

/** PATCH /api/events/:id — admin edits an event. */
const updateEvent = async (req, res) => {
  try {
    const updates = {};
    for (const field of EDITABLE_EVENT_FIELDS) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    // `coordinates` is the natural spelling; the schema field is `cordinates`.
    if (req.body.coordinates !== undefined) updates.cordinates = req.body.coordinates;

    if (Object.keys(updates).length === 0) {
      return res.status(400).json({ message: "No editable fields provided", statusCode: 400 });
    }

    if (updates.date) {
      const parsed = new Date(updates.date);
      if (Number.isNaN(parsed.getTime())) {
        return res.status(400).json({ message: "date is not valid", statusCode: 400 });
      }
      updates.date = parsed;
    }

    if (updates.tickets && !Array.isArray(updates.tickets)) {
      return res.status(400).json({ message: "tickets must be an array", statusCode: 400 });
    }

    const event = await Event.findByIdAndUpdate(req.params.id, { $set: updates }, { new: true });
    if (!event) {
      return res.status(404).json({ message: "Event not found", statusCode: 404 });
    }

    return res.status(200).json({ message: "Event updated", data: event, statusCode: 200 });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(404).json({ message: "Event not found", statusCode: 404 });
    }
    console.error("updateEvent error:", err);
    return res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

/** PATCH /api/events/:id/status — publish / unpublish / cancel. */
const updateEventStatus = async (req, res) => {
  try {
    const { status } = req.body;

    if (!EVENT_STATUSES.includes(status)) {
      return res.status(400).json({
        message: `status must be one of: ${EVENT_STATUSES.join(", ")}`,
        statusCode: 400,
      });
    }

    const event = await Event.findByIdAndUpdate(
      req.params.id,
      { $set: { status } },
      { new: true }
    );

    if (!event) {
      return res.status(404).json({ message: "Event not found", statusCode: 404 });
    }

    return res.status(200).json({ message: `Event ${status}`, data: event, statusCode: 200 });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(404).json({ message: "Event not found", statusCode: 404 });
    }
    console.error("updateEventStatus error:", err);
    return res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

/** DELETE /api/events/:id — refuses if anyone has already booked. */
const deleteEvent = async (req, res) => {
  try {
    const Order = require("../models/orderModel");

    const bookings = await Order.countDocuments({
      event_id: req.params.id,
      status: { $ne: "cancelled" },
    });

    if (bookings > 0) {
      return res.status(409).json({
        message: `Cannot delete: ${bookings} active booking(s) exist. Cancel the event instead.`,
        statusCode: 409,
      });
    }

    const event = await Event.findByIdAndDelete(req.params.id);
    if (!event) {
      return res.status(404).json({ message: "Event not found", statusCode: 404 });
    }

    return res.status(200).json({ message: "Event deleted", statusCode: 200 });
  } catch (err) {
    if (err.name === "CastError") {
      return res.status(404).json({ message: "Event not found", statusCode: 404 });
    }
    console.error("deleteEvent error:", err);
    return res.status(500).json({ message: "Internal server error", statusCode: 500 });
  }
};

module.exports = {
  getEvents,
  getEventById,
  createEvent,
  updateEvent,
  updateEventStatus,
  deleteEvent,
};
