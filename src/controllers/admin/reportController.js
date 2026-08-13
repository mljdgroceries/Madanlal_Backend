const Order = require("../../models/orderModel");
const User = require("../../models/userModel");
const Product = require("../../models/productModel");
const Zone = require("../../models/deliveryZonesModel");
const SearchHistory = require("../../models/searchHistoryModel");
const Category = require("../../models/categorySubCategoryModel");
const statusCode = require("../../utils/httpResponseCode");
const { responseHandler } = require("../../utils/responseHandler");
const { catchAsyncError } = require("../../utils/generateError");
const { isExportRequest, createWorkbook, addSheet, sendWorkbook } = require("../../utils/excelExport");
const mongoose = require("mongoose");

const getTimeRanges = ({ timeRange, startDate, endDate }) => {
    const normalized = String(timeRange || "last30Days").trim().toLowerCase();
    const currentEnd = new Date();
    let currentStart = new Date(currentEnd);
    let previousStart;
    let previousEnd;

    const setDaysRange = (days) => {
        currentStart = new Date(currentEnd);
        currentStart.setDate(currentStart.getDate() - days);
        previousEnd = new Date(currentStart);
        previousStart = new Date(currentStart);
        previousStart.setDate(previousStart.getDate() - days);
    };

    if (normalized === "last7days") setDaysRange(7);
    else if (normalized === "last30days") setDaysRange(30);
    else if (normalized === "last90days") setDaysRange(90);
    else if (normalized === "custom" && startDate && endDate) {
        currentStart = new Date(startDate);
        const customEnd = new Date(endDate);
        const durationMs = customEnd.getTime() - currentStart.getTime();
        previousEnd = new Date(currentStart);
        previousStart = new Date(currentStart.getTime() - durationMs);
        return { currentStart, currentEnd: customEnd, previousStart, previousEnd };
    } else {
        setDaysRange(30);
    }

    return { currentStart, currentEnd, previousStart, previousEnd };
};

const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");



exports.getSalesReport = catchAsyncError(async (req, res) => {

    const {
        timeRange = "Daily",
        startDate,
        endDate,
        paymentMethod = "All",
        chartRange = "lastWeek"
    } = req.query;

    let currentStart, currentEnd = new Date();
    let previousStart, previousEnd;

    // ================= SUMMARY RANGE =================
    if (timeRange === "Daily") {
        currentStart = new Date();
        currentStart.setHours(0, 0, 0, 0);

        previousEnd = new Date(currentStart);
        previousStart = new Date(currentStart);
        previousStart.setDate(previousStart.getDate() - 1);
    } 
    else if (timeRange === "Weekly") {
        currentStart = new Date();
        currentStart.setDate(currentStart.getDate() - 7);

        previousEnd = new Date(currentStart);
        previousStart = new Date(previousEnd);
        previousStart.setDate(previousStart.getDate() - 7);
    } 
    else if (timeRange === "Monthly") {
        currentStart = new Date();
        currentStart.setDate(currentStart.getDate() - 30);

        previousEnd = new Date(currentStart);
        previousStart = new Date(previousEnd);
        previousStart.setDate(previousStart.getDate() - 30);
    } 
    else if (timeRange === "Custom" && startDate && endDate) {
        currentStart = new Date(startDate);
        currentEnd = new Date(endDate);

        const duration = currentEnd.getTime() - currentStart.getTime();
        previousEnd = new Date(currentStart);
        previousStart = new Date(currentStart.getTime() - duration);
    }

    // ================= CHART RANGE =================
    let chartStart = new Date();
    let chartEnd = new Date();

    const normalizedChartRange = String(chartRange).toLowerCase();

    if (normalizedChartRange === "lastweek") {
        chartStart.setDate(chartStart.getDate() - 7);
    }
    else if (normalizedChartRange === "lastmonth") {
        chartStart.setDate(chartStart.getDate() - 30);
    }
    else if (normalizedChartRange === "lastyear") {
        chartStart.setFullYear(chartStart.getFullYear() - 1);
    }

    // ================= BASE MATCH =================
    let baseMatch = {};

    if (paymentMethod !== "All") {
        baseMatch.paymentMethod = paymentMethod;
    }

    // ================= HELPER =================
    const getStats = async (start, end) => {
        const result = await Order.aggregate([
            {
                $match: {
                    ...baseMatch,
                    createdAt: { $gte: start, $lte: end }
                }
            },
            {
                $group: {
                    _id: null,
                    totalOrders: { $sum: 1 },
                    totalSales: {
                        $sum: {
                            $cond: [
                                { $eq: ["$status", "Delivered"] },
                                "$grandTotal",
                                0
                            ]
                        }
                    },
                    codRevenue: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $eq: ["$status", "Delivered"] },
                                        { $eq: ["$paymentMethod", "COD"] }
                                    ]
                                },
                                "$grandTotal",
                                0
                            ]
                        }
                    },
                    prepaidRevenue: {
                        $sum: {
                            $cond: [
                                {
                                    $and: [
                                        { $eq: ["$status", "Delivered"] },
                                        { $eq: ["$paymentMethod", "Prepaid"] }
                                    ]
                                },
                                "$grandTotal",
                                0
                            ]
                        }
                    }
                }
            }
        ]);

        return result[0] || {
            totalOrders: 0,
            totalSales: 0,
            codRevenue: 0,
            prepaidRevenue: 0
        };
    };

    const currentStats = await getStats(currentStart, currentEnd);
    const previousStats = await getStats(previousStart, previousEnd);

    // ================= SALES TREND =================
    const trendAgg = await Order.aggregate([
        {
            $match: {
                ...baseMatch,
                status: "Delivered",
                createdAt: { $gte: chartStart, $lte: chartEnd }
            }
        },
        {
            $group: {
                _id: {
                    $dateToString: {
                        format: "%Y-%m-%d",
                        date: "$createdAt"
                    }
                },
                revenue: { $sum: "$grandTotal" },
                orders: { $sum: 1 }
            }
        },
        { $sort: { _id: 1 } }
    ]);

    // ================= 🔥 FILL MISSING DATES (FINAL FIX) =================
    const filledTrend = [];
    const map = new Map();

    trendAgg.forEach(item => {
        map.set(item._id, item);
    });

    let current = new Date(chartStart);

    while (current <= chartEnd) {
        const dateStr = current.toISOString().slice(0, 10);

        if (map.has(dateStr)) {
            filledTrend.push(map.get(dateStr));
        } else {
            filledTrend.push({
                _id: dateStr,
                revenue: 0,
                orders: 0
            });
        }

        current.setDate(current.getDate() + 1);
    }

    // ================= CALCULATIONS =================
    const calculateChange = (current, previous) => {
        if (previous === 0) return current > 0 ? 100 : 0;
        return Number(((current - previous) / previous * 100).toFixed(1));
    };

    const codPercent = currentStats.totalSales > 0
        ? Number(((currentStats.codRevenue / currentStats.totalSales) * 100).toFixed(0))
        : 0;

    const prepaidPercent = currentStats.totalSales > 0
        ? Number(((currentStats.prepaidRevenue / currentStats.totalSales) * 100).toFixed(0))
        : 0;

    // ================= RESPONSE =================
    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Sales report fetched successfully",
        data: {
            summary: {
                totalOrders: {
                    value: currentStats.totalOrders,
                    change: calculateChange(currentStats.totalOrders, previousStats.totalOrders)
                },
                totalSales: {
                    value: Math.round(currentStats.totalSales),
                    change: calculateChange(currentStats.totalSales, previousStats.totalSales)
                },
                codRevenue: {
                    value: Math.round(currentStats.codRevenue),
                    percentageOfTotal: codPercent
                },
                prepaidRevenue: {
                    value: Math.round(currentStats.prepaidRevenue),
                    percentageOfTotal: prepaidPercent
                }
            },

            salesTrend: {
                data: filledTrend, // ✅ FINAL FIXED DATA
                range: chartRange
            }
        }
    });

});

