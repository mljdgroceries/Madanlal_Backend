const BaseService = require('./baseService');
const ENDPOINTS = require('../constants/endpoints');
const { getPetpoojaTaxGroupId, getPetpoojaIntraComponentTaxIds } = require('../constants/taxMapping');

class SalesOrderService extends BaseService {
  constructor() {
    super(ENDPOINTS.SALES_ORDERS.BASE);
  }

  /**
   * Initializes a voucher and returns its details (e.g., voucherAutoSeriesId).
   */
  async initVoucher() {
    try {
      const response = await this.client.get(ENDPOINTS.SALES_ORDERS.INIT + '?voucher_type=salesOrder');
      const data = response.data;
      if (data && data.voucherAutoSeries && data.voucherAutoSeries.length > 0) {
        return data.voucherAutoSeries[0];
      }
      return null;
    } catch (error) {
      console.error('Petpooja Voucher Init Error:', error?.response?.data || error.message);
      return null;
    }
  }

  async initTemplate() {
    try {
      const response = await this.client.get(ENDPOINTS.SALES_ORDERS.INIT + '?voucher_type=salesOrder');
      const data = response.data;
      if (data && data.templates && data.templates.length > 0) {
        return data.templates[0];
      }
      return null;
    } catch (error) {
      console.error('Petpooja Voucher Init Error:', error?.response?.data || error.message);
      return null;
    }
  }

  /**
   * Fetches the custom charge ID for delivery and platform fees.
   */
  async getCustomCharge() {
    try {
      const response = await this.client.get(ENDPOINTS.SALES_ORDERS.CUSTOM_CHARGES);
      const data = response.data?.data || [];
      const charge =
        data.find(c => c.name === 'Delivery Charges') ||
        data.find(c => c.name === 'Delivery and Platform Fee') ||
        data[0];
      return charge;
    } catch (error) {
      console.error('Petpooja Custom Charges Fetch Error:', error?.response?.data || error.message);
      return null;
    }
  }

