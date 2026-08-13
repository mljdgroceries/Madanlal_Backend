const BaseService = require('./baseService');
const ENDPOINTS = require('../constants/endpoints');

class PartyService extends BaseService {
  constructor() {
    super(ENDPOINTS.PARTIES.BASE);
  }

  /**
   * Helper to build a customer payload from our User model
   */
  buildCustomerPayload(user) {
    const defaultAddress = user.addresses?.find(addr => addr.isDefault) || user.addresses?.[0];

    return {
      name: `User ${user.shortId || user.phone}`,
      mobile: user.phone,
      partyType: 'customer',
      isActive: user.status === 'Active',
      addresses: (user.addresses || []).map(addr => ({
        type: addr.isDefault ? 'billing' : 'shipping',
        street: `${addr.houseFlatOfficeNo || ''} ${addr.area_building || ''} ${addr.landmark || ''}`.trim() || 'No Street Provided',
        city: addr.location?.address || 'Agra',
        stateId: 9, // Hardcoded to Uttar Pradesh (9) to force intra-state GST (CGST/SGST)
        state: 'Uttar Pradesh',
        country: 'India',
        pincode: addr.location?.pincode || ''
      }))
    };
  }

  /**
   * Syncs a user to Petpooja. Creates if new.
   * Throws an error if Petpooja API fails.
   * @param {Object} user - The user object from our database or request body
   * @returns {String} The petpooja customer ID
   */
  async createCustomer(user) {
    try {
      const payload = this.buildCustomerPayload(user);
      const response = await this.post('', payload);
      const data = response.data;

      const petpoojaId = data?.data?.id || data?.id;
      if (!petpoojaId) {
        throw new Error('Petpooja did not return a customer id');
      }
      return String(petpoojaId);
    } catch (error) {
      console.error('Petpooja Party Creation Error:', error?.response?.data || error.message);
      throw new Error(error?.response?.data?.message || 'Failed to sync customer to Petpooja');
    }
  }

  /**
   * Updates an existing customer in Petpooja.
   * @param {String} petpoojaId 
   * @param {Object} user 
   * @returns {Object} The updated customer data
   */
  async updateCustomer(petpoojaId, user) {
    try {
      const payload = this.buildCustomerPayload(user);
      const response = await this.put(`/${petpoojaId}`, payload);
      return response.data;
    } catch (error) {
      console.error('Petpooja Party Update Error:', error?.response?.data || error.message);
      throw new Error(error?.response?.data?.message || 'Failed to update customer in Petpooja');
    }
  }

  /**
   * Deletes a customer from Petpooja.
   * @param {String} petpoojaId 
   * @returns {Object} Response data
   */
  async deleteCustomer(petpoojaId) {
    try {
      const response = await this.delete(`/${petpoojaId}`);
      return response.data;
    } catch (error) {
      console.error('Petpooja Delete Customer Error:', error?.response?.data || error.message);
      throw new Error(error?.response?.data?.message || 'Failed to delete customer from Petpooja');
    }
  }

  /**
   * Retrieves a party (customer) from Petpooja.
   * @param {String} petpoojaId
   * @returns {Object} party data
   */
  async getParty(petpoojaId) {
    try {
      const response = await this.get(`/${petpoojaId}`);
      const data = response.data?.data || response.data;
      return data;
    } catch (error) {
      console.error('Petpooja Get Party Error:', error?.response?.data || error.message);
      throw new Error(error?.response?.data?.message || 'Failed to fetch party from Petpooja');
    }
  }

  /**
   * Syncs a user to Petpooja (create if missing, otherwise update) and returns IDs.
   * @param {Object} user - User document (must contain addresses)
   * @returns {Object} { petpoojaCustomerId, billingAddressId, shippingAddressId }
   */
  async syncUserParty(user) {
    // Ensure customer exists
    let petpoojaCustomerId = user.petpoojaCustomerId;
    if (!petpoojaCustomerId) {
      petpoojaCustomerId = await this.createCustomer(user);
      // Persist back to user document (caller may also persist)
      if (user && typeof user.save === 'function') {
        user.petpoojaCustomerId = petpoojaCustomerId;
        await user.save();
      }
    }
    // NOTE: Do NOT call updateCustomer here — it recreates addresses
    // in Petpooja each time, generating new IDs and causing churn.

    // Fetch latest party to extract address IDs
    const party = await this.getParty(petpoojaCustomerId);
    const billing = (party.addresses || []).find(a => a.type === 'billing');
    const shipping = (party.addresses || []).find(a => a.type === 'shipping');
    return {
      petpoojaCustomerId,
      billingAddressId: billing?.id ? String(billing.id) : null,
      // Fallback: use billing address for shipping if no shipping address exists
      shippingAddressId: shipping?.id ? String(shipping.id) : (billing?.id ? String(billing.id) : null),
    };
  }

  /**
   * Rollback a customer creation in Petpooja if our local DB save fails.
   * @param {String} petpoojaId 
   */
  async rollbackCustomerCreation(petpoojaId) {
    if (!petpoojaId) return;

    try {
      console.log(`[ROLLBACK] Initiating rollback for Petpooja Customer ID: ${petpoojaId}`);

      await this.delete(`/${petpoojaId}`);

      console.log(`[ROLLBACK] Successfully rolled back Petpooja Customer ID: ${petpoojaId}`);
    } catch (error) {
      console.error(`[CRITICAL] Failed to rollback Petpooja Customer ID: ${petpoojaId}. This requires manual cleanup!`, error?.response?.data || error.message);
      // Do not throw here. We are already in an error flow handling the original failure.
    }
  }
}

module.exports = new PartyService();