exports.getPincodeAnalytics = catchAsyncError(async (req, res) => {
    const { timeRange, startDate, endDate, status, heatmapTop, highDemandTop } = req.query;

    let matchCondition = {};

    // 1. Time Range Filter
    const now = new Date();
    if (timeRange === "last7Days") {
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(now.getDate() - 7);
        matchCondition.createdAt = { $gte: sevenDaysAgo };
    } else if (timeRange === "last30Days") {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(now.getDate() - 30);
        matchCondition.createdAt = { $gte: thirtyDaysAgo };
    } else if (timeRange === "custom" && startDate && endDate) {
        matchCondition.createdAt = {
            $gte: new Date(startDate),
            $lte: new Date(endDate),
        };
    }

    // Completed: Delivered
    // Pending: ["Pending", "Confirmed", "Packed", "Shipped"]
    // Cancelled: Cancelled
    // All

    // 2. Status Filter
    if (status && status !== "All") {
        if (status === "Completed") {
            matchCondition.status = "Delivered";
        } else if (status === "Pending") {
            matchCondition.status = { $in: ["Pending", "Confirmed", "Packed", "Shipped"] };
        } else {
            matchCondition.status = status;
        }
    }

    const heatmapTopNumber = Math.max(0, Number(heatmapTop) || 0); // 0 => no limit
    const highDemandTopNumber = Math.max(0, Number(highDemandTop) || 20);

    // Get all pincodes + coordinates from Delivery Zones
    const zones = await Zone.find({}).select("zoneName priorityLevel locations.pin locations.lat locations.lng status");
    const servicedPincodeMeta = {};
    zones.forEach((z) => {
        (z.locations || []).forEach((l) => {
            if (!l?.pin) return;
            const pin = String(l.pin);
            const existing = servicedPincodeMeta[pin];

            const next = {
                status: z.status,
                zoneName: z.zoneName || "",
                priorityLevel: z.priorityLevel || "Medium",
                lat: typeof l.lat === "number" ? l.lat : null,
                lng: typeof l.lng === "number" ? l.lng : null,
            };

            if (!existing) {
                servicedPincodeMeta[pin] = next;
                return;
            }

            // If duplicates exist, prefer the first, but fill missing coords/meta.
            servicedPincodeMeta[pin] = {
                status: existing.status || next.status,
                zoneName: existing.zoneName || next.zoneName,
                priorityLevel: existing.priorityLevel || next.priorityLevel,
                lat: typeof existing.lat === "number" ? existing.lat : next.lat,
                lng: typeof existing.lng === "number" ? existing.lng : next.lng,
            };
        });
    });
    const servicedPincodes = Object.keys(servicedPincodeMeta);

    const pincodeAgg = await Order.aggregate([
        { $match: matchCondition },
        {
            $group: {
                _id: "$deliveryAddress.pincode",
                orderCount: { $sum: 1 },
                totalDeliveries: { $sum: 1 },
                successDeliveries: {
                    $sum: { $cond: [{ $eq: ["$status", "Delivered"] }, 1, 0] },
                },
                failedDeliveries: {
                    $sum: { $cond: [{ $eq: ["$status", "Cancelled"] }, 1, 0] },
                },
                pendingDeliveries: {
                    $sum: { $cond: [{ $in: ["$status", ["Pending", "Confirmed", "Packed", "Shipped"]] }, 1, 0] },
                },
                // Calculation for average delivery time (in hours)
                avgDeliveryTime: {
                    $avg: {
                        $cond: [
                            { $and: [{ $eq: ["$status", "Delivered"] }, { $ne: ["$tracking.deliveredAt", null] }] },
                            { $divide: [{ $subtract: ["$tracking.deliveredAt", "$createdAt"] }, 3600000] },
                            null
                        ]
                    }
                }
            },
        },
        {
            $project: {
                pincode: "$_id",
                orderCount: 1,
                totalDeliveries: 1,
                successDeliveries: 1,
                failedDeliveries: 1,
                pendingDeliveries: 1,
                avgDeliveryTime: { $round: ["$avgDeliveryTime", 1] },
                successRate: {
                    $cond: [
                        { $gt: ["$totalDeliveries", 0] },
                        {
                            $multiply: [
                                { $divide: ["$successDeliveries", "$totalDeliveries"] },
                                100
                            ]
                        },
                        0
                    ]
                },
            },
        },
        { $sort: { orderCount: -1 } },
    ]);

    // Map to include serviced pincodes that might have 0 orders in the filtered period
    const resultsMap = pincodeAgg.reduce((acc, item) => {
        if (item.pincode) acc[item.pincode] = item;
        return acc;
    }, {});

    const finalResults = servicedPincodes.map((pin) => {
        const stats = resultsMap[pin] || {
            pincode: pin,
            orderCount: 0,
            totalDeliveries: 0,
            successDeliveries: 0,
            failedDeliveries: 0,
            pendingDeliveries: 0,
            avgDeliveryTime: 0,
            successRate: 0
        };
        return {
            ...stats,
            status: servicedPincodeMeta[pin]?.status || "Inactive",
            zoneName: servicedPincodeMeta[pin]?.zoneName || "",
            priorityLevel: servicedPincodeMeta[pin]?.priorityLevel || "Medium",
            lat: servicedPincodeMeta[pin]?.lat ?? null,
            lng: servicedPincodeMeta[pin]?.lng ?? null,
        };
    }).sort((a, b) => b.orderCount - a.orderCount);

    const heatmapPointsAll = (finalResults || [])
        .filter((r) => typeof r.lat === "number" && !Number.isNaN(r.lat) && typeof r.lng === "number" && !Number.isNaN(r.lng))
        .map((r) => ({
            pincode: r.pincode,
            lat: r.lat,
            lng: r.lng,
            intensity: r.orderCount || 0,
            orderCount: r.orderCount || 0,
            successRate: Number(((r.successRate ?? 0)).toFixed(1)),
            status: r.status,
            zoneName: r.zoneName,
            priorityLevel: r.priorityLevel,
        }))
        .sort((a, b) => (b.orderCount || 0) - (a.orderCount || 0));

    const heatmapPoints = heatmapTopNumber > 0 ? heatmapPointsAll.slice(0, heatmapTopNumber) : heatmapPointsAll;
    const highDemandPoints = highDemandTopNumber > 0 ? heatmapPointsAll.filter((p) => (p.orderCount || 0) > 0).slice(0, highDemandTopNumber) : [];

    if (isExportRequest(req)) {
        const workbook = createWorkbook();

        const columns = [
            { header: "Pincode", key: "pincode" },
            { header: "Status", key: "status" },
            { header: "Zone", key: "zoneName" },
            { header: "Priority", key: "priorityLevel" },
            { header: "Lat", key: "lat" },
            { header: "Lng", key: "lng" },
            { header: "Order Count", key: "orderCount" },
            { header: "Total Deliveries", key: "totalDeliveries" },
            { header: "Success Deliveries", key: "successDeliveries" },
            { header: "Failed Deliveries", key: "failedDeliveries" },
            { header: "Pending Deliveries", key: "pendingDeliveries" },
            { header: "Avg Delivery Time (hrs)", key: "avgDeliveryTime" },
            { header: "Success Rate (%)", key: "successRate" }
        ];

        addSheet(workbook, {
            name: "All Pincodes",
            columns,
            rows: finalResults
        });

        addSheet(workbook, {
            name: "Top 10",
            columns,
            rows: finalResults.slice(0, 10)
        });

        addSheet(workbook, {
            name: "Heatmap Points",
            columns: [
                { header: "Pincode", key: "pincode" },
                { header: "Lat", key: "lat" },
                { header: "Lng", key: "lng" },
                { header: "Intensity (Orders)", key: "intensity" },
                { header: "Order Count", key: "orderCount" },
                { header: "Success Rate (%)", key: "successRate" },
                { header: "Status", key: "status" },
                { header: "Zone", key: "zoneName" },
                { header: "Priority", key: "priorityLevel" },
            ],
            rows: heatmapPointsAll
        });

        addSheet(workbook, {
            name: "High Demand",
            columns: [
                { header: "Pincode", key: "pincode" },
                { header: "Lat", key: "lat" },
                { header: "Lng", key: "lng" },
                { header: "Intensity (Orders)", key: "intensity" },
                { header: "Order Count", key: "orderCount" },
                { header: "Success Rate (%)", key: "successRate" },
                { header: "Status", key: "status" },
                { header: "Zone", key: "zoneName" },
                { header: "Priority", key: "priorityLevel" },
            ],
            rows: highDemandPoints
        });

        await sendWorkbook(res, workbook, {
            fileName: `pincode_analytics_${new Date().toISOString().slice(0, 10)}.xlsx`
        });
        return;
    }

    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Pincode analytics fetched successfully",
        data: {
            topPincodes: finalResults.slice(0, 10),
            allPincodes: finalResults,
            heatmap: {
                metric: "orderCount",
                points: heatmapPoints
            },
            highDemand: {
                metric: "orderCount",
                top: highDemandTopNumber,
                points: highDemandPoints
            }
        },
    });
});

