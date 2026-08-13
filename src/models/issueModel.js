const mongoose = require("mongoose");

const issueSchema = new mongoose.Schema(
  {
    issueName: {
      type: String,
      required: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Issue", issueSchema);