  async _buildSalesOrderPayload(order, user, targetStatus = 'sent') {
    await require('./partyService').resolveOrderShippingAddress(user, order);
    const Product = require('../../../models/productModel');
    const itemService = require('./itemService');

    // Fetch dynamic IDs
    const voucherSeries = await this.initVoucher();
    const template = await this.initTemplate();
    const customChargeSetting = await this.getCustomCharge();

    let totalTaxAcc = 0;
    let totalTaxableAcc = 0;

    const lineItems = [];
    console.log('order', order);
    for (const item of order.items) {
      let petpoojaItemId = item.petpoojaItemId;
      let unitId = 28; // Hardcode to 28 (Pieces)
      let variation = null;

      const product = await Product.findById(item.productId);
      if (product) {
        variation = product.productVariations.find(
          v => v._id.toString() === item.variationId.toString()
        );
        if (variation) {
          // Self-healing: Resolve missing petpoojaItemId
          if (!petpoojaItemId) {
            if (variation.petpoojaItemId) {
              petpoojaItemId = variation.petpoojaItemId;
            } else {
              console.warn(`[PETPOOJA] Missing item ID for ${variation.sku}; skipping auto item creation during Sales Order to avoid stock changes.`);
            }
          }
          if (!petpoojaItemId) {
            console.error(`[PETPOOJA] Unable to resolve Petpooja item ID for variation ${variation.sku}`);
            throw new Error('Missing Petpooja item ID for item');
          }
          if (petpoojaItemId && item.petpoojaItemId !== petpoojaItemId) {
            item.petpoojaItemId = petpoojaItemId;
            await order.save();
            console.log(`[PETPOOJA] Saved healed petpoojaItemId ${petpoojaItemId} to order items`);
          }
        }
      }

      const parsedItemId = Number(petpoojaItemId);

      const rate = Number(item.priceWithGST || 0);
      const qty = Number(item.quantity || 0);
      // Use the GST snapshot saved with the order first. This keeps Petpooja
      // aligned with the customer/admin invoice even if the product changes later.
      let gstFrom = null;
      if (typeof item.gstPercent === 'number') {
        gstFrom = item.gstPercent;
      } else if (variation && typeof variation.gst === 'number') {
        gstFrom = variation.gst;
      } else if (product && typeof product.gst === 'number') {
        gstFrom = product.gst;
      } else {
        gstFrom = 0; // default no tax
      }
      const gstPercent = Number(gstFrom);
      const componentTaxIds = getPetpoojaIntraComponentTaxIds(gstPercent);

      // Reverse tax calculation
      const taxableAmountPerItem = rate / (1 + (gstPercent / 100));
      const totalTaxableAmount = Number((taxableAmountPerItem * qty).toFixed(2));
      const totalTaxForItem = Number(((rate * qty) - totalTaxableAmount).toFixed(2));

      totalTaxAcc += totalTaxForItem;
      totalTaxableAcc += totalTaxableAmount;

      const cgstAmount = Number((totalTaxForItem / 2).toFixed(2));
      const sgstAmount = Number((totalTaxForItem / 2).toFixed(2));

      lineItems.push({
        itemId: parsedItemId || null,
        unitId: unitId,
        productType: 'goods',
        quantity: qty,
        rate: rate,
        taxableAmount: totalTaxableAmount,
        taxTreatment: 'taxable',
        taxGroup: {
          // Map GST percent to Petpooja tax group ID (intra)
          id: getPetpoojaTaxGroupId(gstPercent),
          name: `GST ${gstPercent}%`,
          taxSpecification: 'intra',
          taxes: [
            {
              id: componentTaxIds.cgst,
              name: `CGST ${gstPercent / 2}%`,
              rate: Number((gstPercent / 2).toFixed(2)),
              taxType: 'cgst',
              taxAmount: cgstAmount
            },
            {
              id: componentTaxIds.sgst,
              name: `SGST ${gstPercent / 2}%`,
              rate: Number((gstPercent / 2).toFixed(2)),
              taxType: 'sgst',
              taxAmount: sgstAmount
            }
          ]
        }
      });
    }

    // Custom charges: delivery + platform fee @ 18% GST (Petpooja invoice format)
    const customCharges = [];
    const totalFee = Number(((order.deliveryCharge || 0) + (order.platformFee || 0)).toFixed(2));
    if (totalFee > 0 && customChargeSetting) {
      const feeGstPercent = 18;
      const halfRate = feeGstPercent / 2;
      const feeTaxableAmount = Number((totalFee / (1 + feeGstPercent / 100)).toFixed(2));
      const feeTaxAmount = Number((totalFee - feeTaxableAmount).toFixed(2));
      const cgstAmount = Number((feeTaxAmount / 2).toFixed(2));
      const sgstAmount = Number((feeTaxAmount - cgstAmount).toFixed(2));

      totalTaxableAcc += feeTaxableAmount;
      totalTaxAcc += feeTaxAmount;

      customCharges.push({
        id: customChargeSetting.id,
        name: customChargeSetting.name || 'Delivery Charges',
        sac: customChargeSetting.sac || '996511',
        amount: totalFee,
        taxTreatment: 'taxable',
        taxableAmount: feeTaxableAmount,
        taxGroup: {
          "id": 7,
          "name": "GST 18%",
          "taxSpecification": "intra",
          "isSystemDefault": true,

          taxes: [
            {
              id: 10,
              name: 'CGST 9%',
              rate: halfRate,
              taxType: 'cgst',
              taxAmount: cgstAmount
            },
            {
              id: 11,
              name: 'SGST 9%',
              rate: halfRate,
              taxType: 'sgst',
              taxAmount: sgstAmount
            }
          ]
        }
      });
    }

    const couponDiscount = Number((Number(order.couponDiscount) || 0).toFixed(2));

    const gstTreatment = ['regular', 'composition', 'unregistered'].includes(order.gstTreatment) ? order.gstTreatment : 'regular';

    return {
      isAutoNumber: true,
      voucherAutoSeriesId: voucherSeries ? voucherSeries.id : null,
      partyId: Number(user.petpoojaCustomerId),
      billingAddressId: Number(order.billingPetpoojaAddressId),
      shippingAddressId: Number(order.shippingPetpoojaAddressId),
      placeOfSupplyId: 9, // Force intra-state UP (9)
      templateId: template ? template.id : null,
      date: new Date(order.createdAt).toISOString().split('T')[0],
      isInclusiveTax: true,
      isItemLevelDiscount: false,
      isDiscountPercentage: false,
      discountAmount: couponDiscount,
      discountRate: null,
      notes: "",
      terms: "",
      attachment: [],
      status: targetStatus,
      customCharges: customCharges,
      lineItems: lineItems,
      gstTreatment: gstTreatment,
      taxableAmount: Number(totalTaxableAcc.toFixed(2)),
      taxTotal: Number(totalTaxAcc.toFixed(2)),
      total: Number((order.grandTotal || 0).toFixed(2)),
    };
  }

