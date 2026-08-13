const express = require('express');
const router = express.Router();
const homeController = require("../controllers/user/homeController")
const supportTicketController = require("../controllers/user/supportTicketController")
const issueController = require("../controllers/admin/issueController")
const productController = require("../controllers/admin/productController");
const usercontrollers = require("../controllers/user/userController");
const staticContentController = require("../controllers/admin/staticContentController")
const promotionsAndCouponController = require("../controllers/admin/promotionsAndCouponsController")
const bannerController = require("../controllers/admin/bannerController")
const { userAuth } = require("../middleware/userAuth");
const { optionalAuth } = require("../middleware/optionalAuth");
const productsPayment = require("../controllers/user/productsPayment");
const invoiceController = require("../controllers/user/invoiceController");


router.post('/sendOtp', usercontrollers.sendOtp);
router.post('/Login', usercontrollers.Login);
router.post('/mergeGuestCart', userAuth, usercontrollers.mergeGuestCart);
router.post('/addAddress', userAuth, usercontrollers.addAddress);
router.post("/logout", userAuth, usercontrollers.logout);
router.post("/deleteAccount", userAuth, usercontrollers.deleteAccount);
router.get("/getProfile", userAuth, usercontrollers.getProfile);
router.get("/getAllAddress", userAuth, usercontrollers.getAllAddress);
router.put("/selectAddress", userAuth, usercontrollers.selectAddress);
router.put("/editAddress", userAuth, usercontrollers.editAddress);
router.delete("/deleteAddress", userAuth, usercontrollers.deleteAddress);
router.put("/setDefaultAddress", userAuth, usercontrollers.setDefaultAddress);
router.get("/getSubcategoriesByCategory", usercontrollers.getSubcategoriesByCategory);
router.get("/getProductsByCategoryAndSubcategory", usercontrollers.getProductsByCategoryAndSubcategory);
router.get("/Home", optionalAuth, homeController.Home);
router.get("/seeAllBuyAgain", userAuth, homeController.seeAllBuyAgain);
router.get("/seeAllPopularPicks", homeController.seeAllPopularPicks);
router.get("/viewParticularHeading", homeController.viewParticularHeading);
router.put("/updateUserImage", userAuth, usercontrollers.updateUserImage);
router.get("/products/getProductById", productController.getProductById);
router.get("/getCategoriesWithSubcategoriesAndProducts", usercontrollers.getCategoriesWithSubcategoriesAndProducts);
router.post("/getStaticContent", staticContentController.getStaticContent);
router.post("/addToCart", userAuth, usercontrollers.addToCart);
router.post("/removeFromCart", userAuth, usercontrollers.removeFromCart);
router.get("/getCart", userAuth, usercontrollers.getCart);
router.post("/guest/getCart", usercontrollers.guestGetCart);
router.post("/placeorder", userAuth, usercontrollers.placeorder);
router.post("/redeemCoupon", userAuth, usercontrollers.redeemCoupon);
router.post("/removeCouponFromCart", userAuth, usercontrollers.removeCouponFromCart);
router.get("/getUserOrders", userAuth, usercontrollers.getUserOrders);
router.get("/getOrderDetails", userAuth, usercontrollers.getOrderDetails);
router.post("/rateOrderAndDriver", userAuth, usercontrollers.rateOrderAndDriver);
router.get("/getAllCoupons", userAuth, usercontrollers.getAllCoupons);
router.patch("/cancelOrder", userAuth, usercontrollers.cancelOrder)
router.get('/getBannerProducts', usercontrollers.getBannerProducts);
router.post("/reorderFromHistory", userAuth, usercontrollers.reorderFromHistory);
router.get("/searchProducts", usercontrollers.searchProducts);
// router.get("/searchFilters",usercontrollers.searchFilters);
router.post("/raiseTicket", userAuth, supportTicketController.raiseTicket);
router.post("/raiseTicketByOrderId", userAuth, supportTicketController.raiseTicketByOrderId);
router.get("/getUserTickets", userAuth, supportTicketController.getUserTickets);
router.get("/getAllIssues", userAuth, issueController.getAllIssues);
router.get("/getNotificationPreferences", userAuth, usercontrollers.getNotificationPreferences);
router.put("/updateNotificationPreferences", userAuth, usercontrollers.updateNotificationPreferences);
router.get("/getNotificationHistory", userAuth, usercontrollers.getNotificationHistory);
router.get("/getUserUnreadNotificationCount", userAuth, usercontrollers.getUserUnreadNotificationCount);
router.post("/payment/createOrder", userAuth, productsPayment.createOrder);
router.post("/payment/verifyOrder", userAuth, productsPayment.verifyOrder);
router.get("/downloadInvoice", userAuth, invoiceController.downloadInvoice);


module.exports = router;