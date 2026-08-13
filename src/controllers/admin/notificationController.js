const Notification = require("../../models/notificationModel");
const NotificationRead = require("../../models/notificationReadModel");
const notificationQueue = require("../../queues/notificationQueue");
//utils
const { responseHandler } = require("../../utils/responseHandler");
const statusCode = require("../../utils/httpResponseCode");
const { catchAsyncError } = require("../../utils/generateError");
const getPagination = require("../../utils/getPagination");
const { isExportRequest, createWorkbook, addSheet, sendWorkbook } = require("../../utils/excelExport");

// Function to add notification job to queue
const sendNotificationToUsers = async (notification) => {
    try {
        const { _id, targetAudience, title, message, type, category } = notification;
        console.log("targetAudience",targetAudience);

        // Add job to queue
        const job = await notificationQueue.add(
            'send-notification',
            {
                notificationId: _id.toString(),
                targetAudience,
                userId: notification.userId ? notification.userId.toString() : null,
                category: category,
                title,
                message,
                type
            },
            // {
            //     // jobId: `notification-${_id.toString()}`,
            //     priority: 1,
            // }
        );

        console.log(`📬 Notification job added to queue: ${job.id} for notification ${_id}`);
        return job;
    } catch (error) {
        console.error("Error adding notification to queue:", error);
        throw error;
    }
};
exports.sendNotificationToUsers = sendNotificationToUsers;
exports.sendAndScheduleNotificationfromAdmin = catchAsyncError(async (req, res) => {
    const {
        type,
        targetAudience,
        title,
        message,
        scheduleOptions,
        scheduleDate,
        scheduleTime
    } = req.body;
    if (!title || !message) {
        return responseHandler({
            res,
            code: statusCode.DATAMISSING,
            message: "Title and message are required"
        });
    }
    if (scheduleOptions === "later") {
        if (!scheduleDate || !scheduleTime) {
            return responseHandler({
                res,
                code: statusCode.DATAMISSING,
                message: "scheduleDate and scheduleTime are required for scheduled notification"
            });
        }
    }
    const payload = {
        type,
        targetAudience,
        title,
        message,
        category: "general",
        scheduleOptions
    };

    if (scheduleOptions === "later") {
        // Validate date and time format
        const combinedDateTime = new Date(`${scheduleDate}T${scheduleTime}`);
        if (isNaN(combinedDateTime.getTime())) {
            return responseHandler({
                res,
                code: statusCode.DATAMISSING,
                message: "Invalid scheduleDate or scheduleTime format"
            });
        }
        payload.scheduleDate = scheduleDate;
        payload.scheduleTime = scheduleTime;
        // sentAt will be set only when notification is actually sent by cron job
    }

    if (scheduleOptions === "now") {
        payload.sentAt = new Date();
    }
    const notification = await Notification.create(payload);
    if (scheduleOptions === "now") {
        await sendNotificationToUsers(notification);
    }
    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: scheduleOptions === "now"
            ? "Notification sent successfully"
            : "Notification scheduled successfully",
        data: notification
    });
});
exports.sendScheduledNotificationsfromCron = catchAsyncError(async () => {
    const now = new Date();

    // Find all scheduled notifications that haven't been sent
    const notifications = await Notification.find({
        scheduleOptions: "later",
        sentAt: { $exists: false },
        scheduleDate: { $exists: true },
        scheduleTime: { $exists: true }
    });

    // Filter notifications where combined dateTime is less than or equal to now
    const notificationsToSend = notifications.filter(notification => {
        const combinedDateTime = new Date(`${notification.scheduleDate}T${notification.scheduleTime}`);
        return !isNaN(combinedDateTime.getTime()) && combinedDateTime <= now;
    });

    for (let i = 0; i < notificationsToSend.length; i++) {
        const notification = notificationsToSend[i];

        await sendNotificationToUsers(notification);

        notification.sentAt = new Date();
        await notification.save();
    }

    if (notificationsToSend.length > 0) {
        console.log(`Sent ${notificationsToSend.length} scheduled notification(s)`);
    }
});
//get all notifications
exports.getAllNotifications = catchAsyncError(async (req, res) => {
    const { page, limit } = req.query;
    const isExport = isExportRequest(req);

    const { skip, limitNum } = getPagination(page, limit);

    const baseQuery = { category: "general" };

    const notifications = await Notification.find(baseQuery)
        .sort({ createdAt: -1 })
        .skip(isExport ? 0 : skip)
        .limit(isExport ? 100000 : limitNum)
        .lean();

    const totalCount = await Notification.countDocuments(baseQuery);

    if (isExport) {
        const workbook = createWorkbook();

        addSheet(workbook, {
            name: "Notifications",
            columns: [
                { header: "Title", key: "title" },
                { header: "Message", key: "message" },
                { header: "Type", key: "type" },
                { header: "Category", key: "category" },
                { header: "Target Audience", key: "targetAudience" },
                { header: "Schedule Options", key: "scheduleOptions" },
                { header: "Schedule Date", key: "scheduleDate" },
                { header: "Schedule Time", key: "scheduleTime" },
                { header: "Sent At", key: "sentAt" },
                { header: "Opened Count", key: "openedCount" },
                { header: "Created At", key: "createdAt" }
            ],
            rows: (notifications || []).map((n) => ({
                title: n?.title || "",
                message: n?.message || "",
                type: n?.type || "",
                category: n?.category || "",
                targetAudience: n?.targetAudience || "",
                scheduleOptions: n?.scheduleOptions || "",
                scheduleDate: n?.scheduleDate || "",
                scheduleTime: n?.scheduleTime || "",
                sentAt: n?.sentAt ? new Date(n.sentAt) : "",
                openedCount: n?.openedCount ?? 0,
                createdAt: n?.createdAt ? new Date(n.createdAt) : ""
            }))
        });

        await sendWorkbook(res, workbook, {
            fileName: `notifications_${new Date().toISOString().slice(0, 10)}.xlsx`
        });
        return;
    }

    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Notifications fetched successfully",
        data: {
            notifications,
            total: totalCount,
            page: parseInt(page) || 1,
            limit: limitNum,
            totalPages: Math.ceil(totalCount / limitNum)
        }
    });
});
//get notification by id
exports.getNotificationById = catchAsyncError(async (req, res) => {
    const { id } = req.query;
    const notification = await Notification.findById(id);
    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Notification fetched successfully",
        data: notification
    });
});

