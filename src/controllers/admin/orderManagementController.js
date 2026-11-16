const Order = require("../../models/orderModel");
const Driver = require("../../models/driverModel");
const Zone = require("../../models/deliveryZonesModel");
const { Admin } = require("../../models/adminModel");
const User = require("../../models/userModel");
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");
const { calculateExpectedDeliveryDate } = require("../../utils/deliveryDateCalculator");
const { catchAsyncError } = require("../../utils/generateError");
const Notification = require("../../models/notificationModel");
const notificationQueue = require("../../queues/notificationQueue");
const salesOrderService = require("../../integrations/petpooja/services/salesOrderService");
const { processFullOrderCancelRefund } = require("../../services/razorpayRefundService");
const {
  appendDeliveryReturnBreakdown,
  buildFeeTaxBreakdown,
} = require("../../utils/orderDisplayHelper");

const buildRefundDetails = (order) => {
  const refunds = order?.razorpayRefunds || [];
  const latestRefund = refunds.length ? refunds[refunds.length - 1] : null;
  return {
    attempted: refunds.length > 0,
    status: order?.refundStatus || "none",
    amount: latestRefund?.amount || 0,
    amountRupees: latestRefund?.amount
      ? Number((Number(latestRefund.amount) / 100).toFixed(2))
      : Number(order?.totalRefundedAmount || 0),
    totalRefundedAmount: Number(order?.totalRefundedAmount || 0),
    razorpayRefundId: latestRefund?.refundId || null,
    paymentId: latestRefund?.paymentId || order?.razorpayPaymentId || null,
    idempotencyKey: latestRefund?.idempotencyKey || null,
    requestedAmountPaise: latestRefund?.requestedAmountPaise || 0,
    currency: latestRefund?.currency || "INR",
    error: latestRefund?.error || null,
    createdAt: latestRefund?.createdAt || null,
  };
};