/**
 * 3. Product Popularity Insights API
 * Filters: timeRange, startDate, endDate, categoryId
 */

exports.getProductPopularity = catchAsyncError(async (req, res) => {

    const {
        timeRange = "last30Days",
        startDate,
        endDate,
        categoryId,
        search,
        page = 1,
        limit = 10
    } = req.query;

    const pageNumber = Math.max(1, Number(page) || 1);
    const limitNumber = Math.max(1, Number(limit) || 10);
    const skip = (pageNumber - 1) * limitNumber;

    const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const searchRegex = search ? new RegExp(escapeRegex(search.trim()), "i") : null;

    let matchCondition = { status: "Delivered" };
    const now = new Date();

    if (timeRange === "last7Days") {
        const d = new Date();
        d.setDate(now.getDate() - 7);
        matchCondition.createdAt = { $gte: d };
    } else if (timeRange === "last30Days") {
        const d = new Date();
        d.setDate(now.getDate() - 30);
        matchCondition.createdAt = { $gte: d };
    } else if (timeRange === "last90Days") {
        const d = new Date();
        d.setDate(now.getDate() - 90);
        matchCondition.createdAt = { $gte: d };
    } else if (timeRange === "custom" && startDate && endDate) {
        matchCondition.createdAt = {
            $gte: new Date(startDate),
            $lte: new Date(endDate)
        };
    }

    // ================= TOP SELLING (UNCHANGED) =================
    const topSellingAgg = await Order.aggregate([
        { $match: matchCondition },
        { $unwind: "$items" },
        {
            $lookup: {
                from: "products",
                localField: "items.productId",
                foreignField: "_id",
                as: "productInfo"
            }
        },
        { $unwind: "$productInfo" },
        {
            $addFields: {
                variationInfo: {
                    $arrayElemAt: [
                        {
                            $filter: {
                                input: "$productInfo.productVariations",
                                as: "v",
                                cond: { $eq: ["$$v._id", "$items.variationId"] }
                            }
                        },
                        0
                    ]
                }
            }
        },
        ...(categoryId ? [{
            $match: {
                "productInfo.categoryId": new mongoose.Types.ObjectId(categoryId)
            }
        }] : []),
        {
            $group: {
                _id: "$items.productId",
                baseProductName: { $first: "$productInfo.productName" },
                variationId: { $first: "$items.variationId" },
                measurmentValue: { $first: "$variationInfo.measurmentValue" },
                measurmentUnit: { $first: "$variationInfo.measurmentUnit" },
                minStock: { $first: "$variationInfo.minStock" },
                totalSold: { $sum: "$items.quantity" },
                revenue: { $sum: "$items.subtotal" },
                categoryId: { $first: "$productInfo.categoryId" }
            }
        },
        {
            $addFields: {
                productName: {
                    $cond: [
                        {
                            $and: [
                                { $ne: ["$measurmentValue", null] },
                                { $ne: ["$measurmentUnit", null] }
                            ]
                        },
                        {
                            $concat: [
                                "$baseProductName",
                                " (",
                                { $toString: "$measurmentValue" },
                                " ",
                                "$measurmentUnit",
                                ")"
                            ]
                        },
                        "$baseProductName"
                    ]
                }
            }
        },
        { $project: { baseProductName: 0 } },
        { $sort: { totalSold: -1 } },
        { $limit: 10 }
    ]);

    // ================= STOCK =================
    // const stockStats = await Product.aggregate([
    //     { $unwind: "$productVariations" },
    //     ...(categoryId ? [{ $match: { categoryId: new mongoose.Types.ObjectId(categoryId) } }] : []),
    const stockStats = await Product.aggregate([
    {
        $match: {
            isDeleted: { $ne: true }   // ✅ ADD THIS
        }
    },
    { $unwind: "$productVariations" },
    {
        $match: {
            "productVariations.isDeleted": { $ne: true } // ✅ ADD THIS
        }
    },
    ...(categoryId ? [{ $match: { categoryId: new mongoose.Types.ObjectId(categoryId) } }] : []),
        {
            $project: {
                productId: "$_id",
                variationId: "$productVariations._id",
                productName: "$productName",
                sku: "$productVariations.sku",
                outOfStockCount: { $ifNull: ["$productVariations.outOfStockCount", 0] },
                stockQuantity: "$productVariations.stockQuantity",
                minStock: "$productVariations.minStock",
                stockStatus: "$productVariations.stockStatus",
                lastRestockedAt: "$productVariations.lastRestockedAt"
            }
        },
        ...(searchRegex ? [{ $match: { productName: searchRegex } }] : [])
    ]);

    const variationSalesAgg = await Order.aggregate([
        { $match: matchCondition },
        { $unwind: "$items" },
        {
            $group: {
                _id: { variationId: "$items.variationId" },
                totalSold: { $sum: "$items.quantity" }
            }
        }
    ]);

    const variationSalesMap = variationSalesAgg.reduce((acc, row) => {
        const key = row?._id?.variationId?.toString();
        if (!key) return acc;
        acc[key] = row.totalSold || 0;
        return acc;
    }, {});

    const stockStatsWithSales = stockStats.map(v => ({
        ...v,
        totalSold: variationSalesMap[v.variationId?.toString()] || 0
    }));

    // ================= PRODUCT PERFORMANCE (PAGINATED) =================
    const sortedPerformance = stockStatsWithSales.sort((a, b) =>
        (b.outOfStockCount || 0) - (a.outOfStockCount || 0)
    );

    const totalCount = sortedPerformance.length;
    const totalPages = Math.ceil(totalCount / limitNumber);

    const productPerformanceData = sortedPerformance.slice(skip, skip + limitNumber);

    const outOfStockTop50 = sortedPerformance
        .filter(p => p.outOfStockCount >= 1)
        .slice(0, 50);

    const lowStock = sortedPerformance
        .filter(p => p.stockStatus === "lowStock")
        .slice(0, 10);

    // ================= FINAL RESPONSE =================
    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Product popularity insights fetched successfully",
        data: {
            topSelling: topSellingAgg, // ✅ unchanged

            productPerformanceData: {
                data: productPerformanceData,
                pagination: {
                    totalCount,
                    currentPage: pageNumber,
                    totalPages,
                    limit: limitNumber
                }
            },

            outOfStockTop50,
            lowStock
        }
    });

});

