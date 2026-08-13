const mongoose = require("mongoose");

const searchHistorySchema = new mongoose.Schema(
    {
        userId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: "user",
            required: false,
        },
        query: {
            type: String,
            required: true,
            trim: true,
        },
        resultsCount: {
            type: Number,
            default: 0,
        },
        isProductAvailable: {
            type: Boolean,
            default: false,
        },
        deviceType: {
            type: String,
        },
    },
    { timestamps: true }
);

searchHistorySchema.index({ query: 1 });
searchHistorySchema.index({ createdAt: -1 });

module.exports = mongoose.model("searchHistory", searchHistorySchema);
