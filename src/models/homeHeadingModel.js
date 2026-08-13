const mongoose = require('mongoose');
const homeHeadingSchema = new mongoose.Schema({
    heading: String,
    productIds: [{
        type: mongoose.Schema.Types.ObjectId,
        ref: "product",
    }],
    status: {
        type: String,
        enum: ["Active", "Inactive"],
        default: "Active",
    },
}, { timestamps: true });

module.exports = mongoose.model("homeheading", homeHeadingSchema);