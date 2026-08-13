const express = require('express');
const adminController = require('../controllers/admin/adminController');
const categoryController = require('../controllers/admin/categoryController');
const deliveryZoneController = require("../controllers/admin/deliveryZoneController")
const deliveryConfigController = require("../controllers/admin/deliveryConfigController")
const freeItemController = require("../controllers/admin/freeItemController")
const freeItemRuleController = require("../controllers/admin/freeItemRuleController")
const driverMgmtController = require("../controllers/admin/driverMgmtController")
const deliverySlotsController = require("../controllers/admin/deliverySlotsController")
const staticContentController = require("../controllers/admin/staticContentController")
const bannerController = require("../controllers/admin/bannerController")
const orderManagementController = require("../controllers/admin/orderManagementController")
const productController = require("../controllers/admin/productController")
const userMgmtController = require("../controllers/admin/userMgmtController")
const storedClosureController = require("../controllers/admin/storedClosureController")
const couponController = require("../controllers/admin/promotionsAndCouponsController")
const issueController = require("../controllers/admin/issueController")
const supportTicketController = require("../controllers/admin/supportTicketController")
const dashboardController = require("../controllers/admin/dashboardController")
const homeHeadingController = require("../controllers/admin/homeHeadingController")
const notificationController = require("../controllers/admin/notificationController")
const reportController = require("../controllers/admin/reportController");
const invoiceController = require("../controllers/admin/invoiceController");
const warehouseController = require("../controllers/admin/warehouseController");
const { adminAuth } = require("../middleware/adminAuth");
const router = express.Router();

router.post("/adminLogin", adminController.adminLogin);
router.post("/forgotPassword", adminController.forgotPassword);
router.post("/resetPassword", adminController.resetPassword);
router.post("/adminLogout", adminAuth, adminController.adminLogout);
router.put("/changePassword", adminAuth, adminController.changePassword);
router.put("/updateAdminProfile", adminAuth, adminController.updateAdminProfile);
router.get("/getAdminProfileDetails", adminAuth, adminController.getAdminProfileDetails);

// Category Routes
router.post('/categories/createCategory', adminAuth, categoryController.createCategory);
router.post('/categories/reorderCategories', adminAuth, categoryController.reorderCategories);
router.get('/categories/getAllCategories', adminAuth, categoryController.getAllCategories);
router.put('/categories/updateCategory/:categoryId', adminAuth, categoryController.updateCategory);
router.delete('/categories/deleteCategory/:categoryId', adminAuth, categoryController.deleteCategory);

// SubCategory Routes
router.post('/categories/reorderSubCategories', adminAuth, categoryController.reorderSubCategories);
router.put('/categories/updateSubCategory/:categoryId/:subCategoryId', adminAuth, categoryController.updateSubCategory);
router.delete('/categories/deleteSubCategory/:categoryId/:subCategoryId', adminAuth, categoryController.deleteSubCategory);

// static content Management
router.get("/getStaticContent", adminAuth, staticContentController.getStaticContent);
router.get("/getStaticContentByRole", adminAuth, staticContentController.getStaticContentByRole);
router.put("/editStaticContent", adminAuth, staticContentController.editStaticContent);

// banner management
router.post('/createBanner', adminAuth, bannerController.createBanner);
router.get('/getBanners', adminAuth, bannerController.getBanners);
router.put('/editBanner/:bannerId', adminAuth, bannerController.editBanner);
router.post('/deleteBanner/:bannerId', adminAuth, bannerController.deleteBanner);
router.post('/createFestival', adminAuth, bannerController.createFestival);
router.get('/getFestivals', adminAuth, bannerController.getFestivals);

// Product Management
router.post('/products/createProduct', adminAuth, productController.createProduct);
router.get('/products/getAllProductVariations', adminAuth, productController.getAllProductVariations);
router.get('/products/getProductById', adminAuth, productController.getProductById);
router.get('/products/getAllLowStockProductVariations', adminAuth, productController.getAllLowStockProductVariations)
router.get('/products/getProductVariationById', adminAuth, productController.getProductVariationById);
router.put('/products/updateProductAndVariations', adminAuth, productController.updateProductAndVariations);
router.delete('/products/deleteProductVariation', adminAuth, productController.deleteProductVariation);
router.put('/products/restockparticularvariation', adminAuth, productController.restockparticularvariation);

