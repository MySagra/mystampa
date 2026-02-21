/**
 * Route handler for the `/print` endpoint.
 *
 * This implementation reflects the updated business logic for the
 * `mystampa` service. Instead of using preloaded categories to find
 * printers, it queries the external API on‑the‑fly for each food
 * item to determine its associated kitchen printer. It also looks
 * up the cash register printer via a dedicated API call. Items are
 * aggregated per printer and a separate receipt is generated for
 * kitchen and cash printers. Receipts include order metadata and
 * blank space above and below to ensure thermal printers advance
 * the paper.
 */

import { Router, Request, Response } from "express";
import axiosInstance from "../utils/axiosInstance";
import {
  IncomingOrder,
  FoodFromApi,
  CashRegisterFromApi,
  Printer,
} from "../models";
import { printQueue } from "../utils/printQueue";
import {
  buildKitchenReceipt,
  buildCashReceipt,
  sendToPrinter,
  getPrinterStatus,
  KitchenReceiptLine,
  CashReceiptLine,
} from "../utils/printer";

const router = Router();

// Keep a progress counter for each printer. Each time a kitchen receipt
// is generated for a printer the counter increments. This map lives
// within the module scope so values persist across requests while the
// server is running.
const progressCounters: { [printerId: string]: number } = {};

/**
 * Safe print helper: checks paper status before printing.
 * If paper is out or any error occurs, the job is added to the print queue.
 */
async function safePrint(printerId: string, ip: string, port: number, data: (string | Buffer)[] | string | Buffer) {
  try {
    const status = await getPrinterStatus(ip, port);
    if (status === "OK" || status === "CARTA_QUASI_FINITA") {
      try {
        await sendToPrinter(ip, port, data);
        console.log(`[SafePrint] Printed successfully to ${printerId}`);
      } catch (printErr) {
        console.error(`[SafePrint] Print failed for ${printerId}, adding to queue:`, printErr);
        printQueue.add(printerId, ip, port, data);
      }
    } else {
      console.warn(`[SafePrint] Printer ${printerId} status '${status}', adding to queue.`);
      printQueue.add(printerId, ip, port, data);
    }
  } catch (statusErr) {
    console.error(`[SafePrint] Status check failed for ${printerId}, adding to queue:`, statusErr);
    printQueue.add(printerId, ip, port, data);
  }
}

/**
 * Extend Express Request to optionally include the cached list of
 * printers from initialization.
 */
