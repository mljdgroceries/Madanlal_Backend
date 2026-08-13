const mongoose = require("mongoose");
const { bcryptedPasswordFunc } = require("../utils/bcryption");

const AdminSchema = new mongoose.Schema(
  {
    name: String,
    email: String,
    phone: String,
    adminImage: String,
    driverAutoAssignmentStatus: {
      type: Boolean,
      default: true,
    },
    role: {
      type: String,
      enum: ["admin"],
      default: "admin",
    },
    password: String,
    loginHistory: [
      {
        timestamp: {
          type: Date,
          default: Date.now,
        },
        ip: String,
        status: {
          type: String,
          enum: ["Active", "Inactive", "Locked"],
        },
      },
    ],
    isLocked: {
      type: Boolean,
      default: false,
    },
    //  autoAssignmentStatus: {
    //   type: Boolean,
    //   default: false,
    // },
    jwtToken: String,
    subAdminRightAccess: [
      {
        name: String,
        read: {
          type: String,
          enum: ["true", "false"],
          default: "false",
        },
        fullAccess: {
          type: String,
          enum: ["true", "false"],
          default: "false",
        },
      },
    ],
    devices: [{
      deviceType: {
        type: String,
        enum: ["web"],
        default: "web"
      },
      deviceToken: String,
      accessToken: String
    }]
  },
  { timestamps: true }
);

const Admin = mongoose.model("admin", AdminSchema);

async function createDefaultAdmins() {
  const defaultRights = [
    { name: "dashboard", read: true, fullAccess: true },
    { name: "userManagement", read: true, fullAccess: true },
    { name: "productManagement", read: true, fullAccess: true },
    { name: "freeItems", read: true, fullAccess: true },
    { name: "deliveryConfig", read: true, fullAccess: true },
    { name: "categories", read: true, fullAccess: true },
    { name: "inventory", read: true, fullAccess: true },
    { name: "orders", read: true, fullAccess: true },
    { name: "deliverySlots", read: true, fullAccess: true },
    { name: "deliveryZones", read: true, fullAccess: true },
    { name: "driverAssignment", read: true, fullAccess: true },
    { name: "promotions", read: true, fullAccess: true },
    { name: "reports", read: true, fullAccess: true },
    { name: "notifications", read: true, fullAccess: true },
  ];
  const defaultAdmins = [
    {
      name: "Admin 1",
      email: "abc@123",
      role: "admin",
      password: "admin123",
      subAdminRightAccess: defaultRights,
    },
  ];

  for (const admin of defaultAdmins) {
    const exists = await Admin.findOne({ email: admin.email });
    if (!exists) {
      const hashedPassword = await bcryptedPasswordFunc(admin.password);
      await Admin.create({ ...admin, password: hashedPassword });
      console.log(`Created admin: ${admin.name}`);
    }
    // else {
    //   console.log(`Admin already exists with email ${admin.email}`);
    // }
  }
}

module.exports = {
  Admin,
  createDefaultAdmins,
};
