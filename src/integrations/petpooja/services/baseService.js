const petpoojaClient = require('../clients/axiosClient');

class BaseService {
  constructor(endpoint) {
    this.endpoint = endpoint;
    this.client = petpoojaClient;
  }

  async get(url = '', config = {}) {
    return await this.client.get(`${this.endpoint}${url}`, config);
  }

  async post(url = '', data = {}, config = {}) {
    return await this.client.post(`${this.endpoint}${url}`, data, config);
  }

  async put(url = '', data = {}, config = {}) {
    return await this.client.put(`${this.endpoint}${url}`, data, config);
  }

  async delete(url = '', config = {}) {
    return await this.client.delete(`${this.endpoint}${url}`, config);
  }
}

module.exports = BaseService;
