// Run from the deployed project: node scripts/set-delivery-radius-20km.js --apply
require("dotenv").config({ path: require("path").join(__dirname, "../.env"), quiet: true });
const mongoose = require("mongoose");
const Config = require("../src/models/distanceDeliveryConfigModel");
const Warehouse = require("../src/models/warehouseModel");
const { validateConfig, validCoordinates } = require("../src/helpers/distanceDeliveryHelper");

async function main() {
  try {
    if (!process.env.MONGO_URI) throw new Error("MONGO_URI is missing.");
    await mongoose.connect(process.env.MONGO_URI, { serverSelectionTimeoutMS: 10000 });
    const config = await Config.findById("global").lean();
    const warehouse = await Warehouse.findOne({ isDefault: true, isActive: true }).lean();
    if (!config) throw new Error("Save the delivery configuration first.");
    if (!validCoordinates(warehouse?.coordinates)) throw new Error("Configure the active default warehouse coordinates first.");
    validateConfig(config);
    if (config.distanceRanges.length !== 1 || config.distanceRanges[0].distanceFrom !== 0) {
      throw new Error("Expected the existing single range starting at 0; multiple pricing bands need a separate review.");
    }
    const next = { ...config, distanceRanges: [{ ...config.distanceRanges[0], distanceTo: 20 }] };
    validateConfig(next);
    console.log(JSON.stringify({ before: config.distanceRanges, after: next.distanceRanges }, null, 2));
    if (!process.argv.includes("--apply")) {
      console.log("Preview only. Run with --apply to save.");
      return;
    }
    const result = await Config.updateOne(
      { _id: "global", distanceRanges: config.distanceRanges, updatedAt: config.updatedAt },
      { $set: { distanceRanges: next.distanceRanges } },
      { runValidators: true }
    );
    if (result.matchedCount !== 1) throw new Error("Configuration changed during this update. Rerun to review the latest values.");
    console.log("Saved: 0–20 km from the active default warehouse. Existing prices and fees preserved.");
  } catch (error) {
    // Avoid printing connection strings or database credentials.
    console.error(error.name === "MongooseServerSelectionError" ? "Database connection failed. Run on a host with database access." : error.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
}

main();
