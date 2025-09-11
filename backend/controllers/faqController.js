const FAQ = require("../models/faqModel");

const faqs = async (req, res) => {
  try {
    const allFaqs = await FAQ.find({});
    if (!allFaqs)
      return res.status(404).json({
        message: "Not found",
      });
    return res.status(200).json(allFaqs);
  } catch (err) {
    console.log("Error", err.message);
  }
};

const addFAQ = async (req, res) => {
  try {
    const { category, question, answer } = req.body;
    if (!category || !question || !answer) {
      return res.status(400).json({
        message: "All fields are required: category, question, answer",
      });
    }

    // FIX: Added 'await' to ensure the document is created before responding
    const newFAQ = await FAQ.create({ category, question, answer });

    res.status(201).json(newFAQ); // Use 201 for resource creation
  } catch (err) {
    console.log(err);
    res.status(500).json({
      message: err.message,
    });
  }
};

const updateFAQ = async (req, res) => {
  try {
    const { id } = req.params;
    const { category, question, answer } = req.body;

    if (!category && !question && !answer) {
      return res.status(400).json({
        message: "Provide at least one of: category, question, answer",
      });
    }

    const updates = {};
    if (category) updates.category = category;
    if (question) updates.question = question;
    if (answer) updates.answer = answer;

    const updatedFAQ = await FAQ.findByIdAndUpdate(id, updates, {
      new: true,
      runValidators: true,
    });

    if (!updatedFAQ) {
      return res.status(404).json({ message: "FAQ not found" });
    }

    return res.status(200).json({
      message: "FAQ updated successfully",
      data: updatedFAQ,
    });
  } catch (err) {
    console.error("Error updating FAQ:", err);
    return res.status(500).json({ message: err.message });
  }
};

const deleteFAQ = async (req, res) => {
  try {
    const { id } = req.params;
    await FAQ.findByIdAndDelete(id);
    res.status(200).json({
      status: "successfully deleted",
    });
  } catch (err) {
    res.status(500).json({
      message: err.message,
    });
  }
};

module.exports = {faqs, addFAQ, updateFAQ, deleteFAQ };
