const bcrypt = require("bcryptjs");
const Admin = require("../models/adminModel");

const createSubAdmin = async (req, res) => {
  try {
    const { fullName, email, password, permissions } = req.body;

    const exists = await Admin.findOne({ email });
    if (exists) {
      return res.status(400).json({ error: "Email already registered" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);

    const newSubAdmin = new Admin({
      fullName,
      email,
      password: hashedPassword,
      role: "SUB_ADMIN",
      permissions,
    });

    await newSubAdmin.save();
    res
      .status(201)
      .json({ message: "Sub-Admin created successfully", subAdmin: newSubAdmin });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

const getSubAdmins = async (req, res) => {
  try {
    const subAdmins = await Admin.find({ role: "SUB_ADMIN" });
    res.json(subAdmins);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
};

module.exports = {
  createSubAdmin,
  getSubAdmins,
};
