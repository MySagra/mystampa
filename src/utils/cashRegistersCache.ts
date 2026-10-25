import axiosInstance from './axiosInstance';
import { CashRegisterFromApi, Printer } from '../models';

const API_URL = process.env.API_URL || 'http://localhost:4300';

// cashRegisterId → cash register with its embedded default printer
let cache: Map<string, CashRegisterFromApi> = new Map();

/**
 * Fetch all cash registers (with their default printer) and replace the cache.
 * On failure the previous cache is kept.
 */
export async function fetchAndCacheCashRegisters(): Promise<void> {
  try {
    const resp = await axiosInstance.get<CashRegisterFromApi[]>(`${API_URL}/v1/cash-registers?include=printer`);
    cache = new Map(resp.data.map((cr) => [String(cr.id).trim(), cr]));
    console.log(`[CashRegisters] Cached ${cache.size} cash registers`);
  } catch (err: any) {
    console.error('[CashRegisters] Failed to fetch cash registers:', err.message);
  }
}

/**
 * Resolve the default printer of a cash register from the cache. On a miss
 * (e.g. a cash register created after the last refresh) the cache is
 * refreshed once. Address details come from the printers list, which is
 * refreshed more often, with the embedded printer as fallback.
 */
export async function resolveCashRegisterPrinter(
  cashRegisterId: string,
  printers: Printer[]
): Promise<Printer | null> {
  const key = String(cashRegisterId).trim();
  if (!cache.has(key)) await fetchAndCacheCashRegisters();

  const cr = cache.get(key);
  if (!cr) return null;

  const printerId = String(cr.defaultPrinterId ?? cr.defaultPrinter?.id ?? '').trim();
  if (!printerId) return null;

  const listed = printers.find((p) => String(p.id).trim() === printerId);
  if (listed) return listed;
  return cr.defaultPrinter ? Printer.fromJson(cr.defaultPrinter) : null;
}