/**
 * 4. User Behavior Analytics API
 * Filters: timeRange, startDate, endDate, search (by mobile), page, limit
 */

exports.getUserBehavior = catchAsyncError(async (req, res) => {

    const {
        timeRange = "last30Days",
        startDate,
        endDate,
        search,
        page = 1,
        limit = 15
    } = req.query;

    const isExport = isExportRequest(req);

    const pageNumber = Math.max(1, Number(page) || 1);
    const limitNumber = isExport ? 100000 : Math.max(1, Number(limit) || 15);
    const skip = isExport ? 0 : (pageNumber - 1) * limitNumber;

    const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const searchRegex = search ? new RegExp(escapeRegex(String(search).trim()), "i") : null;

    // ================= TIME FILTER =================
    let matchCondition = { status: "Delivered" };
    const now = new Date();

    const normalizedTimeRange = String(timeRange).trim().toLowerCase();

    if (normalizedTimeRange === "last7days") {
        const d = new Date();
        d.setDate(now.getDate() - 7);
        matchCondition.createdAt = { $gte: d };
    } else if (normalizedTimeRange === "last30days") {
        const d = new Date();
        d.setDate(now.getDate() - 30);
        matchCondition.createdAt = { $gte: d };
    } else if (normalizedTimeRange === "last90days") {
        const d = new Date();
        d.setDate(now.getDate() - 90);
        matchCondition.createdAt = { $gte: d };
    } else if (normalizedTimeRange === "custom" && startDate && endDate) {
        matchCondition.createdAt = {
            $gte: new Date(startDate),
            $lte: new Date(endDate)
        };
    }

    // ================= USER STATS =================
    const userStatsAgg = await Order.aggregate([
        { $match: matchCondition },
        {
            $group: {
                _id: "$userId",
                orderCount: { $sum: 1 },
                totalSpent: { $sum: "$grandTotal" },
                lastOrderDate: { $max: "$createdAt" }
            }
        },
        {
            $addFields: {
                avgOrderValue: {
                    $cond: [
                        { $gt: ["$orderCount", 0] },
                        { $divide: ["$totalSpent", "$orderCount"] },
                        0
                    ]
                }
            }
        },
        {
            $addFields: {
                userTier: {
                    $switch: {
                        branches: [
                            { case: { $eq: ["$orderCount", 1] }, then: "New" },
                            { case: { $gte: ["$avgOrderValue", 2500] }, then: "Premium" },
                            { case: { $gte: ["$avgOrderValue", 800] }, then: "Regular" },
                            { case: { $gte: ["$avgOrderValue", 500] }, then: "Basic" }
                        ],
                        default: "Basic"
                    }
                }
            }
        }
    ]);

    const totalActiveUsers = userStatsAgg.length;
    const totalOrders = userStatsAgg.reduce((s, u) => s + u.orderCount, 0);
    const totalRevenue = userStatsAgg.reduce((s, u) => s + u.totalSpent, 0);

    const avgOrderFrequency = totalActiveUsers ? (totalOrders / totalActiveUsers).toFixed(1) : 0;
    const avgCartValue = totalOrders ? (totalRevenue / totalOrders).toFixed(0) : 0;

    // ================= SEGMENTS =================
    const segmentData = {
        Premium: { userCount: 0, revenue: 0 },
        Regular: { userCount: 0, revenue: 0 },
        Basic: { userCount: 0, revenue: 0 },
        New: { userCount: 0, revenue: 0 }
    };

    userStatsAgg.forEach(u => {
        if (segmentData[u.userTier]) {
            segmentData[u.userTier].userCount++;
            if (u.userTier !== "New") {
                segmentData[u.userTier].revenue += u.totalSpent;
            }
        }
    });

    // ================= CATEGORY =================
    const categoryStatsAgg = await Order.aggregate([
        { $match: matchCondition },
        { $unwind: "$items" },
        {
            $lookup: {
                from: "products",
                localField: "items.productId",
                foreignField: "_id",
                as: "productInfo"
            }
        },
        { $unwind: "$productInfo" },
        // ✅ ADD THIS
{
    $match: {
        "productInfo.isDeleted": { $ne: true }
    }
},
        {
            $lookup: {
                from: "categories",
                localField: "productInfo.categoryId",
                foreignField: "_id",
                as: "categoryInfo"
            }
        },
        { $unwind: "$categoryInfo" },
        {
            $group: {
                _id: "$categoryInfo._id",
                categoryName: { $first: "$categoryInfo.categoryName" },
                orderIds: { $addToSet: "$_id" }
            }
        },
        {
            $project: {
                categoryName: 1,
                orderCount: { $size: "$orderIds" }
            }
        },
        { $sort: { orderCount: -1 } }
    ]);

    const totalCategoryOrders = categoryStatsAgg.reduce((s, c) => s + c.orderCount, 0);

    const preferredCategories = categoryStatsAgg.slice(0, 10).map(c => ({
        ...c,
        percentage: totalCategoryOrders
            ? ((c.orderCount / totalCategoryOrders) * 100).toFixed(1)
            : 0
    }));

    // ================= USER ACTIVITY (WITH PAGINATION) =================
    const userActivityResult = await Order.aggregate([
        { $match: matchCondition },

        {
            $group: {
                _id: "$userId",
                orderCount: { $sum: 1 },
                totalSpent: { $sum: "$grandTotal" },
                lastOrderDate: { $max: "$createdAt" }
            }
        },

        {
            $addFields: {
                avgOrderValue: {
                    $cond: [
                        { $gt: ["$orderCount", 0] },
                        { $divide: ["$totalSpent", "$orderCount"] },
                        0
                    ]
                }
            }
        },

        {
            $lookup: {
                from: "users",
                localField: "_id",
                foreignField: "_id",
                as: "userInfo"
            }
        },

        { $unwind: "$userInfo" },

        {
            $project: {
                userId: "$_id",
                mobile: "$userInfo.phone",
                totalOrders: "$orderCount",
                avgOrderValue: 1,
                lastOrderDate: 1
            }
        },

        ...(searchRegex ? [{ $match: { mobile: searchRegex } }] : []),

        { $sort: { lastOrderDate: -1 } },

        {
            $facet: {
                data: [
                    { $skip: skip },
                    { $limit: limitNumber }
                ],
                totalCount: [{ $count: "count" }]
            }
        }
    ]);

    const userActivityData = userActivityResult[0]?.data || [];
    const totalCount = userActivityResult[0]?.totalCount[0]?.count || 0;
    const totalPages = Math.ceil(totalCount / limitNumber);

    // ================= FINAL RESPONSE =================
    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "User behavior analytics fetched successfully",
        data: {
            summary: {
                totalActiveUsers,
                avgOrderFrequency,
                avgCartValue
            },
            segments: segmentData,
            preferredCategories,

            userActivity: {
                data: userActivityData,
                pagination: {
                    totalCount,
                    currentPage: pageNumber,
                    totalPages,
                    limit: limitNumber
                }
            }
        }
    });

});

