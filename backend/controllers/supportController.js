const Support = require("../models/supportModel");

const createSupport = async (req, res) => {
  try {
    const { name, email, subject, message } = req.body;
    const support = await Support.create({
      name,
      email,
      subject,
      message,
    });
    res.status(200).json({
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
    const supports = await Support.find({});
    if (!supports) {
      return res.status(400).json({
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
    await Support.findByIdAndDelete(req.params.id);
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
    console.log(support);
    if (!support) {
      return res.status(400).json({
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

module.exports = { createSupport, getSupports, deleteSupport, getSupport };
