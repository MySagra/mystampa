import axios from 'axios';

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
    console.log(`[Axios] ${config.method?.toUpperCase()} ${config.url}`);
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
      console.error(`[Axios] 401 Unauthorized — API key invalid or missing. message="${errMsg}"`);
      return Promise.reject(error);
    }

    if (!config || (config._retryCount ?? 0) >= MAX_RETRIES) {
      console.error(`[Axios] Permanent failure after ${MAX_RETRIES} retries. status=${status ?? 'network'} message="${errMsg}"`);
      return Promise.reject(error);
    }

    config._retryCount = (config._retryCount ?? 0) + 1;
    const delay = RETRY_BASE_MS * Math.pow(2, config._retryCount);
    console.warn(`[Axios] Request failed (status=${status ?? 'network'}, attempt ${config._retryCount}/${MAX_RETRIES}). Retry in ${delay}ms... message="${errMsg}"`);

    await sleep(delay);
    return axiosInstance(config);
  }
);

export default axiosInstance;