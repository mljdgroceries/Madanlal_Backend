const BaseService = require('./baseService');
const ENDPOINTS = require('../constants/endpoints');
const { getPetpoojaTaxGroupId, getPetpoojaIntraComponentTaxIds } = require('../constants/taxMapping');

class CreditNoteService extends BaseService {
  constructor() {
    super(ENDPOINTS.CREDIT_NOTES.BASE);
  }

  /**
   * Initializes voucher auto-series for credit notes.
   * Hits: /api/v1/voucher-init?voucher_type=creditNote
   */
  async initVoucher() {
    try {
      const response = await this.client.get(ENDPOINTS.SALES_ORDERS.INIT + '?voucher_type=creditNote');
      const data = response.data;
      if (data && data.voucherAutoSeries && data.voucherAutoSeries.length > 0) {
        return data.voucherAutoSeries[0];
      }
      return null;
    } catch (error) {
      console.error('Petpooja CreditNote Voucher Init Error:', error?.response?.data || error.message);
      return null;
    }
  }

  /**
   * Fetches template for credit notes.
   * Hits: /api/v1/voucher-init?voucher_type=creditNote
   */
  async initTemplate() {
    try {
      const response = await this.client.get(ENDPOINTS.SALES_ORDERS.INIT + '?voucher_type=creditNote');
      const data = response.data;
      if (data && data.templates && data.templates.length > 0) {
        return data.templates[0];
      }
      return null;
    } catch (error) {
      console.error('Petpooja CreditNote Template Init Error:', error?.response?.data || error.message);
      return null;
    }
  }

  /**
   * Creates a credit note for returned items against an invoice.
   * @param {string|number} invoiceId - Petpooja invoice voucherId.
   * @param {Array} returnedItems - Array of returned item details (as stored in order.returnedItemsDetails).
   * @param {Object} order - The order document (used for misc fields like billing address, dates).
   * @param {Object} user - User object containing petpoojaCustomerId.
   * @param {Object} options - Optional credit-note behavior flags.
   */
  async createCreditNote(invoiceId, returnedItems, order, user, voucherAutoSeriesId, templateId, options = {}) {
    try {
      if (!invoiceId) {
        throw new Error('Missing invoiceId for credit note creation');
      }

      // Build line items similar to sales order payload but using returned items
      const lineItems = [];
      const Product = require('../../../models/productModel');
      const itemService = require('./itemService');

      for (const ret of returnedItems) {
        let petpoojaItemId = ret.itemId || ret.petpoojaItemId;
        let variation = null;

        const product = await Product.findById(ret.productId);
        if (product) {
          variation = product.productVariations.find(
            v => v._id.toString() === ret.variationId.toString()
          );
          if (variation) {
            // Self-healing: Resolve missing petpoojaItemId
            if (!petpoojaItemId) {
              if (variation.petpoojaItemId) {
                petpoojaItemId = variation.petpoojaItemId;
              } else {
                try {
                  console.log(`[PETPOOJA-CN] Auto-syncing missing item ${variation.sku} to Petpooja during Credit Note creation...`);
                  const newPetpoojaId = await itemService.createItem(product, variation);
                  if (newPetpoojaId) {
                    variation.petpoojaItemId = newPetpoojaId;
                    await product.save();
                    petpoojaItemId = newPetpoojaId;
                    console.log(`[PETPOOJA-CN] Auto-synced item successfully. ID: ${newPetpoojaId}`);
                  }
                } catch (syncErr) {
                  console.error(`[PETPOOJA-CN] Failed to auto-sync item to Petpooja:`, syncErr.message);
                }
              }
            }
            // Save healed petpoojaItemId back to the order returnedItemsDetails
            if (petpoojaItemId) {
              const detailItem = order.returnedItemsDetails?.find(
                d => d.productId?.toString() === ret.productId.toString() &&
                     d.variationId?.toString() === ret.variationId.toString()
              );
              if (detailItem && detailItem.petpoojaItemId !== petpoojaItemId) {
                detailItem.petpoojaItemId = petpoojaItemId;
                await order.save();
              }
            }
          }
        }

        // Assuming ret has productId (ObjectId), variationId, quantity, basePrice, priceWithGST, gstPercent
        const qty = Number(ret.quantity || 0);
        const rate = Number(ret.rate || ret.priceWithGST || 0);
        const base = Number(ret.basePrice || 0);
        const gstPercent = Number(ret.gstPercent || 0);
        const componentTaxIds = getPetpoojaIntraComponentTaxIds(gstPercent);
        const taxableAmountPerItem = rate / (1 + gstPercent / 100);
        const totalTaxableAmount = Number((taxableAmountPerItem * qty).toFixed(2));
        const totalTax = Number(((rate * qty) - totalTaxableAmount).toFixed(2));
        const cgst = Number((totalTax / 2).toFixed(2));
        const sgst = Number((totalTax - cgst).toFixed(2));
        lineItems.push({
          itemId: Number(petpoojaItemId) || null,
          unitId: 28,
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
              { id: componentTaxIds.cgst, name: `CGST ${gstPercent / 2}%`, rate: Number((gstPercent / 2).toFixed(2)), taxType: 'cgst', taxAmount: cgst },
              { id: componentTaxIds.sgst, name: `SGST ${gstPercent / 2}%`, rate: Number((gstPercent / 2).toFixed(2)), taxType: 'sgst', taxAmount: sgst },
            ],
          },
        });
      }

