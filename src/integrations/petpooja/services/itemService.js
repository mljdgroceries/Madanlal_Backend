const BaseService = require('./baseService');
const ENDPOINTS = require('../constants/endpoints');
const { mapLocalUnit } = require('../constants/unitMapping');
const { resolveGstPercent, getPetpoojaItemGstTaxIds } = require('../constants/taxMapping');

class ItemService extends BaseService {
  constructor() {
    super(ENDPOINTS.ITEMS.BASE);
  }

  formatDescription(desc) {
    // Ensure description is stored as an array of objects matching the schema { descriptionKey, descriptionValue }
    if (!desc) return [];
    // If it's already an array of objects, ensure keys exist
    if (Array.isArray(desc)) {
      return desc.map(item => ({
        descriptionKey: item.descriptionKey || '',
        descriptionValue: item.descriptionValue || ''
      }));
    }
    // For a simple string, store it as a single entry with empty key
    return [{ descriptionKey: '', descriptionValue: String(desc) }];
  }

  /**
   * Builds the Petpooja Item payload following the naming convention:
   * ProductNameWithoutSpaces-SIZE:MeasurmentValueMeasurmentUnitCaps
   */
  buildItemPayload(product, variation) {
    const cleanedProductName = product.productName.replace(/\s+/g, '');
    const measurementVal = variation.measurmentValue || '';
    const measurementUnit = (variation.measurmentUnit || '').toUpperCase().replace(/\s+/g, '');

    let itemName = cleanedProductName;
    if (measurementVal || measurementUnit) {
      itemName = `${cleanedProductName}-SIZE:${measurementVal}${measurementUnit}`;
    }

    mapLocalUnit(variation.measurmentUnit);

    const gstPercent = resolveGstPercent(product.gst, variation.gst);
    const gstIds = getPetpoojaItemGstTaxIds(gstPercent);

    return {
      itemType: 'goods',
      itemName: itemName,

      // Standardize Unit of Measure to Pieces (ID 28)
      unit: 'PIECES',
      purchaseUnit: 'PIECES',
      purchase_unit: 'PIECES',
      salesUnit: 'PIECES',
      sales_unit: 'PIECES',
      consumptionUnit: 'PIECES',
      consumption_unit: 'PIECES',
      unitId: 28,
      unit_id: 28,
      purchaseUnitId: 28,
      purchase_unit_id: 28,
      salesUnitId: 28,
      sales_unit_id: 28,
      consumptionUnitId: 28,
      consumption_unit_id: 28,

      gstType: 'taxable',
      interGstTaxId: gstIds.inter,
      intraGstTaxId: gstIds.intra,
      hsn: product.hsnCode || '0000',

      // Essential fields
      mrp: variation.mrp,
      salesRate: variation.sellingPrice,
      purchaseRate: 0,
      isTrackable: true,
      itemCode: variation.sku || itemName,
      trackSerialNumber: false,  // RackSerialNo

      commission: 0,
      salesMargin: 0,
      isActive: !variation.isDeleted && !product.isDeleted,
      description: Array.isArray(variation.description) ? variation.description.map(d => d.descriptionValue).filter(Boolean).join(', ') : (variation.description || ''),

      minimumStock: variation.minStock || 0,
    };
  }

