const axios = require('axios');
const ENDPOINTS = require('../constants/endpoints');
const configRepository = require('../repositories/configRepository');

class AuthService {
  get baseURL() {
    return process.env.PETPOOJA_BASE_URL;
  }

  get email() {
    return process.env.PETPOOJA_EMAIL;
  }

  get password() {
    return process.env.PETPOOJA_PASSWORD;
  }

  isConfigured() {
    return Boolean(this.baseURL && this.email && this.password);
  }

  async login() {
    if (!this.isConfigured()) {
      throw new Error('Petpooja credentials are not configured in environment variables');
    }

    try {
      const response = await axios.post(`${this.baseURL}${ENDPOINTS.AUTH.LOGIN}`, {
        email: this.email,
        password: this.password
      });

      const data = response.data;

      const configData = {
        userId: data.user?.id,
        organizationId: data.currentOrganization?.id,
        accessToken: data.tokens?.accessToken,
        refreshToken: data.tokens?.refreshToken,
        accessTokenExpiresAt: data.tokens?.accessTokenExpiresAt,
        refreshTokenExpiresAt: data.tokens?.refreshTokenExpiresAt,
      };

      await configRepository.saveConfig(configData);
      
      return configData;
    } catch (error) {
      console.error('Petpooja Login Error:', error?.response?.data || error.message);
      throw new Error('Failed to login to Petpooja');
    }
  }

  async getValidTokens() {
    let config = await configRepository.getConfig();

    // If no config or no tokens exist, perform login
    if (!config || !config.accessToken || !config.refreshToken) {
      config = await this.login();
    }

    // Check if access token is expired
    // We add a 1-minute buffer to prevent edge cases
    const now = new Date();
    const isExpired = config.accessTokenExpiresAt && new Date(config.accessTokenExpiresAt).getTime() - 60000 < now.getTime();

    if (isExpired) {
      // For now, if expired, we perform login again as fallback to get fresh tokens
      // If Petpooja supports a refresh token endpoint (e.g., /auth/refresh), it can be used here.
      config = await this.login();
    }

    return {
      accessToken: config.accessToken,
      refreshToken: config.refreshToken
    };
  }
}

module.exports = new AuthService();
