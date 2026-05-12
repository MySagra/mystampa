/**
 * Print handler for the mystampa service.
 *
 * This module exports a standalone function `handlePrintOrder` that
 * contains the business logic for processing incoming orders.
 * It queries the external API for each food item to determine its
 * associated kitchen printer, looks up the cash register printer,
 * aggregates items per printer and generates separate receipts for
 * kitchen and cash printers.
 */

import axiosInstance from "../utils/axiosInstance";
import {
  IncomingOrder,
  FoodFromApi,
  CashRegisterFromApi,
  Printer,
  IdLike,
} from "../models";

const API_URL: string = process.env.API_URL || "http://localhost:4300";
const apiKey: string = process.env.API_KEY || "";
import { printQueue } from "../utils/printQueue";
import {
  buildKitchenReceipt,
  buildCashReceipt,
  buildCancellationReceipt,
  sendToPrinter,
  getPrinterStatus,
  openCashDrawer,
  KitchenReceiptLine,
  CashReceiptLine,
} from "../utils/printer";
import { resolveEffectiveIp, resolveIpFromMac } from "../utils/arp";
import { patchPrinterIp, patchPrinterStatus } from "../utils/api";

// Keep a progress counter for each printer. Each time a kitchen receipt
// is generated for a printer the counter increments. This map lives
// within the module scope so values persist across calls while the
// server is running.
const progressCounters: { [printerId: string]: number } = {};

/**
 * Safe print helper: checks paper status before printing.
 * If paper is out or any error occurs, the job is added to the print queue.
 */
async function safePrint(printerId: string, ip: string, port: number, data: (string | Buffer)[] | string | Buffer, mac?: string | null, printers?: Printer[]) {
  // Prefer IP; if not available resolve from MAC
  const primaryIp = resolveEffectiveIp(ip, mac);
  if (!primaryIp) {
    console.error(`[SafePrint] No address available for printer ${printerId}`);
    return;
  }

  let targetIp = primaryIp;
  let status = 'UNKNOWN';

  try {
    status = await getPrinterStatus(targetIp, port);
  } catch (err) {
    console.warn(`[SafePrint] getPrinterStatus failed for ${printerId} at ${targetIp}:${port}:`, err);
    // Connection to IP failed — if we have both IP and MAC, try MAC-resolved IP
    if (ip && mac) {
      const macIp = resolveIpFromMac(mac);
      if (macIp && macIp !== targetIp) {
        console.log(`[SafePrint] IP ${targetIp} unreachable, retrying with MAC-resolved IP ${macIp}`);
        try {
          status = await getPrinterStatus(macIp, port);
          targetIp = macIp;
          // IP changed — update DB asynchronously (don't block printing)
          patchPrinterIp(printerId, macIp);
        } catch {
          console.error(`[SafePrint] Both IP and MAC-resolved IP failed for ${printerId}, adding to queue.`);
          printQueue.add(printerId, ip, port, data, mac);
          return;
        }
      } else {
        console.error(`[SafePrint] Status check failed for ${printerId}, adding to queue.`);
        printQueue.add(printerId, ip, port, data, mac);
        return;
      }
    } else {
      console.error(`[SafePrint] Status check failed for ${printerId}, adding to queue.`);
      printQueue.add(printerId, primaryIp, port, data, mac);
      return;
    }
  }

  if (status === "OK" || status === "CARTA_QUASI_FINITA") {
    try {
      await sendToPrinter(targetIp, port, data);
      console.log(`[SafePrint] Printed successfully to ${printerId} (${targetIp}:${port})`);
      // If the printer was not ONLINE in the DB, patch it now that we know it's reachable
      const cached = printers?.find((p) => p.id === printerId);
      if (cached && cached.status !== 'ONLINE') {
        console.log(`[SafePrint] Printer ${printerId} was ${cached.status} but printed successfully — patching to ONLINE`);
        cached.status = 'ONLINE';
        patchPrinterStatus(printerId, 'ONLINE').catch(() => {});
      }
    } catch (printErr) {
      console.error(`[SafePrint] Print failed for ${printerId}, adding to queue:`, printErr);
      printQueue.add(printerId, ip || primaryIp, port, data, mac);
    }
  } else {
    console.warn(`[SafePrint] Printer ${printerId} status '${status}', adding to queue.`);
    printQueue.add(printerId, ip || primaryIp, port, data, mac);
  }
}

/**
 * Helper to trim strings safely. Returns an empty string for null
 * or undefined values.
 */
function trimStr(v: any): string {
  return v === null || v === undefined ? "" : String(v).trim();
}

/**
 * Helper to parse a port value into a number. Accepts both
 * numeric values and strings that may contain dots (e.g. "9.100").
 */