/**
 * 5. Most Searched Items Report API
 * Filters: timeRange, startDate, endDate, availability (All, Available, Unavailable)
 */

exports.getSearchReports = catchAsyncError(async (req, res) => {
    const {
        timeRange = "last30Days",
        startDate,
        endDate,
        availability = "All",
        searchTerm,
        sortBy = "searchCount",
        page = 1,
        limit = 10
    } = req.query;

    const isExport = isExportRequest(req);

    const pageNumber = Math.max(1, Number(page) || 1);
    const limitNumber = isExport ? 50000 : Math.max(1, Number(limit) || 10);
    const skip = isExport ? 0 : (pageNumber - 1) * limitNumber;

    const escapeRegex = (str) => String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    let matchCondition = {};
    const now = new Date();

    const normalizedTimeRange = String(timeRange).trim().toLowerCase();

    if (normalizedTimeRange === "last7days") {
        const d = new Date();
        d.setDate(now.getDate() - 7);
        matchCondition.createdAt = { $gte: d };
    } else if (normalizedTimeRange === "last30days") {
        const d = new Date();
        d.setDate(now.getDate() - 30);
        matchCondition.createdAt = { $gte: d };
    } else if (normalizedTimeRange === "last90days") {
        const d = new Date();
        d.setDate(now.getDate() - 90);
        matchCondition.createdAt = { $gte: d };
    } else if (normalizedTimeRange === "custom" && startDate && endDate) {
        matchCondition.createdAt = {
            $gte: new Date(startDate),
            $lte: new Date(endDate)
        };
    }

    const normalizedAvailability = String(availability).trim().toLowerCase();

    if (normalizedAvailability === "available") matchCondition.isProductAvailable = true;
    else if (normalizedAvailability === "unavailable") matchCondition.isProductAvailable = false;

    if (searchTerm && String(searchTerm).trim()) {
        matchCondition.query = {
            $regex: new RegExp(escapeRegex(String(searchTerm).trim()), "i")
        };
    }

    const normalizedSortBy = String(sortBy).trim().toLowerCase();

    const sortStage =
        normalizedSortBy === "lastsearched"
            ? { lastSearched: -1 }
            : normalizedSortBy === "availability"
                ? { isAvailable: -1, searchCount: -1, lastSearched: -1 }
                : { searchCount: -1 };

    // ✅ PAGINATED SEARCH TRENDS
    const searchTrendsResult = await SearchHistory.aggregate([
        { $match: matchCondition },

        {
            $group: {
                _id: "$query",
                searchCount: { $sum: 1 },
                lastSearched: { $max: "$createdAt" },
                isAvailable: { $first: "$isProductAvailable" }
            }
        },

        {
            $project: {
                query: "$_id",
                searchedTerm: "$_id",
                searchCount: 1,
                lastSearched: 1,
                isAvailable: 1
            }
        },

        { $sort: sortStage },

        // ✅ MAIN PAGINATION
        {
            $facet: {
                data: [
                    { $skip: skip },
                    { $limit: limitNumber }
                ],
                totalCount: [
                    { $count: "count" }
                ]
            }
        }
    ]);

    const trendsData = searchTrendsResult[0]?.data || [];
    const totalCount = searchTrendsResult[0]?.totalCount[0]?.count || 0;
    const totalPages = Math.ceil(totalCount / limitNumber);

    // ================= INSIGHTS =================
    const unavailableMatch = { ...matchCondition, isProductAvailable: false };

    const unavailableStats = await SearchHistory.aggregate([
        { $match: unavailableMatch },
        {
            $group: {
                _id: null,
                totalSearches: { $sum: 1 },
                uniqueQueries: { $addToSet: "$query" }
            }
        }
    ]);

    const stats = unavailableStats[0] || {
        totalSearches: 0,
        uniqueQueries: []
    };

    // ================= EXPORT =================
    if (isExport) {
        const workbook = createWorkbook();

        addSheet(workbook, {
            name: "Insights",
            columns: [
                { header: "Metric", key: "metric" },
                { header: "Value", key: "value" }
            ],
            rows: [
                { metric: "Most Searched Unavailable Items", value: stats.uniqueQueries.length },
                { metric: "Total Searches Unavailable", value: stats.totalSearches }
            ]
        });

        addSheet(workbook, {
            name: "Trends",
            columns: [
                { header: "Searched Term", key: "searchedTerm" },
                { header: "Number Of Searches", key: "searchCount" },
                { header: "Product Available", key: "isAvailable" },
                { header: "Last Searched", key: "lastSearched" }
            ],
            rows: trendsData
        });

        await sendWorkbook(res, workbook, {
            fileName: `search_trends_${new Date().toISOString().slice(0, 10)}.xlsx`
        });
        return;
    }

    // ================= FINAL RESPONSE =================
    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Search reports fetched successfully",
        data: {
            insights: {
                mostSearchedUnavailable: stats.uniqueQueries.length,
                totalSearchesUnavailable: stats.totalSearches,
            },

            trends: {
                data: trendsData,
                pagination: {
                    totalCount,
                    currentPage: pageNumber,
                    totalPages,
                    limit: limitNumber
                }
            }
        },
    });
});

