import axiosInstance from './axiosInstance';

const API_URL = process.env.API_URL || 'http://localhost:4300';
const API_KEY = process.env.API_KEY || '';

/**
 * Patch the printer status on the external API.
 * Shared utility used by index.ts and routes/print.ts.
 */
export async function patchPrinterStatus(printerId: string, status: 'ONLINE' | 'OFFLINE' | 'ERROR', retries = 2): Promise<void> {
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      await axiosInstance.patch(
        `${API_URL}/v1/printers/${printerId}`,
        { status },
        {
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'X-API-KEY': API_KEY,
          },
        }
      );
      console.log(`[API] patchPrinterStatus: printer ${printerId} → ${status}`);
      return;
    } catch (err: any) {
      if (attempt <= retries) {
        console.warn(`[API] patchPrinterStatus: attempt ${attempt} failed for ${printerId}, retrying in ${attempt}s...`);
        await new Promise((r) => setTimeout(r, attempt * 1000));
      } else {
        console.error(`[API] patchPrinterStatus: all attempts failed for printer ${printerId}:`, err.message);
      }
    }
  }
}

/**
 * Patch the printer IP on the external API.
 * Shared utility used by index.ts, routes/print.ts and utils/printQueue.ts.
 */
export async function patchPrinterIp(printerId: string, ip: string): Promise<void> {
  try {
    await axiosInstance.patch(
      `${API_URL}/v1/printers/${printerId}`,
      { ip },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'X-API-KEY': API_KEY,
        },
      }
    );
    console.log(`[API] patchPrinterIp: printer ${printerId} → ${ip}`);
  } catch (err: any) {
    console.error(`[API] patchPrinterIp failed for ${printerId}:`, err.message);
  }
}