function parsePort(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const s = String(v).trim().replace(/\./g, "");
  const n = parseInt(s, 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Convert arbitrary values into numbers, handling comma as decimal
 * separator. Returns zero for invalid inputs.
 */
function toNumber(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === "number") return v;
  const s = String(v).trim().replace(",", ".");
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

export interface PrintResult {
  ok: boolean;
  kitchenPrinters: string[];
  cashPrinterId: string;
  error?: string;
}

/**
 * Handle an incoming print order. This is the main business logic
 * function that replaces the old POST /print route handler.
 *
 * @param order The incoming order payload
 * @param printers The cached list of printers
 * @returns PrintResult with status information
 */
export async function handlePrintOrder(
  order: IncomingOrder,
  printers: Printer[]
): Promise<PrintResult> {
  if (!order || !Array.isArray(order.orderItems)) {
    return {
      ok: false,
      kitchenPrinters: [],
      cashPrinterId: "",
      error: "Invalid payload: missing orderItems[]",
    };
  }

  // Aggregation map for kitchen receipts keyed by printerId
  const kitchenByPrinterId = new Map<string, KitchenReceiptLine[]>();
  // Lines for the cash receipt (all items). Each entry includes the surcharge
  // field so that extra prices can be printed on the fiscal receipt.
  const cashLines: CashReceiptLine[] = [];
  // Lines for single tickets to be appended to the cash receipt
  const singleTickets: KitchenReceiptLine[] = [];

  // Fetch single ticket categories config
  const singleTicketCategoriesEnv = process.env.SINGLE_TICKET_CATEGORIES;
  const targetCategoryIds = singleTicketCategoriesEnv
    ? singleTicketCategoriesEnv.split(',').map(s => s.trim()).filter(s => s.length > 0)
    : [];

  const stationTicketsEnabled = process.env.STATION_TICKETS_ENABLED === 'true';

  // Determine which items go to kitchen printers.
  // For reprint-order events, use reprintOrderItems exclusively (even if empty = no kitchen print).
  // For normal confirmed-order events (reprintOrderItems undefined), use orderItems.
  const kitchenItems = order.reprintOrderItems !== undefined
    ? (order.reprintOrderItems || [])
    : order.orderItems;

  // Collect all unique food IDs from both kitchen and cash items for API lookups
  const allItems = [...order.orderItems, ...(order.reprintOrderItems || [])];
  const allFoodIds = Array.from(new Set(allItems.map(it => it.foodId || it.food?.id).filter(Boolean))) as string[];

  const foodDetails = new Map<string, FoodFromApi>();
  if (targetCategoryIds.length > 0 || allFoodIds.length > 0) {
    await Promise.all(allFoodIds.map(async (fId) => {
      try {
        const r = await axiosInstance.get<FoodFromApi>(
          `${API_URL}/v1/foods/${fId}`,
          {
            headers: {
              Accept: "application/json",
              'X-API-KEY': apiKey,
            }
          }
        );
        foodDetails.set(fId, r.data);
      } catch (e) {
        console.error(`[Print] Failed to fetch food details for ${fId}`, e);
      }
    }));
  }

  // Group kitchen items by printer
  for (const it of kitchenItems) {
    const fId = it.foodId || it.food?.id;
    const apiFood = fId ? foodDetails.get(fId) : undefined;

    const foodName = apiFood?.name ?? it.food?.name ?? `FOOD(${it.id})`;
    const qty = it.quantity ?? 1;
    const notes = it.notes ?? null;
    const printerId = trimStr(apiFood?.printerId ?? it.food?.printerId);

    if (printerId) {
      const arr = kitchenByPrinterId.get(printerId) ?? [];
      arr.push({ foodName, quantity: qty, notes });
      kitchenByPrinterId.set(printerId, arr);
    }
  }

  // Build cash receipt lines from orderItems (always the full order)
  for (const it of order.orderItems) {
    const fId = it.foodId || it.food?.id;
    const apiFood = fId ? foodDetails.get(fId) : undefined;

    const foodName = apiFood?.name ?? it.food?.name ?? `FOOD(${it.id})`;
    const qty = it.quantity ?? 1;
    const notes = it.notes ?? null;

    const unitPrice =
      it.unitPrice !== undefined && it.unitPrice !== null
        ? toNumber(it.unitPrice)
        : 0; // fallback se manca

    const surcharge =
      it.unitSurcharge !== undefined && it.unitSurcharge !== null
        ? toNumber(it.unitSurcharge)
        : 0; // default 0

    cashLines.push({ foodName, quantity: qty, notes, unitPrice, surcharge });

    const categoryId = apiFood?.categoryId ?? it.food?.categoryId;
    if (categoryId && targetCategoryIds.includes(String(categoryId))) {
      singleTickets.push({ foodName, quantity: qty, notes });
    }
  }

  // Build station tickets grouped by station.
  // Stations are now embedded in orderItems (food.category.station), no cache needed.
  const stationTickets: { stationName: string; lines: KitchenReceiptLine[] }[] = [];
  if (stationTicketsEnabled) {
    const stationMap = new Map<string, { name: string; lines: KitchenReceiptLine[] }>();
    for (const it of order.orderItems) {
      const station = it.food?.category?.station;
      if (!station) continue;
      const stationId = station.id;
      const foodName = it.food?.name ?? `FOOD(${it.id})`;
      if (!stationMap.has(stationId)) {
        stationMap.set(stationId, { name: station.name, lines: [] });
      }
      stationMap.get(stationId)?.lines.push({ foodName, quantity: it.quantity ?? 1, notes: it.notes ?? null });
    }
    for (const { name, lines } of stationMap.values()) {
      if (lines.length > 0) {
        stationTickets.push({ stationName: name, lines });
      }
    }
  }

  // Resolve the cash register printer. First fetch the cash register from the API
  let cashRegisterPrinterId = "";
  let cashRegisterPrinterEmbedded: {
    id: string;
    ip?: string | null;
    port?: any;
    mac?: string | null;
  } | null = null;
  if (order.cashRegisterId !== null && order.cashRegisterId !== undefined) {
    const crId = trimStr(order.cashRegisterId);
    try {
      const r = await axiosInstance.get<CashRegisterFromApi>(
        `${API_URL}/v1/cash-registers/${crId}?include=printer`,
        {
          headers: {
            Accept: "application/json",
            'X-API-KEY': apiKey,
          },
        },
      );

      cashRegisterPrinterId =
        trimStr(r.data.defaultPrinterId) || trimStr(r.data.defaultPrinter?.id);
      cashRegisterPrinterEmbedded = r.data.defaultPrinter
        ? {
          id: r.data.defaultPrinter.id,
          ip: r.data.defaultPrinter.ip,
          port: r.data.defaultPrinter.port,
          mac: r.data.defaultPrinter.mac ?? null,
        }
        : null;
    } catch (e) {
      console.error("cash-register fetch failed", crId, e);
    }
  }

  /**
   * Resolve a printer by ID. If the cash register response included
   * embedded printer details (ip/port) for this printerId, those
   * values are preferred. Otherwise we fall back to the cached
   * printers list loaded during initialization.
   */
  function resolvePrinter(
    printerId: string,
  ): { id: string; ip: string; port: number; mac: string | null } | null {
    const pid = trimStr(printerId);
    if (!pid) return null;
    // If the embedded printer is available and matches this id, use it
    if (
      cashRegisterPrinterEmbedded &&
      trimStr(cashRegisterPrinterEmbedded.id) === pid
    ) {
      const ip = trimStr(cashRegisterPrinterEmbedded.ip);
      const port = parsePort(cashRegisterPrinterEmbedded.port);
      const mac = cashRegisterPrinterEmbedded.mac ? String(cashRegisterPrinterEmbedded.mac).trim() : null;
      if ((ip || mac) && port > 0) return { id: pid, ip, port, mac };
    }
    // Fallback to cached printers
    const p = printers.find((x) => trimStr(x.id) === pid);
    if (!p) return null;
    return {
      id: pid,
      ip: trimStr(p.ip),
      port: parsePort(p.port),
      mac: p.mac ? String(p.mac).trim() : null,
    };
  }

  // Build all print jobs (kitchen + cash) and fire them in parallel
  const printJobs: Promise<void>[] = [];

  for (const [printerId, lines] of kitchenByPrinterId.entries()) {
    const pr = resolvePrinter(printerId);
    const prog = progressCounters[printerId] ?? 1;
    const receipt = buildKitchenReceipt(order, lines, prog);
    progressCounters[printerId] = prog + 1;
    if (pr) {
      printJobs.push(safePrint(printerId, pr.ip, pr.port, receipt, pr.mac, printers));
    } else {
      console.log("NO PRINTER for kitchen printerId=", printerId);
      console.log(receipt);
    }
  }

  // Print receipt for cash register printer.
  // When reprintReceipt is explicitly false the fiscal receipt is skipped.
  if (order.reprintReceipt === false) {
    console.log("[Print] reprintReceipt=false, skipping cash receipt");
  } else if (cashRegisterPrinterId) {
    const pr = resolvePrinter(cashRegisterPrinterId);
    const receipt = await buildCashReceipt(order, cashLines, singleTickets, stationTickets);
    if (pr) {
      printJobs.push(safePrint(cashRegisterPrinterId, pr.ip, pr.port, receipt, pr.mac, printers));
    } else {
      console.log("NO PRINTER for cash printerId=", cashRegisterPrinterId);
      console.log(receipt);
    }
  } else {
    console.log("NO cashRegister printerId found, skipping cash receipt");
  }

  const settled = await Promise.allSettled(printJobs);
  for (const result of settled) {
    if (result.status === 'rejected') {
      console.error('[Print] A print job failed unexpectedly:', result.reason);
    }
  }

  return {
    ok: true,
    kitchenPrinters: Array.from(kitchenByPrinterId.keys()),
    cashPrinterId: cashRegisterPrinterId,
  };
}

/**
 * Handle an order-cancelled SSE event. Printer IDs come directly in the payload.
 * Fetches the order only to get customer and table for the receipt.
 */
export async function handleOrderCancelled(
  payload: {
    orderId: IdLike;
    ticketNumber?: number | null;
    displayCode?: string | null;
    customer?: string | null;
    table?: string | null;
    status?: string | null;
    printers: string[];
  },
  printers: Printer[]
): Promise<{ ok: boolean; error?: string }> {
  console.log(`[Cancellation] Received order-cancelled for orderId=${payload.orderId}`, payload);

  if (!Array.isArray(payload.printers) || payload.printers.length === 0) {
    console.log("[Cancellation] No printers in payload, nothing to print");
    return { ok: true };
  }

  const receipt = buildCancellationReceipt(payload.displayCode, payload.ticketNumber, payload.customer, payload.table);

  const printJobs: Promise<void>[] = [];
  for (const printerId of payload.printers) {
    const pr = printers.find((p) => trimStr(p.id) === trimStr(printerId));
    if (pr) {
      printJobs.push(
        safePrint(trimStr(pr.id), trimStr(pr.ip), parsePort(pr.port), receipt, pr.mac ?? null, printers)
      );
    } else {
      console.warn(`[Cancellation] No cached printer found for printerId=${printerId}`);
    }
  }

  await Promise.allSettled(printJobs);

  return { ok: true };
}

export async function handleOpenDrawer(
  payload: { printerId: string },
  printers: Printer[]
): Promise<{ ok: boolean; error?: string }> {
  const printer = printers.find((p) => p.id === payload.printerId);
  if (!printer) {
    return { ok: false, error: `Printer not found: ${payload.printerId}` };
  }

  const ip = resolveEffectiveIp(printer.ip, printer.mac);
  if (!ip) {
    return { ok: false, error: `No address for printer ${printer.id}` };
  }

  try {
    await openCashDrawer(ip, printer.port);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}

export async function handleOpenDrawerByCashRegister(
  cashRegisterId: string,
  printers: Printer[]
): Promise<{ ok: boolean; error?: string }> {
  const crId = trimStr(cashRegisterId);
  if (!crId) return { ok: false, error: 'Missing cashRegisterId' };

  let printerId = '';
  let embeddedIp: string | null = null;
  let embeddedPort: number = 0;
  let embeddedMac: string | null = null;

  try {
    const r = await axiosInstance.get<CashRegisterFromApi>(
      `${API_URL}/v1/cash-registers/${crId}?include=printer`,
      { headers: { Accept: 'application/json', 'X-API-KEY': apiKey } }
    );
    printerId = trimStr(r.data.defaultPrinterId) || trimStr(r.data.defaultPrinter?.id);
    if (r.data.defaultPrinter) {
      embeddedIp = r.data.defaultPrinter.ip ? trimStr(r.data.defaultPrinter.ip) : null;
      embeddedPort = parsePort(r.data.defaultPrinter.port);
      embeddedMac = r.data.defaultPrinter.mac ? trimStr(r.data.defaultPrinter.mac) : null;
    }
  } catch (e) {
    return { ok: false, error: `cash-register fetch failed: ${crId}` };
  }

  if (!printerId) return { ok: false, error: `No printer for cash-register ${crId}` };

  let ip = embeddedIp || '';
  let port = embeddedPort;
  let mac = embeddedMac;

  if (!ip || port <= 0) {
    const cached = printers.find((p) => trimStr(p.id) === printerId);
    if (!cached) return { ok: false, error: `Printer not found: ${printerId}` };
    ip = trimStr(cached.ip);
    port = parsePort(cached.port);
    mac = cached.mac ? trimStr(cached.mac) : null;
  }

  const effectiveIp = resolveEffectiveIp(ip, mac);
  if (!effectiveIp) return { ok: false, error: `No address for printer ${printerId}` };

  try {
    await openCashDrawer(effectiveIp, port);
    return { ok: true };
  } catch (err: any) {
    return { ok: false, error: err?.message ?? String(err) };
  }
}
