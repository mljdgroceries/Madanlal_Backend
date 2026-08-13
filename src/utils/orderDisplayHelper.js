const { calcInclusiveFeeTax } = require("../integrations/petpooja/constants/taxMapping");

const appendDeliveryReturnBreakdown = (order) => {
  const deliveredItemsDetails = (order.items || []).map((item) => ({
    ...item,
    deliveredQty: Number(item.quantity) || 0,
    returnedQty: 0,
  }));

  const returnedItemsDetails = (order.returnedItemsDetails || []).map((item) => ({
    ...item,
    returnedQty: Number(item.quantity) || 0,
    deliveredQty: 0,
  }));

  const deliveredItemsCount = deliveredItemsDetails.reduce(
    (sum, item) => sum + (Number(item.deliveredQty) || 0),
    0,
  );
  const returnedItemsCount = returnedItemsDetails.reduce(
    (sum, item) => sum + (Number(item.returnedQty) || 0),
    0,
  );

  return {
    ...order,
    deliveredItemsDetails,
    returnedItemsDetails,
    deliveredItemsCount,
    returnedItemsCount,
  };
};

const buildFeeTaxBreakdown = (deliveryCharge = 0, platformFee = 0, gstPercent = 18) => {
  const delivery = calcInclusiveFeeTax(deliveryCharge, gstPercent);
  const platform = calcInclusiveFeeTax(platformFee, gstPercent);
  const totalFeeTax = Number((delivery.tax + platform.tax).toFixed(2));
  const feeCgst = Number((totalFeeTax / 2).toFixed(2));
  const feeSgst = Number((totalFeeTax - feeCgst).toFixed(2));

  return {
    deliveryChargeInclusive: Number(deliveryCharge) || 0,
    platformFeeInclusive: Number(platformFee) || 0,
    deliveryChargeExcludingTax: delivery.net,
    platformFeeExcludingTax: platform.net,
    deliveryChargeTax: delivery.tax,
    platformFeeTax: platform.tax,
    feeCgst,
    feeSgst,
    totalFeeTax,
  };
};

module.exports = {
  appendDeliveryReturnBreakdown,
  buildFeeTaxBreakdown,
};
