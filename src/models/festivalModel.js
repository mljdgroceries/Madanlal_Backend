const mongoose = require("mongoose");

const festivalSchema = new mongoose.Schema(
  {
    name: String,
    description: String,
    category: String,
  },
  { timestamps: true }
);

module.exports = mongoose.model("festival", festivalSchema);
