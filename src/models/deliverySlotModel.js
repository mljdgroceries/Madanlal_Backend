const mongoose = require("mongoose");

const deliveryWindowSchema = new mongoose.Schema({
  startTime: { type: String, required: true },
  endTime: { type: String, required: true },
});

const deliverySlotSchema = new mongoose.Schema(
  {
    slotName: { type: String },
    description: { type: String },
    slotType: {
      type: String,
      enum: ['SAME_DAY', 'NEXT_DAY'],
      required: true
    },
    //order collection start time
    //orders ke liye collection kab se shuru hoga(e.g., 06:00 AM)
    orderStartTime: { type: String, required: true },
    //is time k baad order next cycle/date k liye chala jaega(e.g., 02:00 PM)
    orderCutoffTime: { type: String, required: true },
    deliveryWindow: { type: deliveryWindowSchema, required: true },
    enabled: { type: Boolean, default: true },

    //special slot management
    // isSpecialSlot: { type: Boolean, default: false },
    // maxOrdersPerSlot: { type: Number },
    // freeForPremiumUsers: { type: Boolean, },
    // availableDates: [{ type: String }],
  },
  { timestamps: true }
);

const DeliverySlot = mongoose.model("DeliverySlot", deliverySlotSchema);

async function ensureDefaultSlots() {
  const defaultSlots = [
    {
      slotName: "Same Day Evening Delivery",
      slotType: "SAME_DAY",
      orderStartTime: "00:00",
      orderCutoffTime: "14:00",
      deliveryWindow: { startTime: "16:00", endTime: "21:00" },
    },
    {
      slotName: "Next Day Morning Delivery",
      slotType: "NEXT_DAY",
      orderStartTime: "14:00",
      orderCutoffTime: "23:59",
      deliveryWindow: { startTime: "10:00", endTime: "13:00" },
    }
  ];

  for (const slotData of defaultSlots) {
    const exists = await DeliverySlot.findOne({ slotName: slotData.slotName });
    if (!exists) {
      await DeliverySlot.create(slotData);
      console.log(`🟢 Created missing default slot: ${slotData.slotName}`);
    }
  }
}
module.exports = { DeliverySlot, ensureDefaultSlots };