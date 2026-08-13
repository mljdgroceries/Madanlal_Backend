const cron = require('node-cron');
const Order = require('../models/orderModel');
const User = require('../models/userModel');
const { calculateExpectedDeliveryDate } = require("../utils/deliveryDateCalculator");
const { sendScheduledNotificationsfromCron } = require('../controllers/admin/notificationController');
const Notification = require('../models/notificationModel');
const notificationQueue = require('../queues/notificationQueue');

const autoConfirmOrders = async () => {
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

    const ordersToUpdate = await Order.find({
      status: "Pending",
      createdAt: { $lte: oneHourAgo },
      $or: [
        { paymentMethod: "COD" },
        { paymentMethod: "Prepaid", paymentStatus: "Paid" },
      ],
    });

    // Unpaid prepaid orders are payment drafts, not placed orders.
    await Order.updateMany(
      {
        status: { $in: ["PaymentPending", "Pending"] },
        paymentMethod: "Prepaid",
        paymentStatus: { $ne: "Paid" },
        createdAt: { $lte: oneHourAgo },
      },
      {
        $set: {
          status: "Cancelled",
          paymentStatus: "Failed",
          "tracking.isCancelled": true,
          "tracking.cancelledAt": new Date(),
        },
      },
    );

    let modifiedCount = 0;
    for (const order of ordersToUpdate) {
      // Calculate delivery date based on order creation time (if not already set)
      if (!order.expectedDeliveryDate) {
        const { deliveryDate, deliveryTag, deliveryWindow } = await calculateExpectedDeliveryDate(order.createdAt);
        order.expectedDeliveryDate = deliveryDate;
        order.deliveryTag = deliveryTag;
        order.deliveryWindow = deliveryWindow;
      }

      order.status = "Confirmed";
      order.tracking.isConfirmed = true;
      order.tracking.confirmedAt = new Date();

      await order.save();

      // 🔔 Send Auto-Confirmation Notification
      try {
        const user = await User.findById(order.userId).select("notificationPreferences");
        const isPrefOn = user?.notificationPreferences?.orderUpdates !== false;

        if (isPrefOn) {
          const notificationPayload = {
            userId: order.userId,
            targetAudience: "specificUser",
            title: "Order Update: Confirmed",
            message: "Your order has been confirmed! 🎉",
            type: "push",
            category: "orderUpdates",
            scheduleOptions: "now",
            sentAt: new Date()
          };

          const notification = await Notification.create(notificationPayload);

          await notificationQueue.add('send-notification', {
            notificationId: notification._id.toString(),
            targetAudience: "specificUser",
            userId: order.userId.toString(),
            category: "orderUpdates",
            title: notificationPayload.title,
            message: notificationPayload.message,
            type: "push"
          });
        }
      } catch (err) {
        console.error("❌ Error sending auto-confirmation notification:", err);
      }

      modifiedCount++;
    }

    const result = { modifiedCount };

    if (result.modifiedCount > 0) {
      console.log(`Auto-confirmed ${result.modifiedCount} orders`);
    }
  } catch (error) {
    console.error('Error in auto-confirming orders:', error);
  }
};

const startCronJobs = () => {
  // Run every 10 minutes
  cron.schedule('*/10 * * * *', autoConfirmOrders);
  console.log('Cron job for auto-confirming orders started');

  // Run every minute
  cron.schedule('* * * * *', sendScheduledNotificationsfromCron);
  console.log('Cron job for sending scheduled notifications started');
};

module.exports = { startCronJobs };