/**
 * Admin Popular Picks API (variation-wise)
 * Filters: timeRange, startDate, endDate, categoryId, search, page, limit
 */
exports.getAdminPopularPicks = catchAsyncError(async (req, res) => {
    const { timeRange = "last30Days", startDate, endDate, categoryId, search, page = 1, limit = 10 } = req.query;
    const isExport = isExportRequest(req);

    const { currentStart, currentEnd, previousStart, previousEnd } = getTimeRanges({ timeRange, startDate, endDate });
    const pageNumber = Math.max(1, Number(page) || 1);
    const limitNumber = Math.max(1, Number(limit) || 10);
    const skip = (pageNumber - 1) * limitNumber;

    const categoryObjectId = categoryId ? new mongoose.Types.ObjectId(categoryId) : null;
    const searchRegex = search && String(search).trim() ? new RegExp(escapeRegex(String(search).trim()), "i") : null;

    const matchCondition = {
        status: "Delivered",
        createdAt: { $gte: currentStart, $lte: currentEnd }
    };

    const pipeline = [
        { $match: matchCondition },
        { $unwind: "$items" },
        { $match: { "items.variationId": { $ne: null } } },
        {
            $group: {
                _id: { productId: "$items.productId", variationId: "$items.variationId" },
                unitsSold: { $sum: "$items.quantity" },
                revenue: { $sum: "$items.subtotal" }
            }
        },
        {
            $lookup: {
                from: "products",
                localField: "_id.productId",
                foreignField: "_id",
                as: "productInfo"
            }
        },
        { $unwind: "$productInfo" },
        // ✅ PRODUCT SOFT DELETE FILTER
        {
            $match: {
                "productInfo.isDeleted": { $ne: true }
            }
        },
        ...(categoryObjectId ? [{ $match: { "productInfo.categoryId": categoryObjectId } }] : []),
        // {
        //     $addFields: {
        //         variationInfo: {
        //             $arrayElemAt: [
        //                 {
        //                     $filter: {
        //                         input: "$productInfo.productVariations",
        //                         as: "v",
        //                         cond: { $eq: ["$$v._id", "$_id.variationId"] }
        //                     }
        //                 },
        //                 0
        //             ]
        //         }
        //     }
        // },

        {
            $addFields: {
                variationInfo: {
                    $arrayElemAt: [
                        {
                            $filter: {
                                input: "$productInfo.productVariations",
                                as: "v",
                                cond: {
                                    $and: [
                                        { $eq: ["$$v._id", "$_id.variationId"] },
                                        { $ne: ["$$v.isDeleted", true] } // ✅ VARIATION FILTER
                                    ]
                                }
                            }
                        },
                        0
                    ]
                }
            }
        },
        { $match: { variationInfo: { $ne: null } } },
        {
            $lookup: {
                from: "categories",
                localField: "productInfo.categoryId",
                foreignField: "_id",
                as: "categoryInfo"
            }
        },
        { $unwind: { path: "$categoryInfo", preserveNullAndEmptyArrays: true } },
        {
            $addFields: {
                productNameWithMeasurement: {
                    $cond: [
                        {
                            $and: [
                                { $ne: ["$variationInfo.measurmentValue", null] },
                                { $ne: ["$variationInfo.measurmentUnit", null] }
                            ]
                        },
                        {
                            $concat: [
                                "$productInfo.productName",
                                " (",
                                { $toString: "$variationInfo.measurmentValue" },
                                " ",
                                "$variationInfo.measurmentUnit",
                                ")"
                            ]
                        },
                        "$productInfo.productName"
                    ]
                },
                productImage: { $arrayElemAt: ["$variationInfo.productImages", 0] }
            }
        },
        ...(searchRegex ? [{ $match: { productNameWithMeasurement: { $regex: searchRegex } } }] : []),
        {
            $project: {
                _id: 0,
                productId: "$_id.productId",
                variationId: "$_id.variationId",
                productName: "$productNameWithMeasurement",
                measurmentValue: "$variationInfo.measurmentValue",
                measurmentUnit: "$variationInfo.measurmentUnit",
                productImage: 1,
                categoryId: "$productInfo.categoryId",
                categoryName: "$categoryInfo.categoryName",
                price: "$variationInfo.sellingPrice",
                unitsSold: 1,
                revenue: 1,
                status: "$variationInfo.stockStatus"
            }
        },
        { $sort: { unitsSold: -1, revenue: -1 } },
        ...(isExport
            ? []
            : [
                {
                    $facet: {
                        items: [{ $skip: skip }, { $limit: limitNumber }],
                        total: [{ $count: "count" }]
                    }
                }
            ])
    ];

    const agg = await Order.aggregate(pipeline);

    const items = isExport ? agg : (agg[0]?.items || []);
    const totalItems = isExport ? items.length : (agg[0]?.total?.[0]?.count || 0);

    // Growth calculation (previous period) for returned page only
    const variationIds = items.map(i => i.variationId).filter(Boolean);
    let previousMap = {};
    if (variationIds.length > 0 && previousStart && previousEnd) {
        const prevAgg = await Order.aggregate([
            {
                $match: {
                    status: "Delivered",
                    createdAt: { $gte: previousStart, $lte: previousEnd }
                }
            },
            { $unwind: "$items" },
            { $match: { "items.variationId": { $in: variationIds } } },
            {
                $group: {
                    _id: "$items.variationId",
                    unitsSold: { $sum: "$items.quantity" },
                    revenue: { $sum: "$items.subtotal" }
                }
            }
        ]);

        previousMap = prevAgg.reduce((acc, r) => {
            acc[r._id.toString()] = { unitsSold: r.unitsSold || 0, revenue: r.revenue || 0 };
            return acc;
        }, {});
    }

    const withGrowth = items.map(i => {
        const prev = previousMap[i.variationId?.toString()] || { unitsSold: 0, revenue: 0 };
        const growthRevenue =
            prev.revenue === 0 ? (i.revenue > 0 ? 100 : 0) : Number((((i.revenue - prev.revenue) / prev.revenue) * 100).toFixed(1));
        const growthUnits =
            prev.unitsSold === 0 ? (i.unitsSold > 0 ? 100 : 0) : Number((((i.unitsSold - prev.unitsSold) / prev.unitsSold) * 100).toFixed(1));

        return {
            ...i,
            growthRevenuePercent: growthRevenue,
            growthUnitsPercent: growthUnits
        };
    });

    if (isExport) {
        const workbook = createWorkbook();

        addSheet(workbook, {
            name: "Popular Picks",
            columns: [
                { header: "Product Id", key: "productId" },
                { header: "Variation Id", key: "variationId" },
                { header: "Product Name", key: "productName" },
                { header: "Category", key: "categoryName" },
                { header: "Price", key: "price" },
                { header: "Units Sold", key: "unitsSold" },
                { header: "Revenue", key: "revenue" },
                { header: "Growth Revenue (%)", key: "growthRevenuePercent" },
                { header: "Growth Units (%)", key: "growthUnitsPercent" },
                { header: "Status", key: "status" },
                { header: "Image", key: "productImage" }
            ],
            rows: withGrowth || []
        });

        await sendWorkbook(res, workbook, {
            fileName: `admin_popular_picks_${new Date().toISOString().slice(0, 10)}.xlsx`
        });
        return;
    }

    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Admin popular picks fetched successfully",
        data: {
            pagination: {
                totalItems,
                currentPage: pageNumber,
                pageSize: limitNumber,
                totalPages: Math.ceil(totalItems / limitNumber)
            },
            items: withGrowth
        }
    });
});