exports.getAllOrdersForAdmin = catchAsyncError(async (req, res) => {
  const {
    search = "",
    status,
    paymentType,
    page,
    limit,
    filterType,
    filterType2,
    startDate,
    endDate
  } = req.query;

  const query = { status: { $ne: "PaymentPending" } };
  let summaryDateFilter = {};
  let tableDateFilter = {};


  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const startOfDay = new Date(today);
  const endOfDay = new Date(today);
  endOfDay.setHours(23, 59, 59, 999);

  // Yesterday
  const yesterdayStart = new Date(today);
  yesterdayStart.setDate(today.getDate() - 1);

  const yesterdayEnd = new Date(yesterdayStart);
  yesterdayEnd.setHours(23, 59, 59, 999);

  // Last 7 days
  const last7Start = new Date(today);
  last7Start.setDate(today.getDate() - 6);
  last7Start.setHours(0, 0, 0, 0);

  // Last 30 days
  const last30Start = new Date(today);
  last30Start.setDate(today.getDate() - 29);
  last30Start.setHours(0, 0, 0, 0);


  // 🟢 Summary Filter (Top Cards)
  if (filterType === "today") {
    summaryDateFilter = { createdAt: { $gte: startOfDay, $lte: endOfDay } };
  } else if (filterType === "lastweek") {
    summaryDateFilter = { createdAt: { $gte: last7Start, $lte: endOfDay } };
  } else if (filterType === "lastmonth") {
    summaryDateFilter = { createdAt: { $gte: last30Start, $lte: endOfDay } };
  } else if (filterType === "all") {
    summaryDateFilter = {};
  } else if (filterType === "custom" && startDate && endDate) {
    summaryDateFilter = {
      createdAt: { $gte: new Date(startDate), $lte: new Date(endDate) },
    };
  }

  // 🟢 Table Filter (Order List)
  if (filterType2 === "today") {
    tableDateFilter = { createdAt: { $gte: startOfDay, $lte: endOfDay } };
  } else if (filterType2 === "yesterday") {
    tableDateFilter = { createdAt: { $gte: yesterdayStart, $lte: yesterdayEnd } };
  } else if (filterType2 === "last7days") {
    tableDateFilter = { createdAt: { $gte: last7Start, $lte: endOfDay } };
  } else if (filterType2 === "last30days") {
    tableDateFilter = { createdAt: { $gte: last30Start, $lte: endOfDay } };
  } else if (filterType2 === "all") {
    tableDateFilter = {};
  }

  // 🔍 Search
  if (search) {
    query.$or = [
      { orderId: { $regex: search, $options: "i" } },
      { "deliveryAddress.fullName": { $regex: search, $options: "i" } },
      { "deliveryAddress.phoneNumber": { $regex: search, $options: "i" } },
    ];
  }

  // 🟡 Status filter
  if (status && status !== "All") query.status = status;

  // 💳 Payment filter
  if (paymentType && paymentType !== "All") query.paymentMethod = paymentType;

  const tableQuery = { ...query, ...tableDateFilter };

  // Export (XLSX) with same filters/search as tableQuery
  const exportFlag = req.query.export;
  const isExport = String(exportFlag || "").trim().toLowerCase() === "true";
  if (isExport) {
    let ExcelJS;
    try {
      // Lazy require so normal API works even if dependency isn't installed yet
      ExcelJS = require("exceljs");
    } catch (err) {
      return responseHandler({
        res,
        code: statusCode.ERROR,
        message: 'Excel export dependency missing. Please install "exceljs" and restart the server.',
        error: err.message,
      });
    }

    const exportOrders = await Order.find(tableQuery)
      .populate("userId", "fullName phoneNumber profileImage")
      .populate("items.productId", "productName")
      .sort({ createdAt: -1 })
      .lean();

    const workbook = new ExcelJS.Workbook();
    workbook.creator = "Madanlal Admin";
    workbook.created = new Date();

    const sheet = workbook.addWorksheet("Orders");
    sheet.columns = [
      { header: "Order ID", key: "orderId", width: 18 },
      { header: "Customer Name", key: "customerName", width: 22 },
      { header: "Customer Phone", key: "customerPhone", width: 16 },
      { header: "Items Count", key: "itemsCount", width: 12 },
      { header: "Item Names", key: "itemNames", width: 40 },
      { header: "Grand Total", key: "grandTotal", width: 14 },
      { header: "Delivery Charge", key: "deliveryCharge", width: 14 },
      { header: "Platform Fee", key: "platformFee", width: 12 },
      { header: "Payment Method", key: "paymentMethod", width: 14 },
      { header: "Status", key: "status", width: 12 },
      { header: "Delivery Tag", key: "deliveryTag", width: 12 },
      { header: "Window Start", key: "windowStart", width: 14 },
      { header: "Window End", key: "windowEnd", width: 14 },
      { header: "Order Time", key: "orderTime", width: 22 },
    ];

    exportOrders.forEach((o) => {
      const itemNames = (o.items || [])
        .map((i) => i.productId?.productName || "Unnamed Product")
        .join(", ");

      sheet.addRow({
        orderId: o.orderId,
        customerName: o.userId?.fullName || o.deliveryAddress?.fullName || "N/A",
        customerPhone: o.userId?.phoneNumber || o.deliveryAddress?.phoneNumber || "N/A",
        itemsCount: (o.items || []).length,
        itemNames,
        grandTotal: Number(o.grandTotal || 0),
        deliveryCharge: Number(o.deliveryCharge || 0),
        platformFee: Number(o.platformFee || 0),
        paymentMethod: o.paymentMethod || "",
        status: o.status || "",
        deliveryTag: o.deliveryTag || "",
        windowStart: o.deliveryWindow?.startTime || "",
        windowEnd: o.deliveryWindow?.endTime || "",
        orderTime: o.createdAt ? new Date(o.createdAt) : null,
      });
    });

    sheet.getRow(1).font = { bold: true };
    sheet.views = [{ state: "frozen", ySplit: 1 }];

    const fileName = `orders_export_${new Date().toISOString().slice(0, 10)}.xlsx`;
    res.setHeader(
      "Content-Type",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    );
    res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);

    await workbook.xlsx.write(res);
    return res.end();
  }

  // 🔢 Pagination
  const skipValue = (Number(page) - 1) * Number(limit);
  const limitValue = Number(limit);

  // 🧩 Fetch Orders
  const orders = await Order.find(tableQuery)
    .populate("userId", "fullName phoneNumber profileImage")
    .populate("items.productId", "productName")
    .sort({ createdAt: -1 })
    .skip(skipValue)
    .limit(limitValue);

  const total = await Order.countDocuments(tableQuery);

  const formattedOrders = orders.map((o) => ({
    _id: o._id,
    orderId: o.orderId,
    customer: {
      _id: o.userId?._id || null,
      name: o.userId?.fullName || o.deliveryAddress?.fullName || "N/A",
      phone: o.userId?.phoneNumber || o.deliveryAddress?.phoneNumber || "N/A",
      profileImage: o.userId?.profileImage || "",
    },
    items: {
      count: o.items?.length || 0,
      names: o.items
        .map((i) => i.productId?.productName || "Unnamed Product")
        .slice(0, 3)
        .join(", "),
    },
    amount: o.grandTotal || 0,
    deliveryCharge: o.deliveryCharge || 0,
    platformFee: o.platformFee || 0,
    paymentType: o.paymentMethod,
    status: o.status,
    deliveryTag: o.deliveryTag,
    deliveryWindow: o.deliveryWindow,
    orderTime: o.createdAt,
    orderAssignedTo: o.orderAssignedTo
  }));

  const [
    pendingCount,
    processingCount,
    outForDeliveryCount,
    deliveredCount,
    returnedCount,
    cancelledCount,
    revenueData,
  ] = await Promise.all([
    Order.countDocuments({ status: "Pending", ...summaryDateFilter }),
    Order.countDocuments({ status: { $in: ["Confirmed", "Packed"] }, ...summaryDateFilter }),
    Order.countDocuments({ status: "Shipped", ...summaryDateFilter }),
    Order.countDocuments({ status: "Delivered", ...summaryDateFilter }),
    Order.countDocuments({ status: "Returned", ...summaryDateFilter }),
    Order.countDocuments({ status: "Cancelled", ...summaryDateFilter }),
    Order.aggregate([
      { $match: { status: "Delivered", ...summaryDateFilter } },
      { $group: { _id: null, totalRevenue: { $sum: "$grandTotal" } } },
    ]),
  ]);


  let totalRevenue = revenueData.length > 0 ? revenueData[0].totalRevenue : 0;
  totalRevenue = Number(totalRevenue.toFixed(2));

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Orders fetched successfully.",
    data: {
      summary: {
        pending: pendingCount,
        processing: processingCount,
        outForDelivery: outForDeliveryCount,
        delivered: deliveredCount,
        returned: returnedCount,
        cancelled: cancelledCount,
        totalRevenue,
      },
      total,
      page: Number(page),
      limit: Number(limit),
      orders: formattedOrders,
    },
  });
});

