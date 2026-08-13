const BaseService = require('./baseService');
const ENDPOINTS = require('../constants/endpoints');
const { resolveGstPercent, getPetpoojaTaxGroupId, getPetpoojaIntraComponentTaxIds } = require('../constants/taxMapping');

class InvoiceService extends BaseService {
  constructor() {
    super(ENDPOINTS.INVOICES.BASE);
  }

  /**
   * Initializes voucher auto-series for invoices.
   * Hits: /api/v1/voucher-init?voucher_type=invoice
   */
  async initVoucher() {
    try {
      const response = await this.client.get(ENDPOINTS.SALES_ORDERS.INIT + '?voucher_type=invoice');
      const data = response.data;
      if (data && data.voucherAutoSeries && data.voucherAutoSeries.length > 0) {
        return data.voucherAutoSeries[0];
      }
      return null;
    } catch (error) {
      console.error('Petpooja Invoice Voucher Init Error:', error?.response?.data || error.message);
      return null;
    }
  }

  /**
   * Fetches template for invoices.
   * Hits: /api/v1/voucher-init?voucher_type=invoice
   */
  async initTemplate() {
    try {
      const response = await this.client.get(ENDPOINTS.SALES_ORDERS.INIT + '?voucher_type=invoice');
      const data = response.data;
      if (data && data.templates && data.templates.length > 0) {
        return data.templates[0];
      }
      return null;
    } catch (error) {
      console.error('Petpooja Invoice Template Init Error:', error?.response?.data || error.message);
      return null;
    }
  }

