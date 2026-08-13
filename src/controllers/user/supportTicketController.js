const SupportTicket = require("../../models/supportTicketModel");
const User = require("../../models/userModel")
const Order =require("../../models/orderModel")
const { catchAsyncError } = require("../../utils/generateError");
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");


exports.raiseTicket = catchAsyncError(async (req, res) => {
 const user = req.user; 
  const { issue, description } = req.body;

  if (!issue) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Issue is required",
    });
  }

  // 🔹 Last ticket find karo (no aggregation)
  const lastTicket = await SupportTicket.findOne({
    ticketId: { $regex: /^TKT-\d+$/ },
  })
    .sort({ createdAt: -1 }) // latest ticket
    .select("ticketId");

  let newTicketId = "TKT-1";

  if (lastTicket?.ticketId) {
    const lastNumber = parseInt(lastTicket.ticketId.split("-")[1], 10);
    newTicketId = `TKT-${lastNumber + 1}`;
  }

  const ticket = await SupportTicket.create({
    userId: user._id,
    issue,
    description,
    ticketType: "General",
    ticketId: newTicketId,
  });

   const userName =
    user.addresses?.find(a => a.isDefault)?.fullName ||
    user.addresses?.[0]?.fullName ||
    "";

     const responseData = {
    ticketId: ticket.ticketId,
    issue: ticket.issue,
    description: ticket.description,
    ticketType: ticket.ticketType,
    createdAt: ticket.createdAt,
    

    user: {
      userId: user._id,
      phone: user.phone,
      profileImage: user.profileImage || "",
      name: userName,
    },
  };

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Ticket raised successfully",
    data: responseData,
  });
});
exports.raiseTicketByOrderId = catchAsyncError(async (req, res) => {
  const user = req.user;
  const { issue, description, orderId } = req.body;

  if (!issue) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Issue is required",
    });
  }

  if (!orderId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Order ID is required",
    });
  }

  // 🔹 Order find (order details ke liye)
  const order = await Order.findById(orderId).select(
    "orderId status paymentMethod paymentStatus grandTotal deliveryCharge couponDiscount deliveryTag deliveryWindow expectedDeliveryDate deliveryAddress createdAt"
  );

  if (!order) {
    return responseHandler({
      res,
      code: statusCode.NOTFOUND,
      message: "Order not found",
    });
  }

  // 🔹 Last ticket find (auto increment ticketId)
  const lastTicket = await SupportTicket.findOne({
    ticketId: { $regex: /^TKT-\d+$/ },
  })
    .sort({ createdAt: -1 })
    .select("ticketId");

  let newTicketId = "TKT-1";

  if (lastTicket?.ticketId) {
    const lastNumber = parseInt(lastTicket.ticketId.split("-")[1], 10);
    newTicketId = `TKT-${lastNumber + 1}`;
  }

  // 🔹 Create ticket
  const ticket = await SupportTicket.create({
    ticketId: newTicketId,
    userId: user._id,
    orderId: order._id,
    issue,
    description,
    ticketType: "Order",
  });

  // 🔹 Final response (NO separate user object)
  const responseData = {
    ticketId: ticket.ticketId,
    issue: ticket.issue,
    description: ticket.description,
    ticketType: ticket.ticketType,
    createdAt: ticket.createdAt,

    order: {
      orderObjectId: order._id,
      orderId: order.orderId,
      status: order.status,

      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,

      grandTotal: order.grandTotal,
      deliveryCharge: order.deliveryCharge,
      couponDiscount: order.couponDiscount,

      deliveryTag: order.deliveryTag,
      deliveryWindow: order.deliveryWindow,
      expectedDeliveryDate: order.expectedDeliveryDate,

      deliveryAddress: {
        ...order.deliveryAddress,
        profileImage: user.profileImage || "",
      },
      createdAt: order.createdAt,
    },
  };

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: "Ticket raised successfully",
    data: responseData,
  });
});
exports.getUserTickets = catchAsyncError(async (req, res) => {
  const userId = req.user._id;

  const tickets = await SupportTicket.find({ userId })
    .populate({
      path: "orderId",
      select: "orderId", 
    })
    .sort({ createdAt: -1 });

    const formattedTickets = tickets.map((t) => {
    const response = {
      _id: t._id,
      ticketId: t.ticketId,
      ticketType: t.ticketType,
      issue: t.issue,
      description: t.description,
      status: t.status,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    };

    if (t.ticketType === "Order" && t.orderId) {
      response.orderId = t.orderId.orderId;
    }

    return response;
  });

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    data: formattedTickets,
  });
});
