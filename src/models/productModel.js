const mongoose = require("mongoose");
const Schema = mongoose.Schema;
const productSchema = new Schema({
    categoryId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'category',
    },
    subcategoryId: {
        type: mongoose.Schema.Types.ObjectId,
    },
    productName: String,
    gst: Number,
    hsnCode: {
        type: String,
        trim: true
    },
    keywords: [String],
     isDeleted: {
        type: Boolean,
        default: false
    },
    deletedAt: {
        type: Date,
        default: null
    },
    productVariations: [{
        productType: String,
        measurmentUnit: String,
        measurmentValue: Number,
        outOfStockCount: {
            type: Number,
            default: 0
        },
        stockStatus: {
            type: String,
            enum: ["inStock", "outOfStock", "lowStock"],
            default: "inStock"
        },
        stockQuantity: Number,
        minStock: Number,
        lastRestockedAt: Date,
        mrp: Number,
        sellingPrice: Number,
        discountPercent: Number,
        sku: String,
        productImages: {
            type: [String]
        },
        description: {
            type: [{
                descriptionKey: {
                    type: String,
                    trim: true
                },
                descriptionValue: {
                    type: String,
                    trim: true
                }
            }],
            default: []
        },
        bannerId: {
            type: mongoose.Schema.Types.ObjectId,
            ref: 'banner'
        },
        bannerStatusPerSku: {
            type: String,
            enum: ["Active", "Inactive"],
            default: "Inactive"
        },
        // ✅ VARIATION LEVEL SOFT DELETE
        isDeleted: {
            type: Boolean,
            default: false
        },
        deletedAt: {
            type: Date,
            default: null
        },
        petpoojaItemId: { type: String, default: null }
    }],
}, { timestamps: true });

// Indexes for better query performance
productSchema.index({ categoryId: 1 }); // For category-based queries
productSchema.index({ subcategoryId: 1 }); // For subcategory-based queries
productSchema.index({ categoryId: 1, subcategoryId: 1 }); // Compound index for category + subcategory queries
productSchema.index({ productName: 'text', keywords: 'text' }); // Text search index for product search

module.exports = mongoose.model("product", productSchema);