// User Management Add User 

router.post('/addUserByAdmin', adminAuth, userMgmtController.addUserByAdmin);
router.put("/updateUserStatus/:userId", adminAuth, userMgmtController.updateUserStatus);
router.get("/getActiveBlockedUsers", adminAuth, userMgmtController.getActiveBlockedUsers);
router.put('/editUserByAdmin', adminAuth, userMgmtController.editUserByAdmin);
router.post('/softDeleteUserByAdmin', adminAuth, userMgmtController.softDeleteUserByAdmin);
router.get('/viewUserByAdmin', adminAuth, userMgmtController.viewUserByAdmin);


// driver management api
router.post('/createDriver', adminAuth, driverMgmtController.createDriver);
router.get('/getAllDrivers', adminAuth, driverMgmtController.getAllDrivers);
router.get('/getDriverById', adminAuth, driverMgmtController.getDriverById);
router.get('/getDriverEarnings', adminAuth, driverMgmtController.getDriverEarnings);
router.put('/updateDriver', adminAuth, driverMgmtController.updateDriver);
router.post('/deleteDriver', adminAuth, driverMgmtController.deleteDriver);
router.get('/getDriverPerformance', adminAuth, driverMgmtController.getDriverPerformance);

//deliverySlots api
// router.post('/createSpecialDeliverySlot', adminAuth, deliverySlotsController.createSpecialDeliverySlot);
// router.get('/getAllSpecialDeliverySlot', adminAuth, deliverySlotsController.getAllSpecialDeliverySlot);
// router.get('/getSpecialDeliverySlotById', adminAuth, deliverySlotsController.getSpecialDeliverySlotById);
router.get('/getallDeliverySlot', adminAuth, deliverySlotsController.getallDeliverySlot);
// router.put('/updateSpecialDeliverySlot', adminAuth, deliverySlotsController.updateSpecialDeliverySlot);
router.put('/updateDefaultDeliverySlots', adminAuth, deliverySlotsController.updateDefaultDeliverySlots);
// router.delete('/deleteDeliverySlot', adminAuth, deliverySlotsController.deleteDeliverySlot);

// order management api
router.get('/getAllOrdersForAdmin', adminAuth, orderManagementController.getAllOrdersForAdmin);
router.put('/updateOrderStatus', adminAuth, orderManagementController.updateOrderStatus);
router.post('/generateLabel', adminAuth, orderManagementController.generateLabel);
router.post('/assignDriverToOrder', adminAuth, orderManagementController.assignDriverToOrder);
router.get('/getOrderDetailsById', adminAuth, orderManagementController.getOrderDetailsById);
router.get('/downloadInvoice', adminAuth, invoiceController.downloadInvoice);

// stored closure apis
router.post('/createClosure', adminAuth, storedClosureController.createClosure);
router.get('/getAllClosures', adminAuth, storedClosureController.getAllClosures);
router.delete('/deleteClosure', adminAuth, storedClosureController.deleteClosure);

// deliveryZone api
router.post('/createZone', adminAuth, deliveryZoneController.createZone);
router.get('/getAllZones', adminAuth, deliveryZoneController.getAllZones);
router.get('/getAssignmentRules', adminAuth, deliveryZoneController.getAssignmentRules);
router.get('/getZoneById', adminAuth, deliveryZoneController.getZoneById);
router.put('/updateZone', adminAuth, deliveryZoneController.updateZone);
router.post('/deleteZone', adminAuth, deliveryZoneController.deleteZone);
router.put('/updateMultipleDriverAvailability', adminAuth, deliveryZoneController.updateMultipleDriverAvailability);

// free item api
router.post('/addFreeItem', adminAuth, freeItemController.addFreeItem);
router.get('/getAllFreeItem', adminAuth, freeItemController.getAllFreeItem);
router.delete('/deleteFreeItem', adminAuth, freeItemController.deleteFreeItem);


