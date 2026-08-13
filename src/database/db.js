const mongoose = require('mongoose');
const { createDefaultAdmins } = require("../models/adminModel");
const { initializeStaticContent } = require("../models/staticContentModel");
const { ensureDefaultSlots } = require("../models/deliverySlotModel"); // ✅ destructure the function

const main = async () => {
    try {
        const mongodburl = process.env.MONGO_URI;
        await mongoose.connect(mongodburl);
        console.log(`Connected to MongoDB`);

        await createDefaultAdmins();
        await initializeStaticContent();
        await ensureDefaultSlots(); // ✅ now this is a proper function
    } catch (error) {
        console.log('Error connecting to MongoDB:', error);
    }
};

main();
