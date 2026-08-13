const express = require('express');
const driverController = require('../controllers/driver/driverController');
const staticContentController = require("../controllers/admin/staticContentController")
const { driverAuth } = require("../middleware/driverAuth");
const router = express.Router();


router.post("/sendOtp", driverController.sendOtp);
router.post("/driverLogin", driverController.driverLogin);
router.get("/getStaticContent", staticContentController.getStaticContent);
router.post("/getStaticContent", staticContentController.getStaticContent);

router.use(driverAuth);
router.get("/getDriverProfile", driverController.getDriverProfile);
router.post("/driverLogout", driverController.driverLogout);
router.put("/updateDriverProfile", driverController.updateDriverProfile);
router.delete("/deleteDriverAccount", driverController.deleteDriverAccount);
router.get("/getDriverOrdersByStatus", driverController.getDriverOrdersByStatus);
router.put("/updateOrderStatusByDriver", driverController.updateOrderStatusByDriver);
router.put("/updateDriverLocation", driverController.updateDriverLocation);
router.get("/getHomeOverview", driverController.getHomeOverview);
router.post("/cancelOrderByDriver", driverController.cancelOrderByDriver);
router.post("/returnSelectedItemsByDriver", driverController.returnSelectedItemsByDriver);
router.get("/getOrderDetails", driverController.getOrderDetails);
router.get("/getNotificationHistory", driverController.getNotificationHistory);
router.get("/getDriverUnreadNotificationCount", driverController.getDriverUnreadNotificationCount);

module.exports = router;