  // Build payload for invoice creation based on original sales order
  async _buildInvoicePayload(salesOrderId, order, user, templateId, customChargeId, voucherAutoSeriesId, targetStatus = 'sent') {
    const Product = require('../../../models/productModel');
    const itemService = require('./itemService');

    // Reuse logic similar to sales order payload but adjusted for invoice fields
    const lineItems = [];
    let totalTaxAcc = 0;
    let totalTaxableAcc = 0;

    for (const item of order.items) {
      let petpoojaItemId = item.petpoojaItemId;
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
              console.warn(`[PETPOOJA-INV] Missing item ID for ${variation.sku}; skipping auto item creation during Invoice to avoid stock changes.`);
            }
          }
          if (petpoojaItemId && item.petpoojaItemId !== petpoojaItemId) {
            item.petpoojaItemId = petpoojaItemId;
            await order.save();
          }
        }
      }

      const rate = Number(item.priceWithGST || 0);
      const qty = Number(item.quantity || 0);
      const gstPercent = resolveGstPercent(
        item.gstPercent,
        variation?.gst,
        product?.gst,
      );
      // Compute taxable amount per item (reverse inclusive tax)
      const taxablePerItem = rate / (1 + gstPercent / 100);
      const totalTaxable = Number((taxablePerItem * qty).toFixed(2));
      const totalTax = Number(((rate * qty) - totalTaxable).toFixed(2));
      totalTaxAcc += totalTax;
      totalTaxableAcc += totalTaxable;
      const cgst = Number((totalTax / 2).toFixed(2));
      const sgst = Number((totalTax - cgst).toFixed(2));
      const gstGroupId = getPetpoojaTaxGroupId(gstPercent);
      const componentTaxIds = getPetpoojaIntraComponentTaxIds(gstPercent);
      lineItems.push({
        itemId: Number(petpoojaItemId) || null,
        unitId: 28,
        productType: 'goods',
        quantity: qty,
        rate: rate,
        taxableAmount: totalTaxable,
        taxTreatment: 'taxable',
        taxGroup: {
          id: gstGroupId,
          name: `GST ${gstPercent}%`,
          taxSpecification: 'intra',
          taxes: [
            { id: componentTaxIds.cgst, name: `CGST ${gstPercent / 2}%`, rate: Number((gstPercent / 2).toFixed(2)), taxType: 'cgst', taxAmount: cgst },
            { id: componentTaxIds.sgst, name: `SGST ${gstPercent / 2}%`, rate: Number((gstPercent / 2).toFixed(2)), taxType: 'sgst', taxAmount: sgst }
          ]
        }
      });
    }

    // Custom charges – delivery + platform fee (same as sales order)
    const customCharges = [];
    const totalFee = Number(((order.deliveryCharge || 0) + (order.platformFee || 0)).toFixed(2));
    if (totalFee > 0) {
      const feeGst = 18;
      const feeTaxable = Number((totalFee / (1 + feeGst / 100)).toFixed(2));
      const feeTax = Number((totalFee - feeTaxable).toFixed(2));
      totalTaxableAcc += feeTaxable;
      totalTaxAcc += feeTax;
      const cgst = Number((feeTax / 2).toFixed(2));
      const sgst = Number((feeTax - cgst).toFixed(2));
      customCharges.push({
        ...(customChargeId ? { id: Number(customChargeId) } : {}),
        name: 'Delivery Charges',
        sac: '996511',
        amount: totalFee,
        taxTreatment: 'taxable',
        taxableAmount: feeTaxable,
        taxGroup: {
          id: 7,
          name: 'GST 18%',
          taxSpecification: 'intra',
          taxes: [
            { id: 10, name: 'CGST 9%', rate: 9, taxType: 'cgst', taxAmount: cgst },
            { id: 11, name: 'SGST 9%', rate: 9, taxType: 'sgst', taxAmount: sgst }
          ]
        }
      });
    }




    const gstTreatment = ['regular', 'composition', 'unregistered'].includes(order.gstTreatment)
      ? order.gstTreatment
      : 'regular';

    return {
      adjustment: 0,
      allTaxes: {},
      attachment: [],
      customCharges,
      customFields: [],
      date: new Date(order.createdAt).toISOString().split('T')[0],
      discountAmount: Number(order.couponDiscount?.toFixed(2) || 0),
      discountRate: null,
      gstTreatment,
      isAutoNumber: true,
      isDiscountPercentage: false,
      isInclusiveTax: true,
      isItemLevelDiscount: false,
      lineItems,
      notes: '',
      partyId: Number(user.petpoojaCustomerId),
      referenceNumber: order.orderId || '',
      placeOfSupplyId: 9,
      status: "sent",
      paymentStatus: 'paid',
      payment_status: 'paid',
      taxTotal: Number(totalTaxAcc.toFixed(2)),
      taxableAmount: Number(totalTaxableAcc.toFixed(2)),
      terms: '',
      total: Number(order.grandTotal?.toFixed(2) || 0),
      voucherAutoSeriesId: voucherAutoSeriesId ? Number(voucherAutoSeriesId) : null,
      salesOrderIds: [Number(salesOrderId)],
      ...(Number(order.billingPetpoojaAddressId) > 0 ? { billingAddressId: Number(order.billingPetpoojaAddressId) } : {}),
      ...(Number(order.shippingPetpoojaAddressId || order.billingPetpoojaAddressId) > 0 ? { shippingAddressId: Number(order.shippingPetpoojaAddressId || order.billingPetpoojaAddressId) } : {}),
      // Include template ID if provided
      ...(templateId ? { templateId: Number(templateId) } : {})
    };
  }
  /**
   * Builds invoice payload using deliveredItemsDetails.
   */
  async _buildDeliveredInvoicePayload(salesOrderId, order, user, templateId, customChargeId, voucherAutoSeriesId) {
    const lineItems = [];
    let totalTaxAcc = 0;
    let totalTaxableAcc = 0;
    console.log('Building returned invoice payload', order._id?.toString());

    const returnedItems = order.deliveredItemsDetails || [];
    for (const item of returnedItems) {
      const rate = Number(item.priceWithGST || 0);
      const qty = Number(item.quantity || 0);
      let gstPercent = 0;
      if (item.gstPercent) gstPercent = Number(item.gstPercent);
      const taxablePerItem = rate / (1 + gstPercent / 100);
      const totalTaxable = Number((taxablePerItem * qty).toFixed(2));
      const totalTax = Number(((rate * qty) - totalTaxable).toFixed(2));
      totalTaxAcc += totalTax;
      totalTaxableAcc += totalTaxable;
      const cgst = Number((totalTax / 2).toFixed(2));
      const sgst = Number((totalTax - cgst).toFixed(2));
      const gstGroupId = getPetpoojaTaxGroupId(gstPercent);
      const componentTaxIds = getPetpoojaIntraComponentTaxIds(gstPercent);
      lineItems.push({
        itemId: Number(item.petpoojaItemId) || null,
        unitId: 28,
        productType: 'goods',
        quantity: qty,
        rate: rate,
        taxableAmount: totalTaxable,
        taxTreatment: 'taxable',
        taxGroup: {
          id: gstGroupId,
          name: `GST ${gstPercent}%`,
          taxSpecification: 'intra',
          taxes: [
            { id: componentTaxIds.cgst, name: `CGST ${gstPercent / 2}%`, rate: Number((gstPercent / 2).toFixed(2)), taxType: 'cgst', taxAmount: cgst },
            { id: componentTaxIds.sgst, name: `SGST ${gstPercent / 2}%`, rate: Number((gstPercent / 2).toFixed(2)), taxType: 'sgst', taxAmount: sgst }
          ]
        }
      });
    }

    // Custom charges – same as normal flow
    const customCharges = [];
    const totalFee = Number(((order.deliveryCharge || 0) + (order.platformFee || 0)).toFixed(2));
    if (totalFee > 0) {
      const feeGst = 18;
      const feeTaxable = Number((totalFee / (1 + feeGst / 100)).toFixed(2));
      const feeTax = Number((totalFee - feeTaxable).toFixed(2));
      const cgst = Number((feeTax / 2).toFixed(2));
      const sgst = Number((feeTax - cgst).toFixed(2));
      totalTaxableAcc += feeTaxable;
      totalTaxAcc += feeTax;
      customCharges.push({
        ...(customChargeId ? { id: Number(customChargeId) } : {}),
        name: 'Delivery Charges',
        sac: '996511',
        amount: totalFee,
        taxTreatment: 'taxable',
        taxableAmount: feeTaxable,
        taxGroup: {
          id: 7,
          name: 'GST 18%',
          taxSpecification: 'intra',
          taxes: [
            { id: 10, name: 'CGST 9%', rate: 9, taxType: 'cgst', taxAmount: cgst },
            { id: 11, name: 'SGST 9%', rate: 9, taxType: 'sgst', taxAmount: sgst }
          ]
        }
      });
    }



    const gstTreatment = ['regular', 'composition', 'unregistered'].includes(order.gstTreatment) ? order.gstTreatment : 'regular';

    return {
      adjustment: 0,
      allTaxes: {},
      attachment: [],
      customCharges,
      customFields: [],
      date: new Date(order.createdAt).toISOString().split('T')[0],
      discountAmount: Number(order.couponDiscount?.toFixed(2) || 0),
      discountRate: null,
      gstTreatment,
      isAutoNumber: true,
      isDiscountPercentage: false,
      isInclusiveTax: true,
      isItemLevelDiscount: false,
      lineItems,
      notes: '',
      partyId: Number(user.petpoojaCustomerId),
      referenceNumber: order.orderId || '',
      placeOfSupplyId: 9,
      status: 'sent',
      paymentStatus: 'paid',
      payment_status: 'paid',
      taxTotal: Number(totalTaxAcc.toFixed(2)),
      taxableAmount: Number(totalTaxableAcc.toFixed(2)),
      terms: '',
      total: Number(order.grandTotal?.toFixed(2) || 0),
      voucherAutoSeriesId: voucherAutoSeriesId ? Number(voucherAutoSeriesId) : null,
      salesOrderIds: [Number(salesOrderId)],
      ...(Number(order.billingPetpoojaAddressId) > 0 ? { billingAddressId: Number(order.billingPetpoojaAddressId) } : {}),
      ...(Number(order.shippingPetpoojaAddressId || order.billingPetpoojaAddressId) > 0 ? { shippingAddressId: Number(order.shippingPetpoojaAddressId || order.billingPetpoojaAddressId) } : {}),
      ...(templateId ? { templateId: Number(templateId) } : {})
    };
  }

  /**
   * Creates invoice for returned items.
   */
  async createDeliveredInvoice(salesOrderId, order, user, templateId, customChargeId, voucherAutoSeriesId) {
    try {
      const payload = await this._buildDeliveredInvoicePayload(salesOrderId, order, user, templateId, customChargeId, voucherAutoSeriesId);
      console.log('[PETPOOJA] Creating Returned Invoice payload:', JSON.stringify(payload, null, 2));
      const response = await this.post('', payload);
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
      const voucherId = normalized.voucherId || normalized.voucher_id || findKey(normalized, 'voucherId') || findKey(normalized, 'voucher_id');
      const voucherNumber = normalized.voucherNumber || normalized.voucher_number || findKey(normalized, 'voucherNumber') || findKey(normalized, 'voucher_number');
      return { voucherId: voucherId ? String(voucherId) : null, voucherNumber: voucherNumber ? String(voucherNumber) : null };
    } catch (error) {
      console.error('Petpooja Returned Invoice creation error:', error?.response?.data || error.message);
      throw new Error(error?.response?.data?.message || 'Failed to create returned invoice in Petpooja');
    }
  }


  async createInvoice(salesOrderId, order, user, templateId, customChargeId, voucherAutoSeriesId, targetStatus = 'sent') {
    try {
      const payload = await this._buildInvoicePayload(salesOrderId, order, user, templateId, customChargeId, voucherAutoSeriesId, targetStatus);
      console.log('[PETPOOJA] Creating Invoice payload:', JSON.stringify(payload, null, 2));
      const response = await this.post('', payload);
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
      const voucherId = normalized.voucherId || normalized.voucher_id || findKey(normalized, 'voucherId') || findKey(normalized, 'voucher_id');
      const voucherNumber = normalized.voucherNumber || normalized.voucher_number || findKey(normalized, 'voucherNumber') || findKey(normalized, 'voucher_number');
      return { voucherId: voucherId ? String(voucherId) : null, voucherNumber: voucherNumber ? String(voucherNumber) : null };
    } catch (error) {
      console.error('Petpooja Invoice creation error:', error?.response?.data || error.message);
      throw new Error(error?.response?.data?.message || 'Failed to create invoice in Petpooja');
    }
  }

  async markInvoiceClosed(invoiceId) {
    try {
      if (!invoiceId) return null;
      console.log(`[PETPOOJA] Marking invoice closed: ${invoiceId}`);
      // Petpooja typical update payload for status
      const response = await this.put(`/${invoiceId}/status`, { status: 'closed' });
      return response.data;
    } catch (error) {
      console.error('Petpooja Invoice status update error:', error?.response?.data || error.message);
      return null;
    }
  }
}

module.exports = new InvoiceService();
