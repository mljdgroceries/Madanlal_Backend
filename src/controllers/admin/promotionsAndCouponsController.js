const mongoose = require("mongoose");
const { catchAsyncError } = require("../../utils/generateError");
const Coupon = require('../../models/promotionsAndCouponModal');
const { responseHandler } = require('../../utils/responseHandler');
const statusCode = require("../../utils/httpResponseCode");
const Notification = require("../../models/notificationModel");
const notificationQueue = require("../../queues/notificationQueue");
const { isExportRequest, createWorkbook, addSheet, sendWorkbook } = require("../../utils/excelExport");

function isEmpty(value) {
    return value === undefined || value === null || value === "";
}
exports.createCoupon = catchAsyncError(async (req, res) => {
    const {
        couponCode,
        title,
        description,
        discountType,
        discountValue,
        maxDiscount,
        minOrderValue,
        usageLimit,
        validFrom,
        validTill,
        userType,
        usagePerUser,
        categoryId,
        status,
        autoApplyForEligibleOrders,
        isNotifyUsers
    } = req.body;

    if (isEmpty(couponCode) || isEmpty(title) || isEmpty(discountType) || isEmpty(validFrom) || isEmpty(validTill) || isEmpty(userType) || isEmpty(minOrderValue) || isEmpty(categoryId)) {
        return responseHandler({
            res,
            code: statusCode.DATAMISSING,
            message: "Missing any of the mandatory fields: couponCode, title, discountType, validFrom, validTill, userType, minOrderValue and CategoryId.",
        });
    }
    if (discountType === "Percentage") {
        if (isEmpty(discountValue) || isNaN(discountValue)) {
            return responseHandler({
                res,
                code: statusCode.DATAMISSING,
                message: "discountValue (number) is required for Percentage discount type.",
            });
        }
        if (isEmpty(maxDiscount) || isNaN(maxDiscount)) {
            return responseHandler({
                res,
                code: statusCode.DATAMISSING,
                message: "maxDiscount (number) is required for Percentage discount type.",
            });
        }
    } else if (discountType === "FixedAmount") {
        if (isEmpty(discountValue) || isNaN(discountValue)) {
            return responseHandler({
                res,
                code: statusCode.DATAMISSING,
                message: "discountValue (number) is required for FixedAmount discount type.",
            });
        }
    } else if (discountType === "FreeDelivery") {
        if (!isEmpty(discountValue) || !isEmpty(maxDiscount)) {
            return responseHandler({
                res,
                code: statusCode.DATAMISSING,
                message: "For FreeDelivery type, discountValue and maxDiscount must not be provided.",
            });
        }
    } else {
        return responseHandler({
            res,
            code: statusCode.DATAMISSING,
            message: "Invalid discountType. Allowed values: Percentage, FixedAmount, FreeDelivery",
        });
    }
    const existing = await Coupon.findOne({ couponCode: couponCode.toUpperCase() });
    if (existing) {
        return responseHandler({
            res,
            code: statusCode.FORBIDDEN,
            message: `Coupon code '${couponCode}' already exists.`,
        });
    }
    const newCoupon = new Coupon({
        couponCode: couponCode.toUpperCase(),
        title,
        description,
        discountType,
        discountValue: discountType === "FreeDelivery" ? null : discountValue,
        maxDiscount: discountType === "Percentage" ? maxDiscount : null,
        minOrderValue,
        usageLimit,
        validFrom,
        validTill,
        userType,
        usagePerUser,
        categoryId,
        status,
        autoApplyForEligibleOrders: autoApplyForEligibleOrders || false,
        isNotifyUsers: isNotifyUsers || false,
    });
    const saved = await newCoupon.save();

    // 🔔 Notify Users if requested
    if (isNotifyUsers === true || isNotifyUsers === "true") {
        try {
            const notificationPayload = {
                targetAudience: "all",
                title: title || "New Offer! 🎁",
                message: description || `Use code ${couponCode.toUpperCase()} to get amazing discounts!`,
                type: "push",
                category: "promotions",
                scheduleOptions: "now",
                sentAt: new Date()
            };

            const notification = await Notification.create(notificationPayload);

            await notificationQueue.add('send-notification', {
                notificationId: notification._id.toString(),
                targetAudience: "all",
                category: "promotions",
                title: notificationPayload.title,
                message: notificationPayload.message,
                type: "push"
            });
        } catch (err) {
            console.error("❌ Error sending promotion notification:", err);
        }
    }

    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Coupon created successfully",
        data: saved,
    });
});
exports.getAllCoupons = catchAsyncError(async (req, res) => {
    const { categoryId, status, search } = req.query;
    const matchStage = {};
    if (categoryId) {
        const categoryArray = categoryId.split(",").map(id => new mongoose.Types.ObjectId(id.trim()));
        matchStage.categoryId = { $in: categoryArray };
    }
    if (status) {
        matchStage.status = status;
    }
    if (search) {
        matchStage.$or = [
            { couponCode: { $regex: search, $options: "i" } },
            { title: { $regex: search, $options: "i" } },
        ];
    }
    let coupons = await Coupon.aggregate([
        { $match: matchStage },
        { $sort: { createdAt: -1 } },
        {
            $lookup: {
                from: "categories",
                localField: "categoryId",
                foreignField: "_id",
                as: "categories",
                pipeline: [
                    { $project: { "categoryName": 1, "_id": 1 } }
                ],
            }
        },
        { $project: { categoryId: 0 } }
    ])
    const activeCoupons = await Coupon.countDocuments({ status: "Active" });
    const expiredCoupons = await Coupon.aggregate([
        { $match: { validTill: { $lt: new Date().toISOString() } } },
    ]);

    if (isExportRequest(req)) {
        const workbook = createWorkbook();

        addSheet(workbook, {
            name: "Summary",
            columns: [
                { header: "Metric", key: "metric" },
                { header: "Value", key: "value" }
            ],
            rows: [
                { metric: "Total Coupons", value: coupons.length },
                { metric: "Active Coupons", value: activeCoupons },
                { metric: "Expired Coupons", value: expiredCoupons.length }
            ]
        });

        addSheet(workbook, {
            name: "Coupons",
            columns: [
                { header: "Coupon Code", key: "couponCode" },
                { header: "Title", key: "title" },
                { header: "Description", key: "description" },
                { header: "Discount Type", key: "discountType" },
                { header: "Discount Value", key: "discountValue" },
                { header: "Max Discount", key: "maxDiscount" },
                { header: "Min Order Value", key: "minOrderValue" },
                { header: "Usage Limit", key: "usageLimit" },
                { header: "Usage Used", key: "usageUsed" },
                { header: "Usage Per User", key: "usagePerUser" },
                { header: "User Type", key: "userType" },
                { header: "Status", key: "status" },
                { header: "Valid From", key: "validFrom" },
                { header: "Valid Till", key: "validTill" },
                { header: "Auto Apply", key: "autoApplyForEligibleOrders" },
                { header: "Notify Users", key: "isNotifyUsers" },
                { header: "Categories", key: "categories" },
                { header: "Created At", key: "createdAt" }
            ],
            rows: (coupons || []).map((c) => ({
                couponCode: c?.couponCode || "",
                title: c?.title || "",
                description: c?.description || "",
                discountType: c?.discountType || "",
                discountValue: c?.discountValue ?? "",
                maxDiscount: c?.maxDiscount ?? "",
                minOrderValue: c?.minOrderValue ?? "",
                usageLimit: c?.usageLimit ?? "",
                usageUsed: c?.usageUsed ?? "",
                usagePerUser: c?.usagePerUser ?? "",
                userType: c?.userType || "",
                status: c?.status || "",
                validFrom: c?.validFrom || "",
                validTill: c?.validTill || "",
                autoApplyForEligibleOrders: Boolean(c?.autoApplyForEligibleOrders),
                isNotifyUsers: Boolean(c?.isNotifyUsers),
                categories: (c?.categories || []).map((x) => x?.categoryName).filter(Boolean).join(", "),
                createdAt: c?.createdAt ? new Date(c.createdAt) : ""
            }))
        });

        await sendWorkbook(res, workbook, {
            fileName: `coupons_${new Date().toISOString().slice(0, 10)}.xlsx`
        });
        return;
    }

    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Coupons fetched successfully",
        data: {
            allCoupons: coupons,
            totalCoupons: coupons.length,
            activeCoupons: activeCoupons,
            expiredCoupons: expiredCoupons.length,
            totalRedeemedCoupons: 0,
            totalDiscountGiven: 0
        }
    });
})
exports.getCouponById = catchAsyncError(async (req, res) => {
    const { id } = req.query;
    if (!id) {
        return responseHandler({
            res,
            code: statusCode.DATAMISSING,
            message: "Coupons Id is required",
        });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
        return responseHandler({
            res,
            code: statusCode.BADREQUEST,
            message: "Invalid coupon ID"
        });
    }
    let coupons = await Coupon.findById(id).populate("categoryId", "categoryName _id");
    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Coupon fetched successfully",
        data: coupons
    });
})
exports.updateCouponById = catchAsyncError(async (req, res) => {
    const { id } = req.query;
    const {
        couponCode,
        title,
        description,
        discountType,
        discountValue,
        maxDiscount,
        minOrderValue,
        validFrom,
        validTill,
        userType,
        usagePerUser,
        categoryId,
        status,
        autoApplyForEligibleOrders,
        isNotifyUsers
    } = req.body;
    if (!id) {
        return responseHandler({
            res,
            code: statusCode.DATAMISSING,
            message: "Coupon ID is required.",
        });
    }
    if (!mongoose.Types.ObjectId.isValid(id)) {
        return responseHandler({
            res,
            code: statusCode.DATAMISSING,
            message: "Invalid coupon ID.",
        });
    }
    if (isEmpty(couponCode) || isEmpty(title) || isEmpty(discountType) ||
        isEmpty(validFrom) || isEmpty(validTill) || isEmpty(userType) || isEmpty(minOrderValue) || isEmpty(categoryId)) {
        return responseHandler({
            res,
            code: statusCode.DATAMISSING,
            message: "Missing mandatory fields: couponCode, title, discountType, validFrom, validTill, userType, minOrderValue, and categoryId.",
        });
    }
    if (discountType === "Percentage") {
        if (isEmpty(discountValue) || isNaN(discountValue)) {
            return responseHandler({
                res,
                code: statusCode.DATAMISSING,
                message: "discountValue (number) is required for Percentage discount type.",
            });
        }
        if (isEmpty(maxDiscount) || isNaN(maxDiscount)) {
            return responseHandler({
                res,
                code: statusCode.DATAMISSING,
                message: "maxDiscount (number) is required for Percentage discount type.",
            });
        }
    } else if (discountType === "FixedAmount") {
        if (isEmpty(discountValue) || isNaN(discountValue)) {
            return responseHandler({
                res,
                code: statusCode.DATAMISSING,
                message: "discountValue (number) is required for FixedAmount discount type.",
            });
        }
    } else if (discountType === "FreeDelivery") {
        if (!isEmpty(discountValue) || !isEmpty(maxDiscount)) {
            return responseHandler({
                res,
                code: statusCode.DATAMISSING,
                message: "For FreeDelivery type, discountValue and maxDiscount must not be provided.",
            });
        }
    } else {
        return responseHandler({
            res,
            code: statusCode.DATAMISSING,
            message: "Invalid discountType. Allowed values: Percentage, FixedAmount, FreeDelivery.",
        });
    }
    const existingCoupon = await Coupon.findOne({
        couponCode: couponCode.toUpperCase(),
        _id: { $ne: id },
    });
    if (existingCoupon) {
        return responseHandler({
            res,
            code: statusCode.CONFLICT,
            message: `Coupon code '${couponCode}' already exists.`,
        });
    }

    // Build update payload (exclude usageLimit)
    const updatePayload = {
        couponCode: couponCode.toUpperCase(),
        title,
        description,
        discountType,
        discountValue: discountType === "FreeDelivery" ? null : discountValue,
        maxDiscount: discountType === "Percentage" ? maxDiscount : null,
        minOrderValue,
        validFrom,
        validTill,
        userType,
        usagePerUser,
        categoryId,
        status,
        autoApplyForEligibleOrders: autoApplyForEligibleOrders || false,
        isNotifyUsers: isNotifyUsers || false,
    };
    const updatedCoupon = await Coupon.findByIdAndUpdate(id, updatePayload, {
        new: true,
        runValidators: true,
    });
    if (!updatedCoupon) {
        return responseHandler({
            res,
            code: statusCode.RESULTNOTFOUND,
            message: "Coupon not found.",
        });
    }

    // 🔔 Notify Users if requested status changed to true or if it's true and title/desc updated?
    // User specifically asked: "if now when we are creating promotions and sending isNotifyUsers as true then users ke pass iski notification jaegi"
    // Usually, we notify on create or if manually triggered. Let's do it on update too if passed as true.
    if (isNotifyUsers === true || isNotifyUsers === "true") {
        try {
            const notificationPayload = {
                targetAudience: "all",
                title: title || updatedCoupon.title || "Special Offer Updated! 🎁",
                message: description || updatedCoupon.description || `Check out ${updatedCoupon.couponCode}!`,
                type: "push",
                category: "promotions",
                scheduleOptions: "now",
                sentAt: new Date()
            };

            const notification = await Notification.create(notificationPayload);

            await notificationQueue.add('send-notification', {
                notificationId: notification._id.toString(),
                targetAudience: "all",
                category: "promotions",
                title: notificationPayload.title,
                message: notificationPayload.message,
                type: "push"
            });
        } catch (err) {
            console.error("❌ Error sending promotion update notification:", err);
        }
    }

    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Coupon updated successfully.",
        data: updatedCoupon,
    });
});
exports.deleteCouponById = catchAsyncError(async (req, res, next) => {
    const { id } = req.query;
    if (!id) {
        return responseHandler({
            res,
            code: statusCode.DATAMISSING,
            message: "Coupon Id is required",
        });
    }
    const deletedCoupon = await Coupon.findByIdAndDelete(id);
    if (!deletedCoupon) {
        return responseHandler({
            res,
            code: statusCode.RESULTNOTFOUND,
            message: "Coupon not found",
        });
    }
    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Coupon deleted successfully",
    });
})
