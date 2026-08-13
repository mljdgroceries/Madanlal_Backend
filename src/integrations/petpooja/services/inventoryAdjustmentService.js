const BaseService = require('./baseService');
const ENDPOINTS = require('../constants/endpoints');

class InventoryAdjustmentService extends BaseService {
  constructor() {
    super(ENDPOINTS.INVENTORY_ADJUSTMENTS.BASE);
  }

  async initVoucher() {
    try {
      const response = await this.client.get(ENDPOINTS.SALES_ORDERS.INIT + '?voucher_type=inventoryAdjustment');
      const data = response.data;
      if (data && data.voucherAutoSeries && data.voucherAutoSeries.length > 0) {
        return data.voucherAutoSeries[0];
      }
      return null;
    } catch (error) {
      console.error('Petpooja Inventory Adjustment Voucher Init Error:', error?.response?.data || error.message);
      return null;
    }
  }

  async syncItemStock({ petpoojaItemId, previousQuantity, quantity, product, variation, reason = 'Admin stock update' }) {
    if (!petpoojaItemId) {
      throw new Error('Missing Petpooja item ID for inventory adjustment');
    }

    const qty = Number(quantity);
    if (!Number.isFinite(qty) || qty < 0) {
      throw new Error('Invalid stock quantity for inventory adjustment');
    }

    const previousQty = Number(previousQuantity) || 0;
    const deltaQty = Number((qty - previousQty).toFixed(3));
    if (deltaQty === 0) {
      console.log(`[PETPOOJA] Inventory adjustment skipped for item ${petpoojaItemId}; quantity unchanged.`);
      return null;
    }

    const voucherSeriesObj = await this.initVoucher();
    const itemId = Number(petpoojaItemId);
    const sku = variation?.sku || '';
    const rate = Number(variation?.sellingPrice || variation?.mrp || 0);
    const adjustmentType = deltaQty > 0 ? 'increase' : 'decrease';
    const adjustmentQty = Math.abs(deltaQty);

    const lineItem = {
      itemId,
      item_id: itemId,
      productType: 'goods',
      product_type: 'goods',
      unitId: 28,
      unit_id: 28,
      quantity: adjustmentQty,
      stockQuantity: qty,
      stock_quantity: qty,
      adjustedQuantity: adjustmentQty,
      adjusted_quantity: adjustmentQty,
      adjustmentType,
      adjustment_type: adjustmentType,
      rate,
      itemCode: sku,
      item_code: sku,
      itemName: product?.productName || sku,
      item_name: product?.productName || sku,
    };

    const payload = {
      date: new Date().toISOString().split('T')[0],
      isAutoNumber: true,
      is_auto_number: true,
      reason,
      notes: reason,
      status: 'adjusted',
      paymentStatus: 'paid',
      payment_status: 'paid',
      adjustmentType,
      adjustment_type: adjustmentType,
      quantity: adjustmentQty,
      adjustedQuantity: adjustmentQty,
      adjusted_quantity: adjustmentQty,
      voucherAutoSeriesId: voucherSeriesObj ? Number(voucherSeriesObj.id) : null,
      voucher_auto_series_id: voucherSeriesObj ? Number(voucherSeriesObj.id) : null,
      lineItems: [lineItem],
      line_items: [lineItem],
    };

    console.log('[PETPOOJA] ===== CREATE INVENTORY ADJUSTMENT =====');
    console.log('[PETPOOJA] Inventory adjustment payload:', JSON.stringify(payload, null, 2));
    const response = await this.post('', payload);
    console.log('[PETPOOJA] Inventory adjustment response:', JSON.stringify(response.data, null, 2));
    return response.data;
  }
}

module.exports = new InventoryAdjustmentService();
