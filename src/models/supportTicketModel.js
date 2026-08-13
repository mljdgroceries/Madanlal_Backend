const mongoose = require("mongoose");

const supportTicketSchema = new mongoose.Schema(
  {
    ticketId: {
      type: String
    },

    orderId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "order",
    },

    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "user",
      required: true,
    },

    issue: {
      type: String,
      required: true,
    },

    description: {
      type: String,
      maxlength: 500,
    },
    ticketType: {
      type: String,
      enum: ["General", "Order"],
      default: "General",
    },

    status: {
      type: String,
      enum: ["Open","Resolved","Rejected"],
      default: "Open",
    },

    resolvedAt: Date,
  },
  { timestamps: true }
);

// Indexes for better query performance
supportTicketSchema.index({ userId: 1 }); // For user ticket queries
supportTicketSchema.index({ status: 1 }); // For filtering by status
supportTicketSchema.index({ ticketId: 1 }); // For ticketId lookups (already unique)
supportTicketSchema.index({ userId: 1, status: 1 }); // Compound index for user tickets by status
supportTicketSchema.index({ createdAt: -1 }); // For sorting by creation date

module.exports = mongoose.model("supportTicket", supportTicketSchema);
