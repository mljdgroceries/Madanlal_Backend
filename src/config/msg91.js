const axios = require("axios");

const MSG91_BASE_URL = "https://api.msg91.com/api/v5/otp";

const getAuthKey = () => process.env.MSG91_AUTH_KEY;
const getTemplateId = () => process.env.MSG91_TEMPLATE_ID;
const getOtpExpiry = () => Number(process.env.MSG91_OTP_EXPIRY || 5);
const getCountryCode = () => String(process.env.MSG91_COUNTRY_CODE || "91");
const getOtpLength = () => Number(process.env.MSG91_OTP_LENGTH || 5);

const withCountryCode = (phone) => {
  const countryCode = getCountryCode();
  const digits = String(phone || "").replace(/\D/g, "");

  if (!digits) return "";

  // Avoid duplicating country code if user already passed it.
  if (digits.startsWith(countryCode) && digits.length > 10) {
    return digits;
  }

  return `${countryCode}${digits}`;
};

const ensureConfigForSend = () => {
  if (!getAuthKey() || !getTemplateId()) {
    throw new Error("MSG91_AUTH_KEY and MSG91_TEMPLATE_ID are required");
  }
};

const ensureConfigForVerify = () => {
  if (!getAuthKey()) {
    throw new Error("MSG91_AUTH_KEY is required");
  }
};

const buildHeaders = () => ({
  authkey: getAuthKey(),
  "Content-Type": "application/json",
});

const ensureSuccessResponse = (response, fallbackMessage) => {
  const data = response?.data || {};
  const type = String(data.type || "").toLowerCase();
  const message = String(data.message || "").toLowerCase();

  // MSG91 usually returns type: "success" on valid operations.
  if (type && type !== "success") {
    throw new Error(data.message || fallbackMessage);
  }

  // Some responses may omit "type" but still include failure message.
  if (!type && /(invalid|failed|error|expired|not match)/.test(message)) {
    throw new Error(data.message || fallbackMessage);
  }

  return data;
};

const sendOtp = async (phone, otp = null) => {
  ensureConfigForSend();
  const otpLength = getOtpLength();
  const response = await axios.post(
    MSG91_BASE_URL,
    {
      template_id: getTemplateId(),
      mobile: withCountryCode(phone),
      otp_expiry: getOtpExpiry(),
      otp_length: otpLength,
      ...(otp ? { otp: String(otp) } : {}),
    },
    { headers: buildHeaders() },
  );
  return ensureSuccessResponse(response, "Unable to send OTP");
};

const verifyOtp = async (phone, otp) => {
  ensureConfigForVerify();
  const response = await axios.post(
    `${MSG91_BASE_URL}/verify`,
    {
      mobile: withCountryCode(phone),
      otp,
    },
    { headers: buildHeaders() },
  );
  return ensureSuccessResponse(response, "OTP verification failed");
};

const isConfigured = () => Boolean(getAuthKey() && getTemplateId());

module.exports = {
  sendOtp,
  verifyOtp,
  isConfigured,
};