  async getCurrentStock(petpoojaItemId) {
    try {
      const response = await this.get(`/${petpoojaItemId}`);
      // Petpooja may return stock in different fields; try common ones
      const data = response?.data?.data || response?.data || {};
      const itemData = Array.isArray(data) ? data[0] : data;
      const stockValue =
        itemData?.stockQuantity ??
        itemData?.stock_quantity ??
        itemData?.currentStock ??
        itemData?.current_stock ??
        itemData?.availableStock?.total ??
        itemData?.available_stock?.total ??
        itemData?.batchDetails?.[0]?.totalQuantity ??
        itemData?.locationDetails?.[0]?.totalQuantity ??
        itemData?.batches?.[0]?.currentStock ??
        itemData?.closingStock ??
        itemData?.closing_stock;

      if (stockValue === undefined || stockValue === null || stockValue === "") {
        console.warn(`[PETPOOJA] Current stock not found for item ${petpoojaItemId}; skipping local stock overwrite.`);
        return null;
      }

      const qty = Number(stockValue);
      if (Number.isNaN(qty)) {
        console.warn(`[PETPOOJA] Invalid current stock for item ${petpoojaItemId}: ${stockValue}`);
        return null;
      }
      return qty;
    } catch (err) {
      console.error('Failed to fetch stock from Petpooja:', err.message);
      return null;
    }
  }
  async findItemByName(itemName) {
    try {
      const response = await this.get('');
      const items = response.data?.data || response.data || [];
      const found = items.find(item => item.itemName === itemName);
      return found ? found.id : null;
    } catch (err) {
      console.error('Failed to fetch items from Petpooja for duplicate check:', err.message);
      return null;
    }
  }


  async createItem(product, variation) {
    const payload = this.buildItemPayload(product, variation);
    try {
      const response = await this.post('', payload);
      console.log('[PETPOOJA] Item creation response:', response.data);
      // Extract item ID considering possible response structures
      const data = response.data;
      // After creating the item, sync its stock if provided
      const petpoojaId = data?.data?.id || data?.data?.itemId || data?.id || data?.itemId || null;
      return petpoojaId;
    } catch (error) {
      const firstError = error?.response?.data?.error?.[0] || {};
      if (firstError.code === 'DUPLICATE_ITEM_NAME') {
        console.log(`[PETPOOJA] Item "${payload.itemName}" already exists. Fetching existing item ID...`);
        const existingId = await this.findItemByName(payload.itemName);
        if (existingId) {
          // Log duplicate handling
          console.log(`[PETPOOJA] Found existing item ID: ${existingId} for "${payload.itemName}". Syncing...`);
          try {
            await this.updateItem(existingId, product, variation);
          } catch (updateErr) {
            console.error(`[PETPOOJA] Failed to update existing duplicate item: ${updateErr.message}`);
          }
          return existingId;
        }
      }
      console.error('Petpooja Item Creation Error:', error?.response?.data || error.message);
      throw new Error(firstError.message || error?.response?.data?.message || 'Failed to create item in Petpooja');
    }
  }

  async updateStock(petpoojaItemId, product, variation, oldStockQty = 0) {
    try {
      // 1. Fetch current item details from Petpooja
      const response = await this.get(`/${petpoojaItemId}`);
      const data = response?.data?.data || response?.data || {};
      const itemData = Array.isArray(data) ? data[0] : data;

      if (!itemData || itemData.openingStockQty === undefined) {
        throw new Error(`Could not find openingStockQty for item ${petpoojaItemId} from Petpooja response.`);
      }

      const currentPetpoojaOpeningStock = Number(itemData.openingStockQty) || 0;

      // 2. Check the quantity we are adding or removing from the previous stock of our app DB
      const targetQty = Number(variation.stockQuantity) || 0;
      const prevLocalQty = Number(oldStockQty) || 0;
      const deltaQty = targetQty - prevLocalQty;

      // 3. Add or remove that quantity in openingStockQty
      const newOpeningStockQty = currentPetpoojaOpeningStock + deltaQty;

      // 4. Build the complete item payload to satisfy Petpooja API validations
      const payload = this.buildItemPayload(product, variation);

      // Set the calculated openingStockQty
      payload.openingStockQty = newOpeningStockQty;

      // Remove other immutable opening balance fields to avoid errors
      delete payload.openingStockDate;
      delete payload.openingStockRatePerUnit;

      console.log(`[PETPOOJA] Updating openingStockQty for item ${petpoojaItemId} from ${currentPetpoojaOpeningStock} to ${newOpeningStockQty} (Delta: ${deltaQty})`);
      const updateResponse = await this.put(`/${petpoojaItemId}`, payload);
      console.log('[PETPOOJA] Stock update response:', updateResponse.data);
      return updateResponse.data;
    } catch (error) {
      console.error('Petpooja Stock Update Error:', error?.response?.data || error.message);
      throw new Error(error?.response?.data?.message || 'Failed to update stock in Petpooja');
    }
  }
 
