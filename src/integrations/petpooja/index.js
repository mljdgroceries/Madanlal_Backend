const axiosClient = require('./clients/axiosClient');
const authService = require('./services/authService');
const ENDPOINTS = require('./constants/endpoints');

module.exports = {
  petpoojaClient: axiosClient,
  authService,
  ENDPOINTS
};
