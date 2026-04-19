import axiosInstance from './axiosInstance';

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
    console.log(`[API] patchPrinterStatus: printer ${printerId} → ${status}`);
  } catch (err: any) {
    console.error(`[API] patchPrinterStatus failed for printer ${printerId}: ${extractApiError(err)}`);
  }
}

/**
 * Patch the printer IP on the external API.
 * Shared utility used by index.ts, routes/print.ts and utils/printQueue.ts.
 */
export async function patchPrinterIp(printerId: string, ip: string): Promise<void> {
  try {
    await axiosInstance.patch(`${API_URL}/v1/printers/${printerId}`, { ip });
    console.log(`[API] patchPrinterIp: printer ${printerId} → ${ip}`);
  } catch (err: any) {
    console.error(`[API] patchPrinterIp failed for printer ${printerId}: ${extractApiError(err)}`);
  }
}