      // Full cancellations must reverse the same order-level charges and
      // discount that were included in the original Petpooja invoice. Partial
      // returns retain the existing item-only behavior.
      const customCharges = [];
      if (options.includeOrderAdjustments) {
        const totalFee = Number(
          ((Number(order.deliveryCharge) || 0) + (Number(order.platformFee) || 0)).toFixed(2)
        );

        if (totalFee > 0) {
          const feeGst = 18;
          const feeTaxable = Number((totalFee / (1 + feeGst / 100)).toFixed(2));
          const feeTax = Number((totalFee - feeTaxable).toFixed(2));
          const feeCgst = Number((feeTax / 2).toFixed(2));
          const feeSgst = Number((feeTax - feeCgst).toFixed(2));

          customCharges.push({
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
                { id: 10, name: 'CGST 9%', rate: 9, taxType: 'cgst', taxAmount: feeCgst },
                { id: 11, name: 'SGST 9%', rate: 9, taxType: 'sgst', taxAmount: feeSgst },
              ],
            },
          });
        }
      }

      const payload = {
        adjustment: 0,
        allTaxes: {}, // Petpooja will compute based on lineItems
        attachment: [],
        customCharges,
        customFields: [],
        date: new Date().toISOString().split('T')[0],
        discountAmount: options.includeOrderAdjustments
          ? Number((Number(order.couponDiscount) || 0).toFixed(2))
          : 0,
        discountRate: null,
        gstTreatment: 'unregistered',
        invoiceId: Number(invoiceId),
        isAutoNumber: true,
        isDiscountPercentage: false,
        isInclusiveTax: true,
        isItemLevelDiscount: false,
        lineItems,
        notes: '',
        partyId: Number(user.petpoojaCustomerId),
        referenceNumber: order.invoiceNumber || '',
        reason: 'salesReturn',
        placeOfSupplyId: 9,
        status: 'open',
        taxTotal: 0,
        taxableAmount: 0,
        terms: '',
        total: 0,
        voucherAutoSeriesId: voucherAutoSeriesId ? Number(voucherAutoSeriesId) : null,
        ...(Number(order.billingPetpoojaAddressId) > 0 ? { billingAddressId: Number(order.billingPetpoojaAddressId) } : {}),
        ...(Number(order.shippingPetpoojaAddressId || order.billingPetpoojaAddressId) > 0 ? { shippingAddressId: Number(order.shippingPetpoojaAddressId || order.billingPetpoojaAddressId) } : {}),
        // Include template ID if provided
        ...(templateId ? { templateId: Number(templateId) } : {})
      };

      console.log('[PETPOOJA] ===== CREATE CREDIT NOTE =====');
      console.log('[PETPOOJA] Payload:', JSON.stringify(payload, null, 2));
      const response = await this.post('', payload);
      console.log('[PETPOOJA] Credit Note response status:', response.status);
      console.log('[PETPOOJA] Credit Note response data:', JSON.stringify(response.data, null, 2));

      // Extract basic info from response
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
      const creditNoteId =
        normalized.voucherId ||
        normalized.voucher_id ||
        (normalized.voucher && normalized.voucher.id) ||
        findKey(normalized, 'voucherId') ||
        findKey(normalized, 'voucher_id') ||
        findKey(normalized, 'id');
      const creditNoteNumber =
        normalized.voucherNumber ||
        normalized.voucher_number ||
        (normalized.voucher && normalized.voucher.number) ||
        findKey(normalized, 'voucherNumber') ||
        findKey(normalized, 'voucher_number') ||
        findKey(normalized, 'number');

      return {
        creditNoteId: creditNoteId != null ? String(creditNoteId) : null,
        creditNoteNumber: creditNoteNumber != null ? String(creditNoteNumber) : null,
        message: normalized.message || normalized.msg || null,
      };
    } catch (error) {
      console.error('Petpooja Credit Note Error:', error?.response?.data || error.message);
      throw new Error(error?.response?.data?.message || 'Failed to create credit note in Petpooja');
    }
  }
}

module.exports = new CreditNoteService();
