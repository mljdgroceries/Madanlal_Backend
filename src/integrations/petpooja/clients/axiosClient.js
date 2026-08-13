const axios = require('axios');
const authService = require('../services/authService');

// Create axios instance
const petpoojaClient = axios.create({
  baseURL: process.env.PETPOOJA_BASE_URL,
  timeout: 15000,
});

// A flag to prevent multiple token refreshes at once
let isRefreshing = false;
// Queue of pending requests while token is refreshing
let failedQueue = [];

const processQueue = (error, token = null) => {
  failedQueue.forEach(prom => {
    if (error) {
      prom.reject(error);
    } else {
      prom.resolve(token);
    }
  });
  failedQueue = [];
};

// Request Interceptor: Attach Tokens via Cookies
petpoojaClient.interceptors.request.use(
  async (config) => {
    // Ensure baseURL is dynamically set in case dotenv loaded late
    if (!config.baseURL) {
      config.baseURL = process.env.PETPOOJA_BASE_URL;
    }

    // If the request is for login, we don't need tokens
    if (config.url.includes('/auth/login')) {
      return config;
    }

    // Get valid tokens (handles checking expiry and re-login if needed before the call)
    try {
      const tokens = await authService.getValidTokens();

      if (tokens && tokens.accessToken && tokens.refreshToken) {
        // Petpooja expects tokens in request cookies
        config.headers.Cookie = `accessToken=${tokens.accessToken}; refreshToken=${tokens.refreshToken}`;
      }
    } catch (error) {
      console.error('Failed to attach tokens to Petpooja request:', error.message);
      return Promise.reject(error);
    }

    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

// Response Interceptor: Handle 401s and auto-refresh/login
petpoojaClient.interceptors.response.use(
  (response) => {
    return response;
  },
  async (error) => {
    const originalRequest = error.config;

    // Avoid retry loops
    if (originalRequest && originalRequest._retry) {
      return Promise.reject(error);
    }

    // If 401 Unauthorized, token might be invalid or expired
    if (error.response && error.response.status === 401) {
      if (isRefreshing) {
        // If already refreshing, queue the request
        return new Promise(function (resolve, reject) {
          failedQueue.push({ resolve, reject });
        })
          .then(token => {
            originalRequest.headers.Cookie = `accessToken=${token.accessToken}; refreshToken=${token.refreshToken}`;
            return petpoojaClient(originalRequest);
          })
          .catch(err => {
            return Promise.reject(err);
          });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        // Force a re-login/refresh to get fresh tokens
        const tokens = await authService.login();
        
        processQueue(null, tokens);
        
        // Retry the original request with new tokens
        originalRequest.headers.Cookie = `accessToken=${tokens.accessToken}; refreshToken=${tokens.refreshToken}`;
        return petpoojaClient(originalRequest);
      } catch (refreshError) {
        processQueue(refreshError, null);
        return Promise.reject(refreshError);
      } finally {
        isRefreshing = false;
      }
    }

    return Promise.reject(error);
  }
);

module.exports = petpoojaClient;