/**
 * Admin Recently Purchased API (order items)
 * Filters: timeRange, startDate, endDate, categoryId, search, page, limit
 */
exports.getAdminRecentlyPurchased = catchAsyncError(async (req, res) => {
    const { timeRange = "last30Days", startDate, endDate, categoryId, search, page = 1, limit = 10 } = req.query;
    const isExport = isExportRequest(req);

    const { currentStart, currentEnd } = getTimeRanges({ timeRange, startDate, endDate });
    const pageNumber = Math.max(1, Number(page) || 1);
    const limitNumber = Math.max(1, Number(limit) || 10);
    const skip = (pageNumber - 1) * limitNumber;

    const categoryObjectId = categoryId ? new mongoose.Types.ObjectId(categoryId) : null;
    const searchRegex = search && String(search).trim() ? new RegExp(escapeRegex(String(search).trim()), "i") : null;

    const matchCondition = {
        createdAt: { $gte: currentStart, $lte: currentEnd }
    };

    const pipeline = [
        { $match: matchCondition },
        { $unwind: "$items" },
        { $match: { "items.variationId": { $ne: null } } },
        {
            $lookup: {
                from: "products",
                localField: "items.productId",
                foreignField: "_id",
                as: "productInfo"
            }
        },
        { $unwind: "$productInfo" },
         {
            $match: {
                "productInfo.isDeleted": { $ne: true }
            }
        },
        ...(categoryObjectId ? [{ $match: { "productInfo.categoryId": categoryObjectId } }] : []),
        // {
        //     $addFields: {
        //         variationInfo: {
        //             $arrayElemAt: [
        //                 {
        //                     $filter: {
        //                         input: "$productInfo.productVariations",
        //                         as: "v",
        //                         cond: { $eq: ["$$v._id", "$items.variationId"] }
        //                     }
        //                 },
        //                 0
        //             ]
        //         }
        //     }
        // },
         {
            $addFields: {
                variationInfo: {
                    $arrayElemAt: [
                        {
                            $filter: {
                                input: "$productInfo.productVariations",
                                as: "v",
                                cond: {
                                    $and: [
                                        { $eq: ["$$v._id", "$items.variationId"] },
                                        { $ne: ["$$v.isDeleted", true] } // ✅ VARIATION FILTER
                                    ]
                                }
                            }
                        },
                        0
                    ]
                }
            }
        },
        { $match: { variationInfo: { $ne: null } } },
        {
            $lookup: {
                from: "categories",
                localField: "productInfo.categoryId",
                foreignField: "_id",
                as: "categoryInfo"
            }
        },
        { $unwind: { path: "$categoryInfo", preserveNullAndEmptyArrays: true } },
        {
            $lookup: {
                from: "users",
                localField: "userId",
                foreignField: "_id",
                as: "userInfo"
            }
        },
        { $unwind: { path: "$userInfo", preserveNullAndEmptyArrays: true } },
        {
            $addFields: {
                productNameWithMeasurement: {
                    $cond: [
                        {
                            $and: [
                                { $ne: ["$variationInfo.measurmentValue", null] },
                                { $ne: ["$variationInfo.measurmentUnit", null] }
                            ]
                        },
                        {
                            $concat: [
                                "$productInfo.productName",
                                " (",
                                { $toString: "$variationInfo.measurmentValue" },
                                " ",
                                "$variationInfo.measurmentUnit",
                                ")"
                            ]
                        },
                        "$productInfo.productName"
                    ]
                },
                productImage: { $arrayElemAt: ["$variationInfo.productImages", 0] }
            }
        },
        ...(searchRegex ? [{
            $match: {
                $or: [
                    { productNameWithMeasurement: { $regex: searchRegex } },
                    { "userInfo.phone": { $regex: searchRegex } },
                    { orderId: { $regex: searchRegex } }
                ]
            }
        }] : []),
        {
            $project: {
                _id: 0,
                purchaseDate: "$createdAt",
                orderNumber: "$orderId",
                orderStatus: "$status",
                userMobile: "$userInfo.phone",
                productId: "$items.productId",
                variationId: "$items.variationId",
                productName: "$productNameWithMeasurement",
                measurmentValue: "$variationInfo.measurmentValue",
                measurmentUnit: "$variationInfo.measurmentUnit",
                productImage: 1,
                categoryId: "$productInfo.categoryId",
                categoryName: "$categoryInfo.categoryName",
                price: "$variationInfo.sellingPrice",
                quantity: "$items.quantity",
                amount: "$items.subtotal"
            }
        },
        { $sort: { purchaseDate: -1 } },
        ...(isExport
            ? []
            : [
                {
                    $facet: {
                        items: [{ $skip: skip }, { $limit: limitNumber }],
                        total: [{ $count: "count" }]
                    }
                }
            ])
    ];

    const agg = await Order.aggregate(pipeline);

    const items = isExport ? agg : (agg[0]?.items || []);
    const totalItems = isExport ? items.length : (agg[0]?.total?.[0]?.count || 0);

    if (isExport) {
        const workbook = createWorkbook();

        addSheet(workbook, {
            name: "Recently Purchased",
            columns: [
                { header: "Purchase Date", key: "purchaseDate" },
                { header: "Order Number", key: "orderNumber" },
                { header: "Order Status", key: "orderStatus" },
                { header: "User Mobile", key: "userMobile" },
                { header: "Product Id", key: "productId" },
                { header: "Variation Id", key: "variationId" },
                { header: "Product Name", key: "productName" },
                { header: "Category", key: "categoryName" },
                { header: "Price", key: "price" },
                { header: "Quantity", key: "quantity" },
                { header: "Amount", key: "amount" },
                { header: "Image", key: "productImage" }
            ],
            rows: (items || []).map((i) => ({
                ...i,
                purchaseDate: i?.purchaseDate ? new Date(i.purchaseDate) : ""
            }))
        });

        await sendWorkbook(res, workbook, {
            fileName: `admin_recently_purchased_${new Date().toISOString().slice(0, 10)}.xlsx`
        });
        return;
    }

    return responseHandler({
        res,
        code: statusCode.SUCCESS,
        message: "Admin recently purchased fetched successfully",
        data: {
            pagination: {
                totalItems,
                currentPage: pageNumber,
                pageSize: limitNumber,
                totalPages: Math.ceil(totalItems / limitNumber)
            },
            items
        }
    });
});