// free item rule api
router.post('/createFreeItemRule', adminAuth, freeItemRuleController.createFreeItemRule);
router.get('/getAllFreeItemRules', adminAuth, freeItemRuleController.getAllFreeItemRules);
router.get('/getFreeItemRuleById', adminAuth, freeItemRuleController.getFreeItemRuleById);
router.put('/updateFreeItemRule', adminAuth, freeItemRuleController.updateFreeItemRule);
router.post('/deleteFreeItemRule', adminAuth, freeItemRuleController.deleteFreeItemRule);

// deliveryConfig apis
router.post('/saveDeliveryConfig', adminAuth, deliveryConfigController.saveDeliveryConfig);
router.get('/getDeliveryConfigByZone', adminAuth, deliveryConfigController.getDeliveryConfigByZone);
router.post('/deleteConfig', adminAuth, deliveryConfigController.deleteConfig);

// promotions and coupons routes
router.post('/createCoupon', adminAuth, couponController.createCoupon);
router.get('/getAllCoupons', adminAuth, couponController.getAllCoupons);
router.get('/getCouponById', adminAuth, couponController.getCouponById);
router.put('/updateCouponById', adminAuth, couponController.updateCouponById);
router.delete('/deleteCouponById', adminAuth, couponController.deleteCouponById);

// support ticket apis  
router.get('/getAllTickets', adminAuth, supportTicketController.getAllTickets);
router.put('/updateTicketStatus', adminAuth, supportTicketController.updateTicketStatus);
router.get('/ticketStats', adminAuth, supportTicketController.ticketStats);


// issue apis
router.post('/createIssue', adminAuth, issueController.createIssue);
router.get('/getAllIssues', adminAuth, issueController.getAllIssues);
router.put('/updateIssue', adminAuth, issueController.updateIssue);
router.delete('/deleteIssue', adminAuth, issueController.deleteIssue);

// home heading apis
router.post('/createHomeHeading', adminAuth, homeHeadingController.createHomeHeading);
router.get('/getAllHomeHeading', adminAuth, homeHeadingController.getAllHomeHeading);
router.put('/updateHomeHeading', adminAuth, homeHeadingController.updateHomeHeading);
router.delete('/deleteHomeHeading', adminAuth, homeHeadingController.deleteHomeHeading);
router.get('/getAllProducts', adminAuth, homeHeadingController.getAllProducts);
router.get('/getHomeHeadingById', adminAuth, homeHeadingController.getHomeHeadingById);

// notification apis
router.post('/sendAndScheduleNotificationfromAdmin', adminAuth, notificationController.sendAndScheduleNotificationfromAdmin);
router.get('/getAllNotifications', adminAuth, notificationController.getAllNotifications);
router.get('/getNotificationById', adminAuth, notificationController.getNotificationById);
router.get('/getAdminNotifications', adminAuth, notificationController.getAdminNotifications);
router.get('/getAdminUnreadNotificationCount', adminAuth, notificationController.getAdminUnreadNotificationCount);

// dashboard api
router.get('/getDashboard', adminAuth, dashboardController.getDashboard);

// report apis
router.get("/getSalesReport", adminAuth, reportController.getSalesReport);
router.get("/getPincodeAnalytics", adminAuth, reportController.getPincodeAnalytics);
router.get("/getProductPopularity", adminAuth, reportController.getProductPopularity);
router.get("/getUserBehavior", adminAuth, reportController.getUserBehavior);
router.get("/getSearchReports", adminAuth, reportController.getSearchReports);
router.get("/getAdminPopularPicks", adminAuth, reportController.getAdminPopularPicks);
router.get("/getAdminRecentlyPurchased", adminAuth, reportController.getAdminRecentlyPurchased);

// warehouse management apis
router.post('/warehouse/create', adminAuth, warehouseController.createWarehouse);
router.get('/warehouse/getAll', adminAuth, warehouseController.getAllWarehouses);
router.put('/warehouse/update/:warehouseId', adminAuth, warehouseController.updateWarehouse);
router.delete('/warehouse/delete/:warehouseId', adminAuth, warehouseController.deleteWarehouse);
router.patch('/warehouse/setDefault/:warehouseId', adminAuth, warehouseController.setDefaultWarehouse);

module.exports = router;