exports.updateOrderStatus = catchAsyncError(async (req, res) => {
  const { orderId, status } = req.query;

  if (!orderId || !status) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Order ID and status is required.",
    });
  }

  const order = await Order.findById(orderId);
  if (!order) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Order not found.",
    });
  }

  order.status = status;

  const now = new Date();

  if (status === "Cancelled") {
    order.tracking.isCancelled = true;
    order.tracking.cancelledAt = now;

    // ── Restock locally ──
    const Product = require("../../models/productModel");

    // Combine items to restock
    const itemsToRestock = [];
    if (order.items && order.items.length > 0) {
      for (const item of order.items) {
        itemsToRestock.push({
          productId: item.productId?._id || item.productId,
          variationId: item.variationId,
          quantity: Number(item.quantity || 0)
        });
      }
    }
    if (order.returnedItems && order.returnedItems.length > 0) {
      for (const item of order.returnedItems) {
        itemsToRestock.push({
          productId: item.productId,
          variationId: item.variationId,
          quantity: Number(item.quantity || 0)
        });
      }
    }

    // Perform local DB restocking
    for (const item of itemsToRestock) {
      if (item.quantity <= 0) continue;
      try {
        const product = await Product.findById(item.productId);
        if (product) {
          const variation = product.productVariations.find(
            (v) => v._id.toString() === item.variationId.toString()
          );
          if (variation) {
            variation.stockQuantity = (variation.stockQuantity || 0) + item.quantity;
            if (variation.stockQuantity <= 0) variation.stockStatus = "outOfStock";
            else if (variation.stockQuantity <= variation.minStock) variation.stockStatus = "lowStock";
            else variation.stockStatus = "inStock";
            variation.lastRestockedAt = new Date();
            console.log(`[ADMIN-CANCEL-STOCK] Restocked variation ${variation.sku}: +${item.quantity} (New: ${variation.stockQuantity})`);
          }
          await product.save();
        }
      } catch (stockErr) {
        console.error(`[ADMIN-CANCEL-STOCK] Failed to restock product ${item.productId}:`, stockErr.message);
      }
    }

    // ── Sync to Petpooja: Create Credit Note of full amount and mark Invoice closed ──
    if (!order.petpoojaCreditNoteId) {
      try {
        const customerUser = await User.findById(order.userId);
        if (customerUser) {
          const invoiceService = require('../../integrations/petpooja/services/invoiceService');
          const creditNoteService = require('../../integrations/petpooja/services/creditNoteService');
          const partyService = require('../../integrations/petpooja/services/partyService');

          // Sync user party
          const partySync = await partyService.syncUserParty(customerUser);
          order.billingPetpoojaAddressId = partySync.billingAddressId;
          order.shippingPetpoojaAddressId = partySync.shippingAddressId;

          if (!order.petpoojaVoucherId) {
            const salesOrderResult = await salesOrderService.createSalesOrder(order, customerUser);
            if (!salesOrderResult?.voucherId) {
              throw new Error("Petpooja sales order could not be created before credit note");
            }

            order.petpoojaVoucherId = String(salesOrderResult.voucherId);
            order.petpoojaVoucherNumber = salesOrderResult.voucherNumber
              ? String(salesOrderResult.voucherNumber)
              : null;
            await order.save();
          }

          if (!order.invoiceId) {
            const invoiceVoucherSeries = await invoiceService.initVoucher();
            const invoiceTemplate = await invoiceService.initTemplate();
            const invoiceCustomCharge = await salesOrderService.getCustomCharge();
            const invoiceResult = await invoiceService.createInvoice(
              order.petpoojaVoucherId,
              order,
              customerUser,
              invoiceTemplate ? invoiceTemplate.id : null,
              invoiceCustomCharge ? invoiceCustomCharge.id : null,
              invoiceVoucherSeries ? invoiceVoucherSeries.id : null,
              "sent"
            );

            if (!invoiceResult?.voucherId) {
              throw new Error("Petpooja invoice could not be created before credit note");
            }

            order.invoiceId = String(invoiceResult.voucherId);
            order.invoiceNumber = invoiceResult.voucherNumber
              ? String(invoiceResult.voucherNumber)
              : null;
            await order.save();
          }

          // Fetch credit note voucher series and template
          const voucherSeriesObj = await creditNoteService.initVoucher();
          const voucherAutoSeriesId = voucherSeriesObj ? voucherSeriesObj.id : null;
          const templateObj = await creditNoteService.initTemplate();
          const templateId = templateObj ? templateObj.id : null;
          const customChargeObj = await salesOrderService.getCustomCharge();

          // Build original items for credit note
          const cnItems = itemsToRestock.map(item => {
            const original = order.items.find(
              oi => {
                const oiProdId = oi.productId?._id?.toString() || oi.productId?.toString();
                return oiProdId === item.productId.toString() &&
                  oi.variationId?.toString() === item.variationId.toString();
              }
            );
            return {
              productId: item.productId,
              variationId: item.variationId,
              quantity: item.quantity,
              rate: original ? (original.priceWithGST || original.rate) : 0,
              priceWithGST: original ? (original.priceWithGST || original.rate) : 0,
              basePrice: original ? original.basePrice : 0,
              gstPercent: original ? original.gstPercent : 0,
              petpoojaItemId: original ? original.petpoojaItemId : null
            };
          });

          const activeInvoiceId = order.invoiceId;
          console.log(`[PETPOOJA-ADMIN-CANCEL] Creating Full Credit Note against Invoice: ${activeInvoiceId}`);

          const creditNoteResult = await creditNoteService.createCreditNote(
            activeInvoiceId, cnItems, order, customerUser, voucherAutoSeriesId, templateId,
            {
              includeOrderAdjustments: true,
              customChargeId: customChargeObj ? customChargeObj.id : null,
            }
          );
          console.log('[PETPOOJA-ADMIN-CANCEL] Credit note result:', creditNoteResult);

          if (!creditNoteResult?.creditNoteId) {
            throw new Error("Petpooja credit note response did not include a credit note ID");
          }

          order.petpoojaCreditNoteId = creditNoteResult.creditNoteId;

          // Mark invoice closed
          await invoiceService.markInvoiceClosed(activeInvoiceId);
          console.log('[PETPOOJA-ADMIN-CANCEL] Invoice marked closed:', activeInvoiceId);
        }
      } catch (err) {
        console.error('Error syncing Petpooja full cancellation credit note in admin controller:', err);
      }
    }
  }

  if (status === "Confirmed") {
    order.tracking.isConfirmed = true;
    order.tracking.confirmedAt = now;

    // Set delivery date and tag based on order creation time (if not already set)
    if (!order.expectedDeliveryDate) {
      const { deliveryDate, deliveryTag, deliveryWindow } = await calculateExpectedDeliveryDate(order.createdAt);
      order.expectedDeliveryDate = deliveryDate;
      order.deliveryTag = deliveryTag;
      order.deliveryWindow = deliveryWindow;
    }
  }

  if (status === "Delivered" && order.invoiceId) {
    try {
      const customerUser = await User.findById(order.userId);
      if (customerUser) {
        const receiptService = require('../../integrations/petpooja/services/receiptService');
        const receiptResult = await receiptService.createReceiptForOrder(order, customerUser);
        console.log('[PETPOOJA-ADMIN-DELIVERED] Receipt created:', receiptResult);
      }
    } catch (err) {
      console.error('[PETPOOJA-ADMIN-DELIVERED] Receipt creation failed:', err.message);
    }
  }

  const updatedOrder = await order.save();

  if (status === "Cancelled") {
    try {
      await processFullOrderCancelRefund({
        order: updatedOrder,
        cancelledBy: "admin",
        actorId: req.admin?._id,
      });
    } catch (refundError) {
      console.error("[ADMIN-CANCEL-REFUND] Failed to process refund:", refundError.message);
    }
  }

  try {
    const statusMessages = {
      "Confirmed": "Your order has been confirmed! �",
      "Cancelled": "Your order has been cancelled. ❌",
    };

    if (statusMessages[status]) {
      const user = await User.findById(order.userId).select("notificationPreferences");
      const category = (status === "Cancelled" || status === "Returned") ? "orderUpdates" : "orderUpdates"; // Default to orderUpdates for now

      const isPrefOn = user?.notificationPreferences?.[category] !== false;

      if (isPrefOn) {
        const notificationPayload = {
          userId: order.userId,
          targetAudience: "specificUser",
          title: `Order Update: ${status}`,
          message: statusMessages[status] || `Your order #${order.orderId} is now ${status}.`,
          type: "push",
          category: category,
          scheduleOptions: "now",
          sentAt: new Date()
        };

        const notification = await Notification.create(notificationPayload);

        // Add to queue
        await notificationQueue.add('send-notification', {
          notificationId: notification._id.toString(),
          targetAudience: "specificUser",
          userId: order.userId.toString(),
          category: category,
          title: notificationPayload.title,
          message: notificationPayload.message,
          type: "push"
        });
      }
    }

    // 🔔 Notify Driver if order is cancelled and a driver was assigned
    if (status === "Cancelled" && order.orderAssignedTo) {
      const driverNotifPayload = {
        driverId: order.orderAssignedTo,
        targetAudience: "specificDriver",
        title: `Order Update: Cancelled ❌`,
        message: `Order #${order.orderId} has been cancelled. You no longer need to deliver it.`,
        type: "push",
        category: "orderUpdates",
        scheduleOptions: "now",
        sentAt: new Date()
      };

      const driverNotif = await Notification.create(driverNotifPayload);
      await notificationQueue.add('send-notification', {
        notificationId: driverNotif._id.toString(),
        targetAudience: "specificDriver",
        driverId: order.orderAssignedTo.toString(),
        category: "orderUpdates",
        title: driverNotifPayload.title,
        message: driverNotifPayload.message,
        type: "push"
      });
    }
  } catch (err) {
    console.error("❌ Error sending order notification:", err);
  }

  if (!updatedOrder) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Order not found.",
    });
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Order status updated successfully.",
    data: updatedOrder,
  });
});
exports.generateLabel = catchAsyncError(async (req, res) => {
  const { orderId } = req.query;

  if (!orderId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Order ID is required.",
    });
  }

  const order = await Order.findById(orderId);
  if (!order) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Order not found.",
    });
  }

  const previousStatus = order.status;

  if (previousStatus === "Confirmed") {
    order.status = "Packed";
    order.tracking.isPacked = true;
    order.tracking.packedAt = new Date();

    await order.save();

    // 🔔 Send "Packed" Notification to User
    try {
      const user = await User.findById(order.userId).select("notificationPreferences");
      const isPrefOn = user?.notificationPreferences?.orderUpdates !== false;

      if (isPrefOn) {
        const notificationPayload = {
          userId: order.userId,
          targetAudience: "specificUser",
          title: "Order Update: Packed",
          message: "Your order has been packed and will be shipped soon. 📦",
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
      console.error("❌ Error sending Packed notification:", err);
    }
    // ✅ check admin toggle BEFORE calling autoAssignDriver
    const adminConfig = await Admin.findOne({ _id: req.admin._id }).select('driverAutoAssignmentStatus').lean();

    console.log("🔍 Admin config:", adminConfig);
    console.log("🔍 Driver auto assignment status:", adminConfig?.driverAutoAssignmentStatus);

    if (adminConfig?.driverAutoAssignmentStatus === true) {
      console.log("✅ Auto assignment enabled, calling autoAssignDriver...");
      // and Auto assign driver only when status changes to Packed for first time
      await autoAssignDriver(order._id, order.deliveryAddress.pincode);
    } else {
      console.log("❌ Auto assignment disabled or not found");
    }
  }

  // --- SYNC TO PETPOOJA (SALES ORDER / INVOICE) ---
  // Run whenever voucher is missing (including retry after a failed first attempt)
  if (!order.petpoojaVoucherId) {
    console.log(`[PETPOOJA-CTRL] Entering Petpooja sync block for Order: ${order.orderId} (status: ${order.status})`);
    try {
      const user = await User.findById(order.userId);
      console.log(`[PETPOOJA-CTRL] User found: ${!!user}, petpoojaCustomerId: ${user?.petpoojaCustomerId}`);
      if (user) {
        try {
          const partyService = require("../../integrations/petpooja/services/partyService");
          const partySync = await partyService.syncUserParty(user);

          if (!order.billingPetpoojaAddressId && partySync.billingAddressId) {
            order.billingPetpoojaAddressId = partySync.billingAddressId;
          }
          if (!order.shippingPetpoojaAddressId && partySync.shippingAddressId) {
            order.shippingPetpoojaAddressId = partySync.shippingAddressId;
          }

          console.log(`[PETPOOJA-CTRL] Customer synced: ${partySync.petpoojaCustomerId}, Billing: ${partySync.billingAddressId}, Shipping: ${partySync.shippingAddressId}`);
        } catch (syncError) {
          console.error("[PETPOOJA-CTRL] Failed to auto-sync customer during label generation:", syncError.message);
        }

        if (user.petpoojaCustomerId) {
          console.log(`[PETPOOJA-CTRL] Calling createSalesOrder...`);
          const result = await salesOrderService.createSalesOrder(order, user);
          console.log(`[PETPOOJA-CTRL] createSalesOrder returned:`, JSON.stringify(result));
          if (result?.voucherId) {
            order.petpoojaVoucherId = String(result.voucherId);
            order.petpoojaVoucherNumber = result.voucherNumber
              ? String(result.voucherNumber)
              : null;
            await order.save();
            console.log(`[PETPOOJA-CTRL] Order saved with voucherId: ${order.petpoojaVoucherId}, voucherNumber: ${order.petpoojaVoucherNumber}`);

            console.log("[PETPOOJA-CTRL] Skipping immediate stock pull after sales order creation to preserve locally deducted admin stock");

            // Also create invoice with status paid right away
            try {
              const invoiceService = require("../../integrations/petpooja/services/invoiceService");
              const voucherSeriesObj = await invoiceService.initVoucher();
              const templateObj = await invoiceService.initTemplate();
              const customChargeObj = await salesOrderService.getCustomCharge();

              console.log(`[PETPOOJA-CTRL] Calling createInvoice for sent status...`);
              const invoiceResult = await invoiceService.createInvoice(
                order.petpoojaVoucherId,
                order,
                user,
                templateObj ? templateObj.id : null,
                customChargeObj ? customChargeObj.id : null,
                voucherSeriesObj ? voucherSeriesObj.id : null,
                'sent'
              );
              console.log(`[PETPOOJA-CTRL] createInvoice returned:`, JSON.stringify(invoiceResult));
              if (invoiceResult?.voucherId) {
                order.invoiceId = String(invoiceResult.voucherId);
                order.invoiceNumber = invoiceResult.voucherNumber ? String(invoiceResult.voucherNumber) : null;
                await order.save();
                console.log(`[PETPOOJA-CTRL] Invoice saved with invoiceId: ${order.invoiceId}, invoiceNumber: ${order.invoiceNumber}`);
              }
            } catch (invErr) {
              console.error("[PETPOOJA-CTRL] Invoice Creation Error:", invErr.message);
            }

          } else {
            console.warn(`[PETPOOJA-CTRL] Petpooja API responded but no voucherId in response:`, JSON.stringify(result));
          }
        } else {
          console.warn(`[PETPOOJA-CTRL] Cannot sync Sales Order: User ${order.userId} not synced to Petpooja yet.`);
        }
      }
    } catch (petpoojaError) {
      console.error("[PETPOOJA-CTRL] Sales Order Creation Error:", petpoojaError.message);
      console.error("[PETPOOJA-CTRL] Full error:", petpoojaError);
    }
  } else {
    console.log(`[PETPOOJA-CTRL] Skipped: order already has petpoojaVoucherId = ${order.petpoojaVoucherId}`);
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Order label generated successfully.",
    data: {
      ...order.toObject(),
      billingAddress: order.deliveryAddress,
      shippingAddress: order.deliveryAddress,
    }
  });
});
const autoAssignDriver = async (orderId, pincode) => {
  try {
    console.log(`🚀 Starting auto-assignment for order ${orderId}, pincode: ${pincode}`);

    // Step 1: Find active zone for this pincode
    const primaryZone = await Zone.findOne({
      "locations.pin": pincode,
      status: "Active",
    });

    console.log(`📍 Primary zone found:`, primaryZone ? primaryZone._id : "None");

    let selectedDriver = null;

    // Step 2: Try to assign driver from primary zone
    if (primaryZone) {
      const driversInPrimaryZone = await Driver.find({
        assignedGeofenceAreas: { $in: [primaryZone._id] },
        status: "Active",
        availability: true,
      });

      console.log(`👥 Drivers found in primary zone: ${driversInPrimaryZone.length}`);
      if (driversInPrimaryZone.length > 0) {
        console.log(`📋 Driver IDs:`, driversInPrimaryZone.map(d => d._id));
      }

      if (driversInPrimaryZone.length > 0) {
        // Select least loaded driver
        const driverLoads = await Promise.all(
          driversInPrimaryZone.map(async (d) => {
            const load = await Order.countDocuments({
              orderAssignedTo: d._id,
              status: { $in: ["Packed", "Shipped"] },
            });
            console.log(`📊 Driver ${d._id} has ${load} active orders`);
            return { d, load };
          })
        );

        driverLoads.sort((a, b) => a.load - b.load);
        selectedDriver = driverLoads[0].d;
        console.log(`✅ Selected driver from primary zone: ${selectedDriver._id} with load: ${driverLoads[0].load}`);
      }
    }

    // Step 3: If no driver in primary zone → fallback to any other zone
    if (!selectedDriver) {
      console.log(`⚠️ No driver found in primary zone. Trying other zones...`);

      const otherZones = await Zone.find({ status: "Active" });
      console.log(`🌍 Found ${otherZones.length} active zones to check`);

      for (const zone of otherZones) {
        // Skip primary zone if it was already checked
        if (primaryZone && zone._id.toString() === primaryZone._id.toString()) {
          continue;
        }

        const availableDriver = await Driver.findOne({
          assignedGeofenceAreas: { $in: [zone._id] },
          status: "Active",
          availability: true,
        });

        if (availableDriver) {
          selectedDriver = availableDriver;
          console.log(`✅ Fallback: assigned driver ${availableDriver._id} from zone ${zone._id}`);
          break;
        }
      }
    }

    // Step 4: If still no driver → keep packed
    if (!selectedDriver) {
      console.log(`❌ No available driver in any zone for pincode ${pincode}`);

      // Check all drivers to see what's wrong
      const allDrivers = await Driver.find({ status: "Active" });
      console.log(`🔍 Total active drivers: ${allDrivers.length}`);
      const availableDrivers = allDrivers.filter(d => d.availability === true);
      console.log(`🔍 Available drivers: ${availableDrivers.length}`);
      availableDrivers.forEach(d => {
        console.log(`  - Driver ${d._id}: availability=${d.availability}, zones=${d.assignedGeofenceAreas?.length || 0}`);
      });

      await Order.findByIdAndUpdate(orderId, {
        isAutoAssigned: false,
        status: "Packed",
      });
      return;
    }

    // Step 5: Assign the selected driver and mark as shipped
    const updatedOrder = await Order.findByIdAndUpdate(
      orderId,
      {
        orderAssignedTo: selectedDriver._id,
        isAutoAssigned: true
      },
      { new: true }
    );

    console.log(`🚚 Driver ${selectedDriver._id} assigned (auto) to order ${orderId}`);
    console.log(`✅ Order updated:`, updatedOrder ? "Success" : "Failed");

    // 🔔 Send Notification to Driver
    try {
      const notificationPayload = {
        driverId: selectedDriver._id,
        targetAudience: "specificDriver",
        title: "New Order Assigned! 📦",
        message: `A new order #${updatedOrder.orderId} has been assigned to you.`,
        type: "push",
        category: "orderUpdates",
        scheduleOptions: "now",
        sentAt: new Date()
      };

      const notification = await Notification.create(notificationPayload);

      await notificationQueue.add('send-notification', {
        notificationId: notification._id.toString(),
        targetAudience: "specificDriver",
        driverId: selectedDriver._id.toString(),
        category: "orderUpdates",
        title: notificationPayload.title,
        message: notificationPayload.message,
        type: "push"
      });
    } catch (err) {
      console.error("❌ Error sending driver auto-assignment notification:", err);
    }
  } catch (error) {
    console.error("❌ Auto assign driver error:", error);
    console.error("❌ Error stack:", error.stack);
  }
};
exports.assignDriverToOrder = catchAsyncError(async (req, res) => {
  const { orderId, driverId } = req.query;

  if (!orderId || !driverId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Order ID and Driver ID are required.",
    });
  }

  const updatedOrder = await Order.findByIdAndUpdate(
    orderId,
    {
      orderAssignedTo: driverId,
      isAutoAssigned: false
    },
    { new: true }
  );

  if (!updatedOrder) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Order not found.",
    });
  }

  // 🔔 Send Notification to Driver (Manual)
  try {
    const notificationPayload = {
      driverId: driverId,
      targetAudience: "specificDriver",
      title: "New Order Assigned! 📦",
      message: `The admin has assigned a new order #${updatedOrder.orderId} to you.`,
      type: "push",
      category: "orderUpdates",
      scheduleOptions: "now",
      sentAt: new Date()
    };

    const notification = await Notification.create(notificationPayload);

    await notificationQueue.add('send-notification', {
      notificationId: notification._id.toString(),
      targetAudience: "specificDriver",
      driverId: driverId.toString(),
      category: "orderUpdates",
      title: notificationPayload.title,
      message: notificationPayload.message,
      type: "push"
    });
  } catch (err) {
    console.error("❌ Error sending driver manual assignment notification:", err);
  }

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Driver assigned successfully.",
    data: updatedOrder,
  });
});
// exports.getOrderDetailsById = catchAsyncError(async (req, res) => {
//   const { orderId } = req.query;
//   if (!orderId) {
//     return responseHandler({
//       res,
//       code: statusCode.DATAMISSING,
//       message: "Order ID is required.",
//     });
//   }
//   const order = await Order.findById(orderId)
//     .populate("userId", "profileImage")
//     .populate({
//       path: "items.productId",
//       select: "productName productVariations categoryId",
//       populate: { path: "categoryId", select: "categoryName" }
//     })
//     .populate({
//       path: "returnedItemsDetails.productId",
//       select: "productName productVariations categoryId",
//       populate: { path: "categoryId", select: "categoryName" }
//     })
//     .populate("orderAssignedTo", "fullName mobileNumber driverImage");