interface PrintRequest extends Request {
  printers?: Printer[];
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

/**
 * POST /print
 *
 * Receives an order payload and produces receipts for the kitchen
 * printers associated with each food item and a separate receipt
 * for the cash register printer. Each food is looked up via the
 * external API to determine its kitchen printer and price. Items are
 * grouped by printer ID and printed together. The cash receipt
 * includes unit prices and a final total minus any discount. When
 * printers cannot be resolved, receipts are logged to the console
 * instead of sent over the network.
 */
router.post("/", async (req: PrintRequest, res: Response) => {
  const order = req.body as IncomingOrder;
  if (!order || !Array.isArray(order.orderItems)) {
    return res
      .status(400)
      .json({ error: "Invalid payload: missing orderItems[]" });
  }

  const EXTERNAL_BASE_URL: string =
    process.env.EXTERNAL_BASE_URL || "http://localhost:4300";
  const token: string | undefined = (global as any).__AUTH_TOKEN;
  if (!token) {
    return res
      .status(500)
      .json({ error: "Missing auth token (login not completed)" });
  }

  // Aggregation map for kitchen receipts keyed by printerId
  const kitchenByPrinterId = new Map<string, KitchenReceiptLine[]>();
  // Lines for the cash receipt (all items). Each entry includes the surcharge
  // field so that extra prices can be printed on the fiscal receipt.
  const cashLines: CashReceiptLine[] = [];

  // Iterate all order items and group accordingly
  for (const it of order.orderItems) {
    const foodName = it.food?.name ?? `FOOD(${it.id})`;
    const qty = it.quantity ?? 1;
    const notes = it.notes ?? null;
    const printerId = trimStr(it.food?.printerId);
    if (printerId) {
      const arr = kitchenByPrinterId.get(printerId) ?? [];
      arr.push({ foodName, quantity: qty, notes });
      kitchenByPrinterId.set(printerId, arr);
    }
    const unitPrice =
      it.unitPrice !== undefined && it.unitPrice !== null
        ? toNumber(it.unitPrice)
        : 0; // fallback se manca

    const surcharge =
      it.unitSurcharge !== undefined && it.unitSurcharge !== null
        ? toNumber(it.unitSurcharge)
        : 0; // default 0

    cashLines.push({ foodName, quantity: qty, notes, unitPrice, surcharge });
  }

  // Resolve the cash register printer. First fetch the cash register from the API
  let cashRegisterPrinterId = "";
  let cashRegisterPrinterEmbedded: {
    id: string;
    ip?: string | null;
    port?: any;
  } | null = null;
  if (order.cashRegisterId !== null && order.cashRegisterId !== undefined) {
    const crId = trimStr(order.cashRegisterId);
    try {
      const r = await axiosInstance.get<CashRegisterFromApi>(
        `${EXTERNAL_BASE_URL}/v1/cash-registers/${crId}?include=printer`,
        {
          headers: {
            Accept: "application/json",
            Authorization: `Bearer ${token}`,
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
        }
        : null;
    } catch (e) {
      console.error("cash-register fetch failed", crId, e);
    }
  }

  // Retrieve cached printers from middleware
  const printers = req.printers || [];

  /**
   * Resolve a printer by ID. If the cash register response included
   * embedded printer details (ip/port) for this printerId, those
   * values are preferred. Otherwise we fall back to the cached
   * printers list loaded during initialization.
   */
  function resolvePrinter(
    printerId: string,
  ): { id: string; ip: string; port: number } | null {
    const pid = trimStr(printerId);
    if (!pid) return null;
    // If the embedded printer is available and matches this id, use it
    if (
      cashRegisterPrinterEmbedded &&
      trimStr(cashRegisterPrinterEmbedded.id) === pid
    ) {
      const ip = trimStr(cashRegisterPrinterEmbedded.ip);
      const port = parsePort(cashRegisterPrinterEmbedded.port);
      if (ip && port > 0) return { id: pid, ip, port };
    }
    // Fallback to cached printers
    const p = printers.find((x) => trimStr((x as any).id) === pid);
    if (!p) return null;
    return {
      id: pid,
      ip: trimStr((p as any).ip),
      port: parsePort((p as any).port),
    };
  }

  // Print receipts for kitchen printers
  for (const [printerId, lines] of kitchenByPrinterId.entries()) {
    const pr = resolvePrinter(printerId);
    // Determine progressive number for this printer
    const prog = progressCounters[printerId] ?? 1;
    const receipt = buildKitchenReceipt(order, lines, prog);
    // Increment progress counter
    progressCounters[printerId] = prog + 1;
    if (pr) {
      // Use safePrint logic
      await safePrint(printerId, pr.ip, pr.port, receipt);
    } else {
      console.log("NO PRINTER for kitchen printerId=", printerId);
      console.log(receipt);
    }
  }

  // Print receipt for cash register printer
  if (cashRegisterPrinterId) {
    const pr = resolvePrinter(cashRegisterPrinterId);
    const receipt = await buildCashReceipt(order, cashLines);
    if (pr) {
      // Use safePrint logic
      await safePrint(cashRegisterPrinterId, pr.ip, pr.port, receipt);
    } else {
      console.log("NO PRINTER for cash printerId=", cashRegisterPrinterId);
      console.log(receipt);
    }
  } else {
    console.log("NO cashRegister printerId found");
    console.log(await buildCashReceipt(order, cashLines));
  }
  return res.json({
    ok: true,
    kitchenPrinters: Array.from(kitchenByPrinterId.keys()),
    cashPrinterId: cashRegisterPrinterId,
  });
});

export default router;