  /**
   * Builds a Sales Order payload using returnedItemsDetails instead of the full order items.
   * This is used when creating a new sales order for returned items after a driver return.
   */
  async _buildDeliveredSalesOrderPayload(order, user, targetStatus = 'sent') {
    await require('./partyService').resolveOrderShippingAddress(user, order);
    const Product = require('../../../models/productModel');
    const itemService = require('./itemService');

    // Fetch dynamic IDs (same as normal payload)
    const voucherSeries = await this.initVoucher();
    const template = await this.initTemplate();
    const customChargeSetting = await this.getCustomCharge();

    let totalTaxAcc = 0;
    let totalTaxableAcc = 0;
    const lineItems = [];
    console.log('Building returned sales order payload for order', order._id?.toString());

    console.log('orderrrrrrrrrrrrrr: ', order);
    const deliveredItems = order.deliveredItemsDetails || [];
    for (const item of deliveredItems) {
      // Use existing petpoojaItemId if present; otherwise try to resolve via variation
      let petpoojaItemId = item.petpoojaItemId;
      let unitId = 28; // Pieces
      let variation = null;

      const product = await Product.findById(item.productId);
      if (product) {
        variation = product.productVariations.find(v => v._id.toString() === item.variationId.toString());
        if (variation && !petpoojaItemId) {
          // Attempt auto‑sync similar to normal flow
          try {
            console.log(`[PETPOOJA] Auto-syncing missing returned item ${variation.sku} to Petpooja...`);
            const newPetpoojaId = await itemService.createItem(product, variation);
            if (newPetpoojaId) {
              variation.petpoojaItemId = newPetpoojaId;
              await product.save();
              petpoojaItemId = newPetpoojaId;
              console.log(`[PETPOOJA] Auto‑synced returned item ID: ${newPetpoojaId}`);
            }
          } catch (syncErr) {
            console.error(`[PETPOOJA] Failed to auto-sync returned item:`, syncErr.message);
          }
        }
        if (!petpoojaItemId) {
          console.error(`[PETPOOJA] Missing Petpooja item ID for returned variation ${variation?.sku}`);
          throw new Error('Missing Petpooja item ID for returned item');
        }
      }

      const parsedItemId = Number(petpoojaItemId);
      const rate = Number(item.priceWithGST || 0);
      const qty = Number(item.quantity || 0);

      // Use the GST snapshot saved with the order first (same as normal payload).
      let gstFrom = null;
      if (typeof item.gstPercent === 'number') {
        gstFrom = item.gstPercent;
      } else if (variation && typeof variation.gst === 'number') {
        gstFrom = variation.gst;
      } else if (product && typeof product.gst === 'number') {
        gstFrom = product.gst;
      } else {
        gstFrom = 0;
      }
      const gstPercent = Number(gstFrom);
      const componentTaxIds = getPetpoojaIntraComponentTaxIds(gstPercent);

      // Reverse tax calculation
      const taxableAmountPerItem = rate / (1 + gstPercent / 100);
      const totalTaxableAmount = Number((taxableAmountPerItem * qty).toFixed(2));
      const totalTaxForItem = Number(((rate * qty) - totalTaxableAmount).toFixed(2));

      totalTaxAcc += totalTaxForItem;
      totalTaxableAcc += totalTaxableAmount;

      const cgstAmount = Number((totalTaxForItem / 2).toFixed(2));
      const sgstAmount = Number((totalTaxForItem / 2).toFixed(2));

      lineItems.push({
        itemId: parsedItemId || null,
        unitId: unitId,
        productType: 'goods',
        quantity: qty,
        rate: rate,
        taxableAmount: totalTaxableAmount,
        taxTreatment: 'taxable',
        taxGroup: {
          id: getPetpoojaTaxGroupId(gstPercent),
          name: `GST ${gstPercent}%`,
          taxSpecification: 'intra',
          taxes: [
            {
              id: componentTaxIds.cgst,
              name: `CGST ${gstPercent / 2}%`,
              rate: Number((gstPercent / 2).toFixed(2)),
              taxType: 'cgst',
              taxAmount: cgstAmount,
            },
            {
              id: componentTaxIds.sgst,
              name: `SGST ${gstPercent / 2}%`,
              rate: Number((gstPercent / 2).toFixed(2)),
              taxType: 'sgst',
              taxAmount: sgstAmount,
            },
          ],
        },
      });
    }

    // Custom charges are the same as normal flow (delivery + platform fees)
    const customCharges = [];
    const totalFee = Number(((order.deliveryCharge || 0) + (order.platformFee || 0)).toFixed(2));
    if (totalFee > 0 && customChargeSetting) {
      const feeGstPercent = 18;
      const halfRate = feeGstPercent / 2;
      const feeTaxableAmount = Number((totalFee / (1 + feeGstPercent / 100)).toFixed(2));
      const feeTaxAmount = Number((totalFee - feeTaxableAmount).toFixed(2));
      const cgstAmount = Number((feeTaxAmount / 2).toFixed(2));
      const sgstAmount = Number((feeTaxAmount - cgstAmount).toFixed(2));

      totalTaxableAcc += feeTaxableAmount;
      totalTaxAcc += feeTaxAmount;

      customCharges.push({
        id: customChargeSetting.id,
        name: customChargeSetting.name || 'Delivery Charges',
        sac: customChargeSetting.sac || '996511',
        amount: totalFee,
        taxTreatment: 'taxable',
        taxableAmount: feeTaxableAmount,
        taxGroup: {
          "id": 7,
          "name": "GST 18%",
          "taxSpecification": "intra",
          "isSystemDefault": true,
          taxes: [
            {
              id: 10,
              name: 'CGST 9%',
              rate: halfRate,
              taxType: 'cgst',
              taxAmount: cgstAmount,
            },
            {
              id: 11,
              name: 'SGST 9%',
              rate: halfRate,
              taxType: 'sgst',
              taxAmount: sgstAmount,
            },
          ],
        },
      });
    }



    const gstTreatment = ['regular', 'composition', 'unregistered'].includes(order.gstTreatment) ? order.gstTreatment : 'regular';

    return {
      isAutoNumber: true,
      voucherAutoSeriesId: voucherSeries ? voucherSeries.id : null,
      partyId: Number(user.petpoojaCustomerId),
      billingAddressId: Number(order.billingPetpoojaAddressId),
      shippingAddressId: Number(order.shippingPetpoojaAddressId),
      placeOfSupplyId: 9,
      templateId: template ? template.id : null,
      date: new Date(order.createdAt).toISOString().split('T')[0],
      isInclusiveTax: true,
      isItemLevelDiscount: false,
      isDiscountPercentage: false,
      discountAmount: 0,
      discountRate: null,
      notes: "",
      terms: "",
      attachment: [],
      status: targetStatus,
      customCharges: customCharges,
      lineItems: lineItems,
      gstTreatment: gstTreatment,
      taxableAmount: Number(totalTaxableAcc.toFixed(2)),
      taxTotal: Number(totalTaxAcc.toFixed(2)),
      total: Number((order.grandTotal || 0).toFixed(2)),
    };
  }
  async createSalesOrder(order, user, targetStatus = 'invoiced') {
    try {
      const payload = await this._buildSalesOrderPayload(order, user, targetStatus);
      console.log('[PETPOOJA] ===== CREATE SALES ORDER =====');
      console.log('[PETPOOJA] Payload being sent:', JSON.stringify(payload, null, 2));
      const response = await this.post('', payload);
      console.log('[PETPOOJA] Raw API response status:', response.status);
      console.log('[PETPOOJA] Raw API response.data:', JSON.stringify(response.data, null, 2));
      // Normalize response data (handle possible wrapping)
      const data = response.data || {};
      const normalized = data.data || data;
      console.log('[PETPOOJA] Normalized data:', JSON.stringify(normalized, null, 2));
      // Helper to find keys case‑insensitively within nested objects
      const findKey = (obj, target) => {
        if (!obj || typeof obj !== 'object') return undefined;
        for (const [k, v] of Object.entries(obj)) {
          if (k.toLowerCase() === target.toLowerCase()) return v;
          const nested = findKey(v, target);
          if (nested !== undefined) return nested;
        }
        return undefined;
      };
      const voucherId =
        normalized.voucherId ||
        normalized.voucher_id ||
        (normalized.voucher && normalized.voucher.id) ||
        findKey(normalized, 'voucherId') ||
        findKey(normalized, 'voucher_id') ||
        findKey(normalized, 'id');
      const voucherNumber =
        normalized.voucherNumber ||
        normalized.voucher_number ||
        (normalized.voucher && normalized.voucher.number) ||
        findKey(normalized, 'voucherNumber') ||
        findKey(normalized, 'voucher_number') ||
        findKey(normalized, 'number');
      // Return a consistent shape for the controller
      console.log(`[PETPOOJA] Extracted voucherId: ${voucherId}, voucherNumber: ${voucherNumber}`);
      return {
        voucherId: voucherId != null ? String(voucherId) : null,
        voucherNumber: voucherNumber != null ? String(voucherNumber) : null,
        message: normalized.message || normalized.msg || null,
      };
    } catch (error) {
      console.error('Petpooja Sales Order Error:', error?.response?.data || error.message);
      throw new Error(error?.response?.data?.message || 'Failed to create sales order in Petpooja');
    }
  }