  async deleteItem(petpoojaItemId, product = null, variation = null) {
    try {
      const response = await this.delete(`/${petpoojaItemId}`);
      return response.data;
    } catch (error) {
      const firstError = error?.response?.data?.error?.[0] || {};
      if (firstError.code === 'ITEM_HAS_ACTIVE_TRANSACTIONS') {
        // Item is linked to active transactions; deactivate instead of deleting
        console.warn('[PETPOOJA] Cannot delete item due to active transactions, deactivating instead:', petpoojaItemId);
        try {
          const itemResponse = await this.get(`/${petpoojaItemId}`);
          const itemDataRaw = itemResponse?.data?.data || itemResponse?.data || {};
          const itemData = Array.isArray(itemDataRaw) ? itemDataRaw[0] : itemDataRaw;
          const deactivatePayload = product && variation
            ? this.buildItemPayload(product, variation)
            : {
                itemType: itemData?.itemType || itemData?.item_type || 'goods',
                itemName: itemData?.itemName || itemData?.item_name,
                unit: itemData?.unit || 'PIECES',
                salesRate: itemData?.salesRate || itemData?.sales_rate,
                purchaseRate: itemData?.purchaseRate || itemData?.purchase_rate || itemData?.salesRate || itemData?.sales_rate || 0,
              };
          deactivatePayload.itemName = deactivatePayload.itemName || itemData?.itemName || itemData?.item_name;
          deactivatePayload.unit = deactivatePayload.unit || itemData?.unit || 'PIECES';
          deactivatePayload.salesRate = deactivatePayload.salesRate || itemData?.salesRate || itemData?.sales_rate || variation?.sellingPrice || 0;
          deactivatePayload.purchaseRate =
            itemData?.purchaseRate ||
            itemData?.purchase_rate ||
            variation?.mrp ||
            deactivatePayload.salesRate ||
            0;
          delete deactivatePayload.openingStockDate;
          delete deactivatePayload.openingStockQty;
          delete deactivatePayload.openingStockRatePerUnit;
          deactivatePayload.isActive = false;
          const deactivateResponse = await this.put(`/${petpoojaItemId}`, deactivatePayload);
          return deactivateResponse.data;
        } catch (deactivateError) {
          console.error('Failed to deactivate Petpooja item after delete attempt:', deactivateError?.response?.data || deactivateError.message);
          throw new Error(deactivateError?.response?.data?.message || deactivateError.message);
        }
      }
      console.error('Petpooja Delete Item Error:', error?.response?.data || error.message);
      throw new Error(firstError.message || error?.response?.data?.message || 'Failed to delete item in Petpooja');
    }
  }

  async updateItem(petpoojaItemId, product, variation) {
    try {
      const payload = this.buildItemPayload(product, variation);
      console.log('[PETPOOJA] Updating item payload:', payload);
      // Remove fields that cause errors on update (opening balances are immutable once transactions exist)
      delete payload.openingStockDate;
      delete payload.openingStockQty;
      delete payload.openingStockRatePerUnit;
      const response = await this.put(`/${petpoojaItemId}`, payload);
      console.log('[PETPOOJA] Update response:', response.data);
      return response.data;
    } catch (error) {
      console.error('Petpooja Item Update Error:', error?.response?.data || error.message);
      throw new Error(error?.response?.data?.message || 'Failed to update item in Petpooja');
    }
  }

}

module.exports = new ItemService();
