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
import { createLogger, errorMessage } from "../utils/logger";

const log = createLogger("closure.safePrint");
const closureLog = createLogger("closure");

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
    log.error('No address available for printer', { printerId, mac });
    return;
  }

  let targetIp = primaryIp;
  let status = 'UNKNOWN';

  try {
    status = await getPrinterStatus(targetIp, port);
  } catch (err) {
    log.warn('Printer status check failed', { printerId, ip: targetIp, port, error: errorMessage(err) });
    // Connection to IP failed — if we have both IP and MAC, try MAC-resolved IP
    if (ip && mac) {
      const macIp = resolveIpFromMac(mac);
      if (macIp && macIp !== targetIp) {
        log.info('IP unreachable, retrying with MAC-resolved IP', { printerId, ip: targetIp, macIp, port });
        try {
          status = await getPrinterStatus(macIp, port);
          targetIp = macIp;
          // IP changed — update DB asynchronously (don't block printing)
          patchPrinterIp(printerId, macIp);
        } catch {
          log.error('Both IP and MAC-resolved IP failed, adding job to queue', { printerId, ip: targetIp, macIp, port });
          printQueue.add(printerId, ip, port, data, mac);
          return;
        }
      } else {
        log.error('Status check failed, adding job to queue', { printerId, ip: targetIp, port });
        printQueue.add(printerId, ip, port, data, mac);
        return;
      }
    } else {
      log.error('Status check failed, adding job to queue', { printerId, ip: targetIp, port });
      printQueue.add(printerId, primaryIp, port, data, mac);
      return;
    }
  }

  if (status === "OK" || status === "CARTA_QUASI_FINITA") {
    try {
      await sendToPrinter(targetIp, port, data);
      log.info('Printed successfully', { printerId, ip: targetIp, port });
      // If the printer was not ONLINE in the DB, patch it now that we know it's reachable
      const cached = printers?.find((p) => p.id === printerId);
      if (cached && cached.status !== 'ONLINE') {
        log.info('Printer reachable again, patching status to ONLINE', { printerId, previousStatus: cached.status });
        cached.status = 'ONLINE';
        patchPrinterStatus(printerId, 'ONLINE').catch(() => {});
      }
    } catch (printErr) {
      log.error('Print failed, adding job to queue', { printerId, ip: targetIp, port, error: errorMessage(printErr) });
      printQueue.add(printerId, ip || primaryIp, port, data, mac);
    }
  } else {
    log.warn('Printer not ready, adding job to queue', { printerId, ip: targetIp, port, status });
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

    closureLog.info('Processing general closure', { cashRegisterId });

    const printer = await resolveCashRegisterPrinter(cashRegisterId, printers);
    if (!printer || !printer.ip || !printer.port) {
      closureLog.error('No printer found for cash register', { cashRegisterId });
      return { ok: false, error: "No printer configured for this cash register" };
    }
    const cashRegisterPrinterId = trimStr(printer.id);
    const printerIp = printer.ip;
    const printerPort = printer.port;
    const printerMac = printer.mac;

    closureLog.info('Using cash register printer', { cashRegisterId, printerId: cashRegisterPrinterId, ip: printerIp, port: printerPort });

    // Build closure report receipts
    const receipts = buildGeneralClosureReport(payload);

    closureLog.info('Closure receipts generated', { cashRegisterId, receipts: receipts.length, categoryTickets: receipts.length - 1 });

    // Print all receipts
    for (let i = 0; i < receipts.length; i++) {
      const receipt = receipts[i];
      const receiptType = i === 0 ? "Main Report" : `Category ${i}`;
      closureLog.debug('Printing closure receipt', { cashRegisterId, printerId: cashRegisterPrinterId, receiptType });
      
      await safePrint(
        cashRegisterPrinterId,
        printerIp,
        printerPort,
        receipt,
        printerMac,
        printers
      );
    }

    closureLog.info('General closure report sent to printer', { cashRegisterId, printerId: cashRegisterPrinterId });
    return { ok: true };
  } catch (err: any) {
    closureLog.error('Error processing general closure', { cashRegisterId: payload?.cashRegister, err });
    return { ok: false, error: err.message || "Unknown error" };
  }
}