  /**
   * Creates a sales order for returned items using the dedicated payload builder.
   * This mirrors createSalesOrder but sources line items from order.returnedItemsDetails.
   */
  async createDeliveredSalesOrder(order, user, targetStatus = 'invoiced') {
    try {
      const payload = await this._buildDeliveredSalesOrderPayload(order, user, targetStatus);
      console.log('[PETPOOJA] ===== CREATE DELIVERED SALES ORDER =====');
      console.log('[PETPOOJA] Payload being sent (delivered):', JSON.stringify(payload, null, 2));
      const response = await this.post('', payload);
      console.log('[PETPOOJA] Delivered Sales Order response status:', response.status);
      console.log('[PETPOOJA] Delivered Sales Order response data:', JSON.stringify(response.data, null, 2));
      // Reuse existing response normalization logic
      const data = response.data || {};
      const normalized = data.data || data;
      const findKey = (obj, target) => {
        if (!obj || typeof obj !== 'object') return undefined;
        for (const [k, v] of Object.entries(obj)) {
          if (k.toLowerCase() === target.toLowerCase()) return v;
          const nested = findKey(v, target);
          if (nested !== undefined) return nested;
        }
        return undefined;
      };
      const voucherId = normalized.voucherId || normalized.voucher_id || (normalized.voucher && normalized.voucher.id) || findKey(normalized, 'voucherId') || findKey(normalized, 'voucher_id') || findKey(normalized, 'id');
      const voucherNumber = normalized.voucherNumber || normalized.voucher_number || (normalized.voucher && normalized.voucher.number) || findKey(normalized, 'voucherNumber') || findKey(normalized, 'voucher_number') || findKey(normalized, 'number');
      console.log(`[PETPOOJA] Extracted returned voucherId: ${voucherId}, voucherNumber: ${voucherNumber}`);
      return {
        voucherId: voucherId != null ? String(voucherId) : null,
        voucherNumber: voucherNumber != null ? String(voucherNumber) : null,
        message: normalized.message || normalized.msg || null,
      };
    } catch (error) {
      console.error('Petpooja Returned Sales Order Error:', error?.response?.data || error.message);
      throw new Error(error?.response?.data?.message || 'Failed to create returned sales order in Petpooja');
    }
  }
}
module.exports = new SalesOrderService();
