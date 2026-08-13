const axios = require("axios");

const BASE_URL = process.env.PETPOOJA_BASE_URL;
const API_KEY = process.env.PETPOOJA_API_KEY;

const isConfigured = () => Boolean(BASE_URL && API_KEY);

const buildHeaders = () => ({
  Authorization: `Bearer ${API_KEY}`,
  "Content-Type": "application/json",
});

const buildCustomerPayload = (user) => ({
  name: `User ${user.shortId}`,
  mobile: user.phone,
  partyType: "customer",
  isActive: true,
});

const createPetpoojaCustomer = async (user) => {
  const payload = buildCustomerPayload(user);
  const { data } = await axios.post(BASE_URL, payload, {
    headers: buildHeaders(),
    timeout: 8000,
  });

  const petpoojaId = data?.data?.id || data?.id;
  if (!petpoojaId) {
    throw new Error("Petpooja did not return a customer id");
  }
  return String(petpoojaId);
};

const syncCustomerOnLogin = async (user) => {
  if (!isConfigured()) return;
  if (!user || user.petpoojaCustomerId) return;

  try {
    const petpoojaId = await createPetpoojaCustomer(user);
    user.petpoojaCustomerId = petpoojaId;
    await user.save();
    console.log(
      `[Petpooja] Customer synced. userId=${user._id} petpoojaId=${petpoojaId}`
    );
  } catch (err) {
    console.error(
      "[Petpooja] Sync failed:",
      err?.response?.data || err.message
    );
  }
};

module.exports = {
  isConfigured,
  buildCustomerPayload,
  createPetpoojaCustomer,
  syncCustomerOnLogin,
};
