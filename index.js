const express = require('express');
const cors = require('cors');
const morgan = require('morgan');
require('dotenv').config({ quiet: true });
const port = process.env.PORT;

//utils
const { responseHandler } = require("./src/utils/responseHandler");
const statusCode = require("./src/utils/httpResponseCode");

const rootRoute = require("./src/routes/rootRoute");
const { ensureDefaultSlots } = require("./src/models/deliverySlotModel");
const { startCronJobs } = require("./src/utils/cronJobs");
require("./src/workers/notificationWorker");

// Bull Board setup for queue monitoring
const { createBullBoard } = require("@bull-board/api");
const { BullMQAdapter } = require("@bull-board/api/bullMQAdapter");
const { ExpressAdapter } = require("@bull-board/express");
const notificationQueue = require("./src/queues/notificationQueue");
const productsPayment = require("./src/controllers/user/productsPayment");

require("./src/database/db");

ensureDefaultSlots().catch(console.error);

// Start cron jobs
startCronJobs();

// Notification worker is automatically started when imported
console.log('✅ Notification worker started');

const app = express();

//importing middlewares
const logRequestDetails = require("./src/middleware/logRequestDetails");
const invalidRouteHandler = require("./src/middleware/invalidRouteHandler");
const globalErrorHandler = require("./src/middleware/globalErrorHandler");

app.use(cors());
// Razorpay webhook must receive the untouched raw body for signature verification.
app.post(
    "/api/v1/user/payment/webhook",
    express.raw({ type: "application/json" }),
    productsPayment.razorpayWebhook,
);
// Middleware to parse incoming JSON requests
app.use(express.json({ limit: '5mb' }));
app.use(logRequestDetails);
app.use(morgan('dev'));

// Bull Board setup for queue monitoring
const serverAdapter = new ExpressAdapter();
serverAdapter.setBasePath("/admin/queues");
createBullBoard({
    queues: [new BullMQAdapter(notificationQueue)],
    serverAdapter
});
app.use("/admin/queues", serverAdapter.getRouter());

// API routes
app.use('/api/v1', rootRoute);

app.get("/health", (req, res) => {
    res.status(200).json({
        success: true,
        status: "UP",
        service: "madanlal-backend",
        timestamp: new Date().toISOString()
    });
});

app.use(invalidRouteHandler);
app.use(globalErrorHandler);
// Root route
app.use('/', (req, res) => {
    console.log("Root route accessed");
    responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Welcome To GroceryApp rootroute http://localhost:8001/",
    });
});
app.listen(port, () => {
    console.log(`Server Is Running On http://localhost:${port}/`);
});
