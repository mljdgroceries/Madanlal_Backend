const mongoose = require("mongoose");

const staticContentSchema = new mongoose.Schema(
  {
    role: {
      type: String,
      enum: ['customer', 'driver'],
    },
    title: String,
    content: {
      type: String,
      default: "Please click edit button to edit this text",
    },
  },
  { timestamps: true }
);

const StaticContent = mongoose.model("staticcontent", staticContentSchema);

// 👉 Function to initialize default static content
async function initializeStaticContent() {
  try {
    const defaultPages = [
      { role: "customer", title: "Terms and Conditions- Customer" },//customer
      { role: "customer", title: "Privacy Policy- Customer" },//customer
      { role: "customer", title: "About Us" },//customer
      { role: "customer", title: "Contact Information" },//customer
      { role: "driver", title: "Terms and Conditions- Driver" },//driver
      { role: "driver", title: "Privacy Policy- Driver" },//driver
      { role: "driver", title: "Guidelines- Driver" },//driver
      { role: "driver", title: "Earnings & Payments" },//driver
    ];

    let createdCount = 0;

    for (const page of defaultPages) {
      const exists = await StaticContent.findOne({ role: page.role, title: page.title });
      if (!exists) {
        await StaticContent.create({
          role: page.role,
          title: page.title,
          content: "Please click edit button to edit this text",
        });
        console.log(`Inserted default page: ${page.title}`);
        createdCount++;
      }
    }

    // Only log if at least one page was created
    if (createdCount > 0) {
      console.log("Static content initialized");
    }
  } catch (error) {
    console.error("Error initializing static content:", error);
  }
}

module.exports = { StaticContent, initializeStaticContent };
