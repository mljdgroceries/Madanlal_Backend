const SupportTicket = require("../../models/supportTicketModel");
const { catchAsyncError } = require("../../utils/generateError");
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");

exports.getAllTickets = catchAsyncError(async (req, res) => {
  const {
    status,
    issue,
    search,
    ticketType,
    page = 1,
    limit = 10,
  } = req.query;

  const skip = (page - 1) * limit;
  const filter = {};

  // ---------- FILTERS ----------
  if (status) filter.status = status;
  if (issue) filter.issue = issue;
  if (ticketType) filter.ticketType = ticketType;

  if (search) {
    filter.$or = [
      { ticketId: { $regex: search, $options: "i" } },
      { issue: { $regex: search, $options: "i" } },
    ];
  }

  // ---------- FETCH DATA ----------
  const [tickets, total] = await Promise.all([
    SupportTicket.find(filter)
      .populate("userId", "phone profileImage addresses")
      .populate({
        path: "orderId",
        select:
          "orderId status paymentStatus codPaymentStatus grandTotal deliveryWindow expectedDeliveryDate deliveryAddress items totalItems userId",
        populate: [
          {
            path: "items.productId",
            select: "name",
          },
          {
            path: "userId",
            select: "profileImage",
          },
        ],
      })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(Number(limit)),

    SupportTicket.countDocuments(filter),
  ]);

  // ---------- FORMAT RESPONSE ----------
  const formattedTickets = tickets.map((t) => {
    const order = t.orderId || null;

    let productCount = 0;
    if (order?.items?.length) {
      productCount = order.items.reduce(
        (sum, item) => sum + (item.quantity || 0),
        0
      );
    }

    const defaultAddress =
      t.userId?.addresses?.find((a) => a.isDefault) ||
      t.userId?.addresses?.[0] ||
      null;

    const response = {
      _id: t._id,
      ticketId: t.ticketId,
      ticketType: t.ticketType,
      issue: t.issue,
      description: t.description,
      status: t.status,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,

      user: {
        userId: t.userId?._id,
        phone: t.userId?.phone || "",
        profileImage: t.userId?.profileImage || "",
        name: defaultAddress?.fullName || "",
      },
    };

    if (order) {
      response.order = {
        orderObjectId: order._id,
        orderId: order.orderId,
        status: order.status,

        paymentStatus: order.paymentStatus,
        codPaymentStatus: order.codPaymentStatus || null,
        grandTotal: order.grandTotal,

        productCount,

        expectedDeliveryDate: order.expectedDeliveryDate,
        deliveryWindow: order.deliveryWindow,

        deliveryAddress: {
          ...order.deliveryAddress,
          profileImage: order.userId?.profileImage || "",
        },
      };
    }

    return response;
  });

  // ---------- FINAL RESPONSE ----------
  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    data: {
      tickets: formattedTickets,
      pagination: {
        total,
        page: Number(page),
        limit: Number(limit),
        totalPages: Math.ceil(total / limit),
      },
    },
  });
});
exports.updateTicketStatus = catchAsyncError(async (req, res) => {
  const { ticketId } = req.query;
  const { status } = req.body; 

  if (!ticketId) {
    return responseHandler({
      res,
      code: statusCode.DATAMISSING,
      message: "Ticket ID is required",
    });
  }

  if (!status || !["Resolved", "Rejected"].includes(status)) {
    return responseHandler({
      res,
      code: statusCode.BADREQUEST,
      message: "Valid status is required (Resolved / Rejected)",
    });
  }

  const ticket = await SupportTicket.findById(ticketId);

  if (!ticket) {
    return responseHandler({
      res,
      code: statusCode.RESULTNOTFOUND,
      message: "Ticket not found",
    });
  }

  if (["Resolved", "Rejected"].includes(ticket.status)) {
    return responseHandler({
      res,
      code: statusCode.BADREQUEST,
      message: `Ticket already ${ticket.status}`,
    });
  }

  ticket.status = status;

  if (status === "Resolved") {
    ticket.resolvedAt = new Date();
  }

  if (status === "Rejected") {
    ticket.rejectedAt = new Date(); 
  }

  await ticket.save();

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    message: `Ticket ${status.toLowerCase()} successfully`,
    data: ticket,
  });
});
exports.ticketStats = catchAsyncError(async (req, res) => {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);

  const endOfToday = new Date();
  endOfToday.setHours(23, 59, 59, 999);

  const [
    openTickets,
    totalResolved,
    todayResolved,
  ] = await Promise.all([
   
    SupportTicket.countDocuments({ status: "Open" }),

    SupportTicket.countDocuments({ status: "Resolved" }),

    SupportTicket.countDocuments({
      status: "Resolved",
      resolvedAt: {
        $gte: startOfToday,
        $lte: endOfToday,
      },
    }),
  ]);

  return responseHandler({
    res,
    code: statusCode.SUCCESS,
    data: {
      openTickets,
      totalResolved,
      todayResolved,
    },
  });
});

