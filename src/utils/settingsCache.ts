import axios from 'axios';
import axiosInstance from './axiosInstance';
import { loadImageAsEscPos } from './image';
import { createLogger } from './logger';

const log = createLogger('settings');

const API_URL = process.env.API_URL || 'http://localhost:4300';

/** Shape of GET /v1/settings and of the `settings-update` SSE event. */
export interface AppSettings {
  sagra?: {
    name?: string;
    receiptLogo?: string | null;
  };
  settings?: Record<string, any>;
  updatedAt?: string;
}

let current: AppSettings | null = null;

// The rasterized logo is cached per receiptLogo path, so it is downloaded and
// converted once and not on every receipt.
let logoKey: string | null = null;
let logoBuf: Buffer | null = null;
let logoLoading: Promise<Buffer | null> | null = null;
// After a failed download, wait before trying again so a missing logo doesn't
// slow down every receipt.
const LOGO_RETRY_MS = 60_000;
const LOGO_TIMEOUT_MS = 5_000;
let logoFailedAt = 0;

export function getSettings(): AppSettings | null {
  return current;
}

/** Replace the cached settings (from GET or a `settings-update` event). */
export function applySettings(next: AppSettings): void {
  const prevLogo = current?.sagra?.receiptLogo ?? null;
  current = next;
  const nextLogo = next?.sagra?.receiptLogo ?? null;
  log.info('Settings applied', { sagra: next?.sagra?.name, receiptLogo: nextLogo, showNumbers: next?.settings?.tickets?.showNumbers, currency: next?.settings?.general?.currency, updatedAt: next?.updatedAt });
  if (nextLogo !== prevLogo) {
    // Warm the cache so the next receipt doesn't wait for the download
    getReceiptLogo().catch(() => {});
  }
}

/** Fetch all settings from the backend. On failure the previous ones are kept. */
export async function fetchAndCacheSettings(): Promise<void> {
  try {
    const resp = await axiosInstance.get<AppSettings>(`${API_URL}/v1/settings`);
    applySettings(resp.data);
  } catch (err: any) {
    log.error('Failed to fetch settings', { err });
  }
}

function resolveLogoUrl(receiptLogo: string): string {
  if (/^https?:\/\//i.test(receiptLogo)) return receiptLogo;
  return `${API_URL.replace(/\/+$/, '')}/${receiptLogo.replace(/^\/+/, '')}`;
}

/**
 * Receipt logo as an ESC/POS raster buffer, or null when the sagra has no
 * logo configured or it cannot be downloaded.
 */
export async function getReceiptLogo(): Promise<Buffer | null> {
  const receiptLogo = current?.sagra?.receiptLogo ?? null;
  if (!receiptLogo) return null;
  if (logoKey === receiptLogo && logoBuf) return logoBuf;
  if (logoKey === receiptLogo && logoLoading) return logoLoading;
  if (logoKey === receiptLogo && Date.now() - logoFailedAt < LOGO_RETRY_MS) return null;

  const url = resolveLogoUrl(receiptLogo);
  logoKey = receiptLogo;
  logoBuf = null;
  logoFailedAt = 0;
  const loading = (async () => {
    try {
      // Plain axios, not axiosInstance: its retry backoff would hold up the
      // receipt for minutes if the logo is missing.
      const resp = await axios.get<ArrayBuffer>(url, {
        responseType: 'arraybuffer',
        timeout: LOGO_TIMEOUT_MS,
        headers: { Accept: 'image/*', 'X-API-KEY': process.env.API_KEY || '' },
      });
      const buf = await loadImageAsEscPos(Buffer.from(resp.data), {
        paperWidth: 576, // 80mm paper requires 576 dots width for centering
        exactWidth: 210,
      });
      if (buf.length === 0) {
        log.warn('Receipt logo returned empty buffer, skipping', { url });
        if (logoKey === receiptLogo) logoFailedAt = Date.now();
        return null;
      }
      // Only keep it if the logo did not change while downloading
      if (logoKey === receiptLogo) logoBuf = buf;
      log.info('Receipt logo loaded', { url, bytes: buf.length });
      return buf;
    } catch (err: any) {
      log.error('Failed to download receipt logo', { url, err });
      if (logoKey === receiptLogo) logoFailedAt = Date.now();
      return null;
    }
  })();
  logoLoading = loading;
  loading.finally(() => {
    if (logoLoading === loading) logoLoading = null;
  });
  return loading;
}