//get all notifications meant for admins
exports.getAdminNotifications = catchAsyncError(async (req, res) => {
    const { page, limit } = req.query;
    const adminId = req.admin?._id;

    const { skip, limitNum } = getPagination(page, limit);

    const notifications = await Notification.find({ targetAudience: "allAdmins" })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum);

    const totalCount = await Notification.countDocuments({ targetAudience: "allAdmins" });

    // Mark as opened once per admin-notification pair
    if (adminId && notifications.length > 0) {
        const notificationIds = notifications.map(n => n._id);

        const existingReads = await NotificationRead.find({
            adminId,
            notificationId: { $in: notificationIds }
        }).select("notificationId");

        const existingReadIds = new Set(existingReads.map(read => read.notificationId.toString()));
        const unreadIds = notificationIds.filter(id => !existingReadIds.has(id.toString()));

        if (unreadIds.length > 0) {
            try {
                await NotificationRead.insertMany(
                    unreadIds.map(notificationId => ({ notificationId, adminId })),
                    { ordered: false }
                );
            } catch (err) {
                if (err?.code !== 11000) {
                    console.error("Error inserting admin notification read records:", err);
                }
            }

            Notification.updateMany(
                { _id: { $in: unreadIds } },
                { $inc: { openedCount: 1 } }
            ).catch(err => console.error("Error updating notification openedCount:", err));
        }
    }

    const formatIstDateTime = (value) =>
        value
            ? new Intl.DateTimeFormat("en-IN", {
                timeZone: "Asia/Kolkata",
                day: "2-digit",
                month: "short",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
                hour12: true,
            }).format(new Date(value))
            : null;

    const formattedNotifications = notifications.map((notification) => {
        const data = notification.toObject();
        const eventAt = data.eventAt || data.sentAt || data.createdAt;
        return {
            ...data,
            eventAt,
            eventTimeIST: formatIstDateTime(eventAt),
        };
    });

    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Admin notifications fetched successfully",
        data: {
            notifications: formattedNotifications,
            total: totalCount,
            page: parseInt(page) || 1,
            limit: limitNum,
            totalPages: Math.ceil(totalCount / limitNum)
        }
    });
});

// unread notifications count for admin
exports.getAdminUnreadNotificationCount = catchAsyncError(async (req, res) => {
    const adminId = req.admin?._id;

    if (!adminId) {
        return responseHandler({
            res,
            code: statusCode.UNAUTHORIZED,
            message: "Admin not found"
        });
    }

    const readCollection = NotificationRead.collection.name;

    const result = await Notification.aggregate([
        { $match: { targetAudience: "allAdmins" } },
        {
            $lookup: {
                from: readCollection,
                let: { notificationId: "$_id" },
                pipeline: [
                    {
                        $match: {
                            $expr: {
                                $and: [
                                    { $eq: ["$notificationId", "$$notificationId"] },
                                    { $eq: ["$adminId", adminId] }
                                ]
                            }
                        }
                    },
                    { $limit: 1 }
                ],
                as: "reads"
            }
        },
        { $match: { reads: { $size: 0 } } },
        { $count: "unreadCount" }
    ]);

    const unreadCount = result[0]?.unreadCount || 0;

    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Admin unread notifications count fetched successfully",
        data: { unreadCount }
    });
});