//   if (!order) {
//     return responseHandler({
//       res,
//       code: statusCode.RESULTNOTFOUND,
//       message: "Order not found.",
//     });
//   }
//   const formattedOrder = {
//     ...order.toObject(),
//     items: order.items.map(item => {
//       const variation = item.productId?.productVariations?.find(
//         v => v._id.toString() === item.variationId.toString()
//       );
//       // console.log("variation", variation);
//       return {
//         productId: item.productId?._id,
//         variationId: item.variationId,

//         productImages: variation?.productImages[0] || [],
//         productName: item.productId?.productName,
//         categoryName: item.productId?.categoryId?.categoryName,

//         measurementValue: variation?.measurmentValue,
//         measurementUnit: variation?.measurmentUnit,

//         quantity: item.quantity,
//         basePrice: item.basePrice,
//         subtotal: item.subtotal,
//         stockStatus: variation?.stockStatus
//       };
//     }),
//     returnedItemsDetails: order.returnedItemsDetails.map(item => {
//       const variation = item.productId?.productVariations?.find(
//         v => v._id.toString() === item.variationId.toString()
//       );

//       return {
//         productId: item.productId?._id,
//         variationId: item.variationId,

//         productImages: variation?.productImages[0] || [],
//         productName: item.productId?.productName,
//         categoryName: item.productId?.categoryId?.categoryName,

