const mongoose = require("mongoose");

const gallerySchema = new mongoose.Schema(
  {
    image: {
      type: String,
      required: true,
    },
    category: {
      type: String,
      trim: true,
    },
    tag: {
      type: String,
      trim: true,
    },
    isHeroImage: {
      type: Boolean,
      default: false,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Gallery", gallerySchema);
