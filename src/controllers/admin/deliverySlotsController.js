const { DeliverySlot } = require("../../models/deliverySlotModel");
const { catchAsyncError } = require("../../utils/generateError");
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");

// get all default delivery slots
exports.getallDeliverySlot = catchAsyncError(async (req, res) => {
  const slots = await DeliverySlot.find();
  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Delivery slots fetched successfully.",
    data: slots,
  });
});
// update default delivery slots
exports.updateDefaultDeliverySlots = catchAsyncError(async (req, res) => {
  const { slots } = req.body;

  if (!Array.isArray(slots) || slots.length === 0) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Slots array is required.",
    });
  }

  const allowedSlots = [
    "Same Day Evening Delivery",
    "Next Day Morning Delivery",
  ];

  let sameDayCutoffTime = null;
  let nextDaySlotUpdated = false;
  const updatedSlots = [];

  for (const slot of slots) {
    const { slotName, ...updateData } = slot;

    if (!allowedSlots.includes(slotName)) {
      return responseHandler({
        res,
        code: statusCode.CONFLICT,
        message:
          "Only Same Day Evening Delivery and Next Day Morning Delivery slots can be updated.",
      });
    }
    // Capture Same Day cutoff time
    if (
      slotName === "Same Day Evening Delivery" &&
      updateData.orderCutoffTime !== undefined
    ) {
      sameDayCutoffTime = updateData.orderCutoffTime;
    }

    const updatedSlot = await DeliverySlot.findOneAndUpdate(
      { slotName },
      { $set: updateData },
      { new: true }
    );

    if (!updatedSlot) {
      return responseHandler({
        res,
        code: statusCode.RESULTNOTFOUND,
        message: slotName + " slot not found.",
      });
    }
    if (slotName === "Next Day Morning Delivery") {
      nextDaySlotUpdated = true;
    } else {
      updatedSlots.push(updatedSlot); // Same Day push
    }
  }

  if (sameDayCutoffTime !== null) {
    const autoUpdatedSlot = await DeliverySlot.findOneAndUpdate(
      {
        slotName: "Next Day Morning Delivery",
      },
      {
        $set: { orderStartTime: sameDayCutoffTime },
      },
      { new: true }
    );

    if (autoUpdatedSlot) {
      updatedSlots.push(autoUpdatedSlot);
    }
  }
  else if (nextDaySlotUpdated) {
    const nextDayFinal = await DeliverySlot.findOne({
      slotName: "Next Day Morning Delivery",
    });

    if (nextDayFinal) {
      updatedSlots.push(nextDayFinal);
    }
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Delivery slots updated successfully.",
    data: updatedSlots,
  });
});
//create special delivery slot
// exports.createSpecialDeliverySlot = catchAsyncError(async (req, res) => {
//   const {
//     slotName,
//     description,
//     slotType,
//     orderStartTime,
//     orderCutoffTime,
//     deliveryWindow,
//     maxOrdersPerSlot,
//     freeForPremiumUsers,
//     availableDates
//   } = req.body;

//   if (!slotName) {
//     return responseHandler({
//       res,
//       code: statusCode.DATAMISSING,
//       message: "Slot name is required.",
//     });
//   }

//   if (!["SAME_DAY", "NEXT_DAY"].includes(slotType)) {
//     return responseHandler({
//       res,
//       code: statusCode.DATAMISSING,
//       message: "Invalid slot type.",
//     });
//   }

//   const existingSlot = await DeliverySlot.findOne({ slotName });

//   if (existingSlot) {
//     return responseHandler({
//       res,
//       code: statusCode.CONFLICT,
//       message: "A slot with this name already exists.",
//     });
//   }

//   const newSlot = await DeliverySlot.create({
//     slotName,
//     description,
//     slotType,
//     orderStartTime,
//     orderCutoffTime,
//     deliveryWindow,
//     isSpecialSlot: true,
//     maxOrdersPerSlot,
//     freeForPremiumUsers,
//     availableDates,
//     enabled: true,
//   });
//   return responseHandler({
//     res,
//     code: statusCode.SUCCESS,
//     message: "Delivery slot created successfully.",
//     data: newSlot,
//   });
// });
// get all special delivery slots
// exports.getAllSpecialDeliverySlot = catchAsyncError(async (req, res) => {
//   const slots = await DeliverySlot.find({ isSpecialSlot: true });
//   return responseHandler({
//     res,
//     code: statusCode.SUCCESS,
//     message: "Delivery slots fetched successfully.",
//     data: slots,
//   });
// });
// get special delivery slot by id
// exports.getSpecialDeliverySlotById = catchAsyncError(async (req, res) => {
//   const { slotId } = req.query;
//   if (!slotId) {
//     return responseHandler({
//       res,
//       code: statusCode.BADREQUEST,
//       message: "slotId is required.",
//     });
//   }
//   const slot = await DeliverySlot.findById(slotId);
//   if (!slot) {
//     return responseHandler({
//       res,
//       code: statusCode.RESULTNOTFOUND,
//       message: "Delivery slot not found.",
//     });
//   }
//   return responseHandler({
//     res,
//     code: statusCode.SUCCESS,
//     message: "Delivery slot fetched successfully.",
//     data: slot,
//   });
// });
// delete special delivery slots only
// exports.deleteDeliverySlot = catchAsyncError(async (req, res) => {
//   const { slotId } = req.query;
//   if (!slotId) {
//     return responseHandler({
//       res,
//       code: statusCode.DATAMISSING,
//       message: "slotId is required.",
//     });
//   }
//   const slot = await DeliverySlot.findById(slotId);
//   if (!slot) {
//     return responseHandler({
//       res,
//       code: statusCode.RESULTNOTFOUND,
//       message: "Slot not found.",
//     });
//   }
//   // Prevent deletion of Same Day / Next Day delivery slots
//   if (["Same Day Evening Delivery", "Next Day Morning Delivery"].includes(slot.slotName)) {
//     return responseHandler({
//       res,
//       code: statusCode.BADREQUEST,
//       message: "This delivery slot cannot be deleted.",
//     });
//   }
//   // Proceed to delete special slot
//   await DeliverySlot.findByIdAndDelete(slotId);
//   return responseHandler({
//     res,
//     code: statusCode.SUCCESS,
//     message: "Special delivery slot deleted successfully.",
//   });
// });
// update special delivery slots
// exports.updateSpecialDeliverySlot = catchAsyncError(async (req, res) => {
//   const { slotId } = req.query;
//   const updatedData = req.body;

//   if (!slotId) {
//     return responseHandler({
//       res,
//       code: statusCode.DATAMISSING,
//       message: "slotId is required.",
//     });
//   }

//   const slot = await DeliverySlot.findById(slotId);
//   if (!slot) {
//     return responseHandler({
//       res,
//       code: statusCode.RESULTNOTFOUND,
//       message: "Slot not found.",
//     });
//   }

//   const updatedSlot = await DeliverySlot.findByIdAndUpdate(
//     slotId,
//     { $set: updatedData },
//     { new: true }
//   );

//   return responseHandler({
//     res,
//     code: statusCode.SUCCESS,
//     message: "Delivery slot updated successfully.",
//     data: updatedSlot,
//   });
// });