//         measurementValue: variation?.measurmentValue,
//         measurementUnit: variation?.measurmentUnit,

//         quantity: item.quantity,
//         basePrice: item.basePrice,
//         subtotal: item.basePrice * item.quantity,
//         stockStatus: variation?.stockStatus
//       };
//     }),
//   };
//   return responseHandler({
//     res,
//     code: statusCode.SUCCESS,
//     message: "Order details fetched successfully.",
//     data: formattedOrder,
//   });
// });

exports.getOrderDetailsById = catchAsyncError(async (req, res) => {
  const { orderId } = req.query;
  const resolveGstPercent = (...values) => {
    for (const value of values) {
      const num = Number(value);
      if (Number.isFinite(num) && num > 0) return num;
    }
    return 0;
  };

  if (!orderId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Order ID is required.",
    });
  }

  const order = await Order.findById(orderId)
    .populate("userId", "profileImage")
    .populate({
      path: "items.productId",
      select: "productName gst productVariations categoryId isDeleted", // ✅ ADD
      populate: { path: "categoryId", select: "categoryName" },
    })
    .populate({
      path: "returnedItemsDetails.productId",
      select: "productName gst productVariations categoryId isDeleted", // ✅ ADD
      populate: { path: "categoryId", select: "categoryName" },
    })
    .populate("orderAssignedTo", "fullName mobileNumber driverImage");

  if (!order) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Order not found.",
    });
  }

  const formattedOrder = {
    ...order.toObject(),
    petpoojaSalesOrderNumber: order.petpoojaVoucherNumber,
    petpoojaInvoiceNumber: order.invoiceNumber,
    petpoojaVoucherNumber: order.invoiceNumber,
    petpoojaVoucherId: order.petpoojaVoucherId,
    invoiceId: order.invoiceId,
    invoiceNumber: order.invoiceNumber,
    totalRefundedAmount: Number(order.totalRefundedAmount || 0),
    refundStatus: order.refundStatus || "none",
    refund: buildRefundDetails(order),
    razorpayRefunds: order.razorpayRefunds || [],

    // ===================== ITEMS =====================
    items: order.items.map((item) => {
      const product = item.productId;

      // ❌ अगर product deleted hai
      if (!product || product.isDeleted) {
        const unitBasePrice = Number(item.basePrice ?? 0);
        const gstPercent = resolveGstPercent(item.gstPercent, product?.gst);
        const rawPriceWithGST = Number(item.priceWithGST ?? 0);
        const quantity = Number(item.quantity || 0);
        const subtotal = Number(item.subtotal || 0);
        const computedUnitPriceWithGST = Number(
          (unitBasePrice + (unitBasePrice * gstPercent) / 100).toFixed(2),
        );
        const fromSubtotal = quantity > 0 && subtotal > 0 ? Number((subtotal / quantity).toFixed(2)) : 0;
        const unitPriceWithGST =
          rawPriceWithGST > 0 && (gstPercent <= 0 || rawPriceWithGST > unitBasePrice)
            ? rawPriceWithGST
            : fromSubtotal > 0 && (gstPercent <= 0 || fromSubtotal > unitBasePrice)
              ? fromSubtotal
              : gstPercent > 0
                ? computedUnitPriceWithGST
                : rawPriceWithGST > 0
                  ? rawPriceWithGST
                  : unitBasePrice;
        return {
          productId: null,
          variationId: item.variationId,
          productImages: [],
          productName: "Product not available",
          categoryName: "",
          measurementValue: null,
          measurementUnit: null,
          quantity: item.quantity,
          basePrice: unitBasePrice,
          priceWithGST: unitPriceWithGST,
          unitPrice: unitPriceWithGST,
          subtotal: Number((unitPriceWithGST * quantity).toFixed(2)),
          stockStatus: null,
        };
      }

      // ✅ variation find + not deleted
      const variation = product.productVariations?.find(
        (v) =>
          v._id.toString() === item.variationId.toString() &&
          !v.isDeleted // ✅ IMPORTANT
      );

      const unitBasePrice = Number(item.basePrice ?? 0);
      const gstPercent = resolveGstPercent(
        item.gstPercent,
        variation?.gst,
        product?.gst,
      );
      const rawPriceWithGST = Number(item.priceWithGST ?? 0);
      const quantity = Number(item.quantity || 0);
      const subtotal = Number(item.subtotal || 0);
      const computedUnitPriceWithGST = Number(
        (unitBasePrice + (unitBasePrice * gstPercent) / 100).toFixed(2),
      );
      const fromSubtotal = quantity > 0 && subtotal > 0 ? Number((subtotal / quantity).toFixed(2)) : 0;
      const unitPriceWithGST =
        rawPriceWithGST > 0 && (gstPercent <= 0 || rawPriceWithGST > unitBasePrice)
          ? rawPriceWithGST
          : fromSubtotal > 0 && (gstPercent <= 0 || fromSubtotal > unitBasePrice)
            ? fromSubtotal
            : gstPercent > 0
              ? computedUnitPriceWithGST
              : rawPriceWithGST > 0
                ? rawPriceWithGST
                : unitBasePrice;

      return {
        productId: product._id,
        variationId: item.variationId,

        productImages: variation?.productImages?.[0] || [],
        productName: product.productName,
        categoryName: product.categoryId?.categoryName,

        measurementValue: variation?.measurmentValue || null,
        measurementUnit: variation?.measurmentUnit || null,

        quantity: item.quantity,
        basePrice: unitBasePrice,
        priceWithGST: unitPriceWithGST,
        unitPrice: unitPriceWithGST,
        subtotal: Number((unitPriceWithGST * quantity).toFixed(2)),
        stockStatus: variation?.stockStatus || null,
      };
    }),

    // ===================== RETURNED ITEMS =====================
    returnedItemsDetails: order.returnedItemsDetails.map((item) => {
      const product = item.productId;
      const returnedQty = Number(item.quantity || 0);
      const returnedRawUnitPriceWithGST = Number(item.priceWithGST || item.unitPrice || 0);
      const returnedBasePrice = Number(item.basePrice || 0);
      const originalItem = order.items?.find(
        (i) =>
          i.productId?._id?.toString?.() === product?._id?.toString?.() &&
          i.variationId?.toString?.() === item.variationId?.toString?.(),
      );
      const variation = product?.productVariations?.find(
        (v) =>
          v._id.toString() === item.variationId.toString() &&
          !v.isDeleted,
      );
      const returnedGstPercent = resolveGstPercent(
        item.gstPercent,
        originalItem?.gstPercent,
        product?.gst,
      );
      const returnedSubtotal = Number(item.subtotal || 0);
      const returnedComputedUnitPriceWithGST = Number(
        (returnedBasePrice + (returnedBasePrice * returnedGstPercent) / 100).toFixed(2),
      );
      const returnedFromSubtotal =
        returnedQty > 0 && returnedSubtotal > 0
          ? Number((returnedSubtotal / returnedQty).toFixed(2))
          : 0;
      const returnedUnitPrice =
        returnedRawUnitPriceWithGST > 0 &&
          (returnedGstPercent <= 0 || returnedRawUnitPriceWithGST > returnedBasePrice)
          ? returnedRawUnitPriceWithGST
          : returnedFromSubtotal > 0 &&
            (returnedGstPercent <= 0 || returnedFromSubtotal > returnedBasePrice)
            ? returnedFromSubtotal
            : returnedGstPercent > 0
              ? returnedComputedUnitPriceWithGST
              : returnedRawUnitPriceWithGST > 0
                ? returnedRawUnitPriceWithGST
                : returnedBasePrice;

      // ❌ अगर product deleted hai
      if (!product || product.isDeleted) {
        return {
          productId: null,
          variationId: item.variationId,
          productImages: [],
          productName: "Product not available",
          categoryName: "",
          measurementValue: null,
          measurementUnit: null,
          quantity: item.quantity,
          basePrice: returnedBasePrice,
          priceWithGST: returnedUnitPrice,
          unitPrice: returnedUnitPrice,
          sellingPrice: returnedUnitPrice,
          subtotal: Number((returnedUnitPrice * returnedQty).toFixed(2)),
          stockStatus: null,
        };
      }

      return {
        productId: product._id,
        variationId: item.variationId,

        productImages: variation?.productImages?.[0] || [],
        productName: product.productName,
        categoryName: product.categoryId?.categoryName,

        measurementValue: variation?.measurmentValue || null,
        measurementUnit: variation?.measurmentUnit || null,

        quantity: item.quantity,
        basePrice: returnedBasePrice,
        priceWithGST: returnedUnitPrice,
        unitPrice: returnedUnitPrice,
        sellingPrice: returnedUnitPrice,
        subtotal: Number((returnedUnitPrice * returnedQty).toFixed(2)),
        stockStatus: variation?.stockStatus || null,
      };
    }),
  };

  // Before delivery, return-selected quantities are still pending, so hide them
  // from deliverable rows. Delivered orders already persist net delivered items.
  const shouldSubtractReturned =
    order.status !== "Delivered" && !order.tracking?.isDelivered;
  if (shouldSubtractReturned) {
    const returnedQtyByVariation = new Map();
    (formattedOrder.returnedItemsDetails || []).forEach((ret) => {
      const key = ret?.variationId?.toString?.();
      if (!key) return;
      returnedQtyByVariation.set(
        key,
        (returnedQtyByVariation.get(key) || 0) + (Number(ret?.quantity) || 0),
      );
    });
    formattedOrder.items = (formattedOrder.items || [])
      .map((item) => {
        const key = item?.variationId?.toString?.();
        const qty = Number(item?.quantity || 0);
        const returnedQty = key ? returnedQtyByVariation.get(key) || 0 : 0;
        const netQty = Math.max(qty - returnedQty, 0);
        if (netQty <= 0) return null;

        const unitPrice = Number(item?.unitPrice ?? item?.priceWithGST ?? 0);
        return {
          ...item,
          quantity: netQty,
          subtotal: Number((unitPrice * netQty).toFixed(2)),
        };
      })
      .filter(Boolean);
  }

  // Keep summary totals in sync with item-level values.
  const computedSubTotal = Number(
    (formattedOrder.items || [])
      .reduce((sum, item) => sum + Number(item?.subtotal || 0), 0)
      .toFixed(2),
  );
  formattedOrder.subTotal = computedSubTotal;

  const deliveryCharge = Number(formattedOrder.deliveryCharge || 0);
  const platformFee = Number(formattedOrder.platformFee || 0);
  const feeTaxBreakdown = buildFeeTaxBreakdown(deliveryCharge, platformFee);
  formattedOrder.feeTaxBreakdown = feeTaxBreakdown;
  const grandTotal = Number(formattedOrder.grandTotal || 0);
  const storedDiscount = Number(formattedOrder.couponDiscount || 0);
  const inferredDiscount = Number(
    Math.max(computedSubTotal + deliveryCharge + platformFee - grandTotal, 0).toFixed(2),
  );
  formattedOrder.couponDiscount = Number(
    Math.max(storedDiscount, inferredDiscount).toFixed(2),
  );
  formattedOrder.grandTotal = Number(
    Math.max(
      computedSubTotal +
      deliveryCharge +
      platformFee -
      Number(formattedOrder.couponDiscount || 0),
      0,
    ).toFixed(2),
  );

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Order details fetched successfully.",
    data: appendDeliveryReturnBreakdown(formattedOrder),
  });
});
