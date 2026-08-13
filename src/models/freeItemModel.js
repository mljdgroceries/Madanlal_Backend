const mongoose = require('mongoose');

const freeItemSchema = new mongoose.Schema({
    productName: {
        type: String,
    },
    stock: {
        type: Number,   
    },
    productImage: {
        type: String,     
    },
    
}, {
    timestamps: true
});

module.exports = mongoose.model('freeItem', freeItemSchema);
