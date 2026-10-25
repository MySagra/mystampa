/**
 * Closure report handler for the mystampa service.
 *
 * This module exports a standalone function `handleGeneralClosure` that
 * processes incoming general-closure events from the SSE stream.
 * It retrieves the cash register printer associated with the closure event
 * and prints a comprehensive report with general statistics and category breakdowns.
 */

import { Printer } from "../models";
import { buildGeneralClosureReport, sendToPrinter, getPrinterStatus } from "../utils/printer";
import { printQueue } from "../utils/printQueue";
import { resolveEffectiveIp, resolveIpFromMac } from "../utils/arp";
import { patchPrinterIp, patchPrinterStatus } from "../utils/api";
import { resolveCashRegisterPrinter } from "../utils/cashRegistersCache";

function trimStr(v: any): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

/**
 * Safe print helper: checks paper status before printing.
 * If paper is out or any error occurs, the job is added to the print queue.
 */
async function safePrint(
  printerId: string,
  ip: string,
  port: number,
  data: (string | Buffer)[] | string | Buffer,
  mac?: string | null,
  printers?: Printer[]
) {
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
 * Handle general-closure event from SSE stream.
 * 
 * The payload contains:
 * - cashRegister: ID of the cash register
 * - report: complete closure report with statistics
 * 
 * This function:
 * 1. Resolves the cash register printer from the cash registers cache
 * 2. Builds a main report with general statistics and cash register stats
 * 3. Builds separate tickets for each category
 * 4. Prints all receipts to the cash register printer
 */
export async function handleGeneralClosure(
  payload: any,
  printers: Printer[]
): Promise<{ ok: boolean; error?: string }> {
  try {
    const cashRegisterId = trimStr(payload.cashRegister);
    if (!cashRegisterId) {
      return { ok: false, error: "Missing cashRegister ID in payload" };
    }

    console.log(`[Closure] Processing general-closure for cash register: ${cashRegisterId}`);

    const printer = await resolveCashRegisterPrinter(cashRegisterId, printers);
    if (!printer || !printer.ip || !printer.port) {
      console.error("[Closure] No printer found for cash register:", cashRegisterId);
      return { ok: false, error: "No printer configured for this cash register" };
    }
    const cashRegisterPrinterId = trimStr(printer.id);
    const printerIp = printer.ip;
    const printerPort = printer.port;
    const printerMac = printer.mac;

    console.log(`[Closure] Using printer ${cashRegisterPrinterId} at ${printerIp}:${printerPort}`);

    // Build closure report receipts
    const receipts = buildGeneralClosureReport(payload);

    console.log(`[Closure] Generated ${receipts.length} receipts (1 main report + ${receipts.length - 1} category tickets)`);

    // Print all receipts
    for (let i = 0; i < receipts.length; i++) {
      const receipt = receipts[i];
      const receiptType = i === 0 ? "Main Report" : `Category ${i}`;
      console.log(`[Closure] Printing ${receiptType}...`);
      
      await safePrint(
        cashRegisterPrinterId,
        printerIp,
        printerPort,
        receipt,
        printerMac,
        printers
      );
    }

    console.log("[Closure] General closure report printed successfully");
    return { ok: true };
  } catch (err: any) {
    console.error("[Closure] Error processing general-closure:", err);
    return { ok: false, error: err.message || "Unknown error" };
  }
}
