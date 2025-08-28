const Founder = require("../models/founderModel");

const addFounder = async (req, res) => {
  try {
    const newFounder = new Founder(req.body);
    const savedFounder = await newFounder.save();
    res.status(200).json(savedFounder);
  } catch (err) {
    res.status(500).json({
      message: err.message,
    });
  }
};

const getfounders = async (req, res) => {
  try {
    const founders = await Founder.find({});
    if (founders.length === 0) {
      return res.status(404).json({
        message: "No founders found",
      });
    }
    return res.status(200).json(founders);
  } catch (err) {
    return res.status(500).json({
      message: err.message,
    });
  }
};

const getFounderById = async (req, res) => {
  try {
    const founder = await Founder.findById(req.params.id);
    if (!founder) {
      return res.status(404).json({
        message: "No such founder",
      });
    }
    return res.status(200).json(founder);
  } catch (err) {
    console.log(err.message);
    res.status(500).json({
      message: "Internal server error",
    });
  }
};

const updateFounder = async (req, res) => {
  try {
    const founder = await Founder.findByIdAndUpdate(req.params.id, req.body, {
      new: true,
      runValidators: true,
    });

    if (!founder) {
      return res.status(404).json({
        message: "No such founder",
      });
    }

    return res.status(200).json(founder);
  } catch (err) {
    console.log(err.message);
    res.status(500).json({
      message: "Internal server error",
    });
  }
};

const deleteFounder = async (req, res) => {
  try {
    await Founder.findByIdAndDelete(req.params.id);
    return res.status(200).json({
      message: "deleted successfully",
    });
  } catch (err) {
    console.log(err.message);
    res.status(500).json({
      message: "Internal server error",
    });
  }
};

module.exports = {
  addFounder,
  getfounders,
  getFounderById,
  updateFounder,
  deleteFounder,
};
