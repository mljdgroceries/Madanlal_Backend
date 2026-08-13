const BaseService = require('./baseService');

class ReceiptService extends BaseService {
  constructor() {
    super('/api/v1');
  }

  /**
   * Fetches payment modes from Petpooja API
   * @returns {Promise<Array>} List of payment modes
   */
  async getPaymentModes() {
    try {
      const response = await this.get('/payment-modes');
      return response.data?.data || [];
    } catch (err) {
      console.error('[PETPOOJA-RECEIPT] Failed to fetch payment modes:', err.response?.data || err.message);
      return [];
    }
  }

  /**
   * Fetches bank accounts from Petpooja API
   * @returns {Promise<Array>} List of bank accounts
   */
  async getBankAccounts() {
    try {
      const response = await this.get('/bank-accounts');
      return response.data?.data || [];
    } catch (err) {
      console.error('[PETPOOJA-RECEIPT] Failed to fetch bank-accounts:', err.response?.data || err.message);
      return [];
    }
  }

  /**
   * Creates a receipt voucher on Petpooja to confirm order payment
   * @param {Object} order - Local order object
   * @param {Object} user - Customer user object
   * @returns {Promise<Object>} API response data
   */
  async createReceiptForOrder(order, user) {
    try {
      if (!order.invoiceId) {
        console.warn(`[PETPOOJA-RECEIPT] Order #${order.orderId} does not have an invoiceId; skipping receipt creation`);
        return null;
      }

      // 1. Get Payment Mode ID (Default to Cash)
      const paymentModes = await this.getPaymentModes();
      const cashMode = paymentModes.find(m => m.name && m.name.toLowerCase() === 'cash') || paymentModes.find(m => m.isDefault);
      const paymentModeId = cashMode ? cashMode.id : 254586322; // fallback to user's sample cash ID

      // 2. Get Bank Account ID (Select second object; fallback to first object; fallback to sample ID)
      const bankAccounts = await this.getBankAccounts();
      let depositToAccountId = null;
      if (bankAccounts && bankAccounts.length >= 2) {
        depositToAccountId = bankAccounts[1].id;
      } else if (bankAccounts && bankAccounts.length >= 1) {
        depositToAccountId = bankAccounts[0].id;
      } else {
        depositToAccountId = 255007227; // fallback to user's sample bank account ID
      }

      // 3. Prepare payload
      const amount = Number(order.grandTotal);
      const dateStr = new Date().toISOString().split('T')[0]; // Current date "YYYY-MM-DD"
      
      const payload = {
        amount: amount,
        date: dateStr,
        depositToAccountId: Number(depositToAccountId),
        onAccount: false,
        partyId: Number(user.petpoojaCustomerId),
        paymentModeId: Number(paymentModeId),
        totalAmount: amount,
        vouchers: [
          {
            id: Number(order.invoiceId),
            amount: amount,
            totalAmount: amount
          }
        ]
      };

      console.log(`[PETPOOJA-RECEIPT] Creating receipt for order #${order.orderId}:`, JSON.stringify(payload));
      const response = await this.post('/receipts', payload);
      console.log(`[PETPOOJA-RECEIPT] Receipt created successfully:`, response.data);
      return response.data;
    } catch (err) {
      console.error('[PETPOOJA-RECEIPT] Error creating receipt:', err.response?.data || err.message);
      throw err;
    }
  }
}

module.exports = new ReceiptService();
