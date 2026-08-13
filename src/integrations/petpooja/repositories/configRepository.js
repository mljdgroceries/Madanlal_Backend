const PetpoojaConfig = require('../../../models/petpoojaConfigModel');

class ConfigRepository {
  /**
   * Get the global Petpooja configuration
   * Returns the first document since we only maintain one global state
   */
  async getConfig() {
    return await PetpoojaConfig.findOne({});
  }

  /**
   * Upsert the Petpooja configuration
   * @param {Object} data 
   */
  async saveConfig(data) {
    let config = await this.getConfig();
    if (config) {
      Object.assign(config, data);
      return await config.save();
    } else {
      return await PetpoojaConfig.create(data);
    }
  }

  /**
   * Clear the tokens (useful if we need to force re-login)
   */
  async clearTokens() {
    const config = await this.getConfig();
    if (config) {
      config.accessToken = null;
      config.refreshToken = null;
      config.accessTokenExpiresAt = null;
      config.refreshTokenExpiresAt = null;
      await config.save();
    }
  }
}

module.exports = new ConfigRepository();
