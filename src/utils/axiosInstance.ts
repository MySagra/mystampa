import axios from 'axios';
import { createLogger } from './logger';

const log = createLogger('http');

const MAX_RETRIES = 6;
const RETRY_BASE_MS = 1000;

const axiosInstance = axios.create({
  timeout: 10000,
  headers: {
    'Content-Type': 'application/json',
    'Accept': 'application/json',
  },
});

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const extractApiError = (error: any): string => {
  const data = error.response?.data;
  return data?.message || data?.error || error.message || 'unknown error';
};

axiosInstance.interceptors.request.use(
  (config) => {
    const apiKey = process.env.API_KEY || '';
    config.headers['X-API-KEY'] = apiKey;
    log.debug('Request', { method: config.method?.toUpperCase(), url: config.url });
    return config;
  },
  (error) => Promise.reject(error)
);

axiosInstance.interceptors.response.use(
  (response) => response,
  async (error) => {
    const config = error.config;
    const status = error.response?.status;
    const errMsg = extractApiError(error);

    if (status === 401) {
      log.error('Unauthorized: API key invalid or missing', { method: config?.method?.toUpperCase(), url: config?.url, status, error: errMsg });
      return Promise.reject(error);
    }

    if (!config || (config._retryCount ?? 0) >= MAX_RETRIES) {
      log.error('Request failed permanently', { method: config?.method?.toUpperCase(), url: config?.url, status: status ?? 'network', maxRetries: MAX_RETRIES, error: errMsg });
      return Promise.reject(error);
    }

    config._retryCount = (config._retryCount ?? 0) + 1;
    const delay = RETRY_BASE_MS * Math.pow(2, config._retryCount);
    log.warn('Request failed, retrying', { method: config.method?.toUpperCase(), url: config.url, status: status ?? 'network', attempt: config._retryCount, maxRetries: MAX_RETRIES, delayMs: delay, error: errMsg });

    await sleep(delay);
    return axiosInstance(config);
  }
);

export default axiosInstance;