const mongoose = require("mongoose");

const subCategorySchema = new mongoose.Schema({
    subCategoryName: String,
    subCategoryCode: String,
    sortOrder: Number,
    status: {
        type: String,
        enum: ["Active", "Inactive"],
        default: "Active",
    }
}, { timestamps: true })

//category schema
const categorySchema = new mongoose.Schema({
    categoryName: String,
    categoryCode: String,
    sortOrder: Number,
    description: String,
    categoryImage: String,
    status: {
        type: String,
        enum: ["Active", "Inactive"],
        default: "Active",
    },
    visibility: {
        type: String,
        enum: ["Visible", "Hidden"],
        default: "Visible",
    },
    subCategories: [subCategorySchema]
},
    { timestamps: true }
);

const categoryModel = mongoose.model('category', categorySchema);
module.exports = categoryModel;