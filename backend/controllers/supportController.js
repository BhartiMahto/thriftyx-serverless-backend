const Support = require("../models/supportModel");

const createSupport = async (req, res) => {
  try {
    const { name, email, subject, message, status } = req.body;
    const support = await Support.create({
      name,
      email,
      subject,
      message,
      status,
    });
    res.status(201).json({ // Use 201 for resource creation
      result: support,
    });
  } catch (err) {
    res.status(500).json({
      message: err.message,
    });
  }
};

const getSupports = async (req, res) => {
  try {
    const supports = await Support.find({}).sort({ createdAt: -1 }); // Sort by most recent
    if (!supports) {
      return res.status(404).json({ // Use 404 for not found
        message: "supports not found",
      });
    }
    return res.status(200).json({
      result: supports,
    });
  } catch (err) {
    res.status(500).json({
      message: err.message,
    });
  }
};

const deleteSupport = async (req, res) => {
  try {
    const deleted = await Support.findByIdAndDelete(req.params.id);
    if (!deleted) {
      return res.status(404).json({ message: "Support ticket not found" });
    }
    res.status(200).json({
      message: "deleted successfully",
    });
  } catch (err) {
    res.status(500).json({
      message: err.message,
    });
  }
};

const getSupport = async (req, res) => {
  try {
    const support = await Support.findById(req.params.id);
    if (!support) {
      return res.status(404).json({ // Use 404 for not found
        message: "not found",
      });
    }
    return res.status(200).json({
        result: support
    })
  } catch (err) {
    res.status(500).json({
      message: err.message,
    });
  }
};

// NEW: Function to update a support ticket (e.g., status)
const updateSupport = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    if (!status) {
      return res.status(400).json({
        message: "Status field is required for update.",
      });
    }

    const updatedSupport = await Support.findByIdAndUpdate(
      id,
      { status },
      { new: true, runValidators: true }
    );

    if (!updatedSupport) {
      return res.status(404).json({ message: "Support ticket not found" });
    }

    return res.status(200).json({
      message: "Support ticket updated successfully",
      data: updatedSupport,
    });
  } catch (err) {
    console.error("Error updating support ticket:", err);
    return res.status(500).json({ message: err.message });
  }
};

module.exports = { createSupport, getSupports, deleteSupport, getSupport, updateSupport };