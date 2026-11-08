import axiosInstance from './axiosInstance';
import { createLogger } from './logger';

const log = createLogger('api');

const API_URL = process.env.API_URL || 'http://localhost:4300';

const extractApiError = (err: any): string => {
  const data = err.response?.data;
  return data?.message || data?.error || err.message || 'unknown error';
};

/**
 * Patch the printer status on the external API.
 * Shared utility used by index.ts and routes/print.ts.
 */
export async function patchPrinterStatus(printerId: string, status: 'ONLINE' | 'OFFLINE' | 'ERROR'): Promise<void> {
  try {
    await axiosInstance.patch(`${API_URL}/v1/printers/${printerId}`, { status });
    log.info('Printer status patched', { printerId, status });
  } catch (err: any) {
    log.error('Printer status patch failed', { printerId, status, error: extractApiError(err) });
  }
}

/**
 * Patch the printer IP on the external API.
 * Shared utility used by index.ts, routes/print.ts and utils/printQueue.ts.
 */
export async function patchPrinterIp(printerId: string, ip: string): Promise<void> {
  try {
    await axiosInstance.patch(`${API_URL}/v1/printers/${printerId}`, { ip });
    log.info('Printer IP patched', { printerId, ip });
  } catch (err: any) {
    log.error('Printer IP patch failed', { printerId, ip, error: extractApiError(err) });
  }
}
