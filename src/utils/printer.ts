/**
 * Printer utilities for the `mystampa` service.
 *
 * This module provides helper functions and classes used to
 * communicate with network printers and to build formatted
 * receipts. Receipts are generated as plain text with extra
 * whitespace above and below so that thermal printers advance
 * the paper sufficiently. Two receipt formats are supported:
 *
 *  - A "kitchen" receipt that lists items grouped by food
 *    printer without prices. It includes basic order metadata.
 *  - A "cash" receipt that lists all items with quantities,
 *    notes, per-line totals and the final total minus any
 *    discount. If provided, discounts are shown separately.
 *
 * The sendToPrinter function uses a TCP socket to deliver
 * text directly to a printer's IP and port. All IP/port values
 * are trimmed of surrounding whitespace to avoid errors.
 */

import net from 'net';
import { IncomingOrder } from '../models';

/**
 * Types representing individual lines that will appear on receipts.
 *
 * A {@link KitchenReceiptLine} describes a line on a kitchen
 * receipt. It includes the name of the food, the quantity and an
 * optional note. Kitchen receipts do not display prices.
 */
export interface KitchenReceiptLine {
  foodName: string;
  quantity: number;
  notes?: string | null;
}

/**
 * A {@link CashReceiptLine} describes a line on a fiscal receipt.
 * In addition to the name and quantity it includes the unit
 * price of the item and an optional surcharge. If a surcharge
 * is present it will be printed as an extra price beneath the
 * main line on the fiscal receipt.
 */
export interface CashReceiptLine extends KitchenReceiptLine {
  unitPrice: number;
  surcharge?: number | null;
}

/**
 * Trim any value to a string, removing leading and trailing whitespace.
 * Returns an empty string if the value is null or undefined.
 */
function trimStr(v: any): string {
  return v === null || v === undefined ? '' : String(v).trim();
}

/**
 * Convert a value into a number. Handles strings using both comma
 * and dot as decimal separators. Returns 0 for invalid values.
 */
function toNumber(v: any): number {
  if (v === null || v === undefined) return 0;
  if (typeof v === 'number') return v;
  const s = String(v).trim().replace(',', '.');
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Format a number into a euro currency string with two decimals.
 */
function eur(n: number): string {
  return `€${n.toFixed(2)}`;
}

/**
 * Generate a blank space string consisting of `n` newline characters.
 * Useful for adding padding above or below a receipt.
 */
function blank(n = 6): string {
  return '\n'.repeat(n);
}

/**
 * Build the content of a kitchen receipt. This receipt lists items
 * destined for a kitchen printer grouped by printer and does not
 * include prices. It includes order metadata such as table,
 * customer and confirmation time. Each line contains quantity,
 * food name and optional notes.
 */
export function buildKitchenReceipt(
  order: IncomingOrder,
  lines: KitchenReceiptLine[],
  progress: number
): string {
  const RECEIPT_W = 48;

  const out: string[] = [];

  const repeat = (ch: string, n: number) => ch.repeat(Math.max(0, n));
  const line = (ch = "-") => repeat(ch, RECEIPT_W);
  const cut = (s: string, w: number) => (s.length <= w ? s : s.slice(0, w));

  // ESC/POS size
  const GS = "\x1D";
  const TXT_NORMAL = GS + "!" + "\x00";
  const TXT_BIG = GS + "!" + "\x11"; // 2x width + 2x height

  // =========================
  // HEADER (esattamente come richiesto)
  // =========================
  out.push(cut("===== ORDINE CUCINA =====", RECEIPT_W));
  out.push(line("="));

  const table = trimStr(order.table) || "-";
  const customer = trimStr(order.customer) || "-";

  out.push(TXT_BIG + cut(`TAVOLO: ${table}`, RECEIPT_W) + TXT_NORMAL);
  out.push(TXT_BIG + cut(`CLIENTE: ${customer}`, RECEIPT_W) + TXT_NORMAL);
  out.push(TXT_BIG + cut(`PROGR: ${progress}`, RECEIPT_W) + TXT_NORMAL);

  out.push(line("-"));

  // INFO PICCOLE (separate)
  if (trimStr(order.displayCode)) out.push(cut(`CODICE: ${trimStr(order.displayCode)}`, RECEIPT_W));
  if (trimStr(order.confirmedAt)) out.push(cut(`ORA: ${trimStr(order.confirmedAt)}`, RECEIPT_W));

  out.push(line("-"));

  // =========================
  // ITEMS
  // =========================
  for (const l of lines) {
    const qty = l.quantity ?? 1;
    const name = trimStr(l.foodName) || "FOOD";

    out.push(cut(`${qty}x ${name}`, RECEIPT_W));

    if (l.notes && trimStr(l.notes)) {
      out.push(cut(`  NOTE: ${trimStr(l.notes)}`, RECEIPT_W));
    }

    out.push("");
  }

  out.push(line("-"));
  return out.join("\n");
}


/**
 * Build the content of a cash receipt. This receipt lists all
 * items along with quantities, notes and per-line totals. It
 * includes the final total minus any discount and prints a
 * discount line if provided. Order metadata is included as
 * header information. Prices are assumed to be numbers and may
 * originate from strings in the API.
 */
export function buildCashReceipt(
  order: IncomingOrder,
  lines: CashReceiptLine[],
): string {
  const RECEIPT_W = 48; // <-- 48 (80mm) / 42 o 32 (58mm). Dimmi la tua e lo settiamo perfetto.

  const out: string[] = [];

  const repeat = (ch: string, n: number) => ch.repeat(Math.max(0, n));
  const line = (ch = "-") => repeat(ch, RECEIPT_W);

  const padRight = (s: string, w: number) =>
    s.length >= w ? s : s + repeat(" ", w - s.length);
  const padLeft = (s: string, w: number) =>
    s.length >= w ? s : repeat(" ", w - s.length) + s;

  // Taglia a lunghezza (semplice; se hai caratteri strani/emoji si complica)
  const cut = (s: string, w: number) => (s.length <= w ? s : s.slice(0, w));

  // Riga con testo a sinistra e prezzo a destra, sempre allineato
  const lr = (left: string, right: string) => {
    left = trimStr(left);
    right = trimStr(right);
    const space = 1;
    const leftW = RECEIPT_W - right.length - space;
    const leftCut = cut(left, Math.max(0, leftW));
    return padRight(leftCut, Math.max(0, leftW)) + repeat(" ", space) + right;
  };

  // Formato valuta: 12,34€ (compatta, buona per colonna)
  const eurCol = (n: number) => {
    const v = Number.isFinite(n) ? n : 0;
    const s = v.toFixed(2).replace(".", ",");
    return `${s}€`;
  };

  const blankLines = (n: number) => repeat("\n", Math.max(0, n)).trimEnd(); // oppure usa la tua blank()

  // =========================
  // HEADER
  // =========================
  //out.push(repeat("\n", 3).trimEnd()); // top padding
  out.push(cut("===== SCONTRINO FISCALE =====", RECEIPT_W));
  if (trimStr(order.displayCode))
    out.push(cut(`CODICE: ${trimStr(order.displayCode)}`, RECEIPT_W));
  out.push(cut(`TAVOLO: ${trimStr(order.table) || "-"}`, RECEIPT_W));
  out.push(cut(`CLIENTE: ${trimStr(order.customer) || "-"}`, RECEIPT_W));
  if (trimStr(order.confirmedAt))
    out.push(cut(`ORA: ${trimStr(order.confirmedAt)}`, RECEIPT_W));
  out.push(line("-"));

  // =========================
  // BODY
  // =========================
  let subtotalCalc = 0;
  let surchargeSum = 0;

  for (const l of lines) {
    const qty = l.quantity ?? 1;
    const name = trimStr(l.foodName) || "FOOD NAME NOT FOUND";

    const unitBase = toNumber(l.unitPrice ?? 0);
    const unitExtra = toNumber(l.surcharge ?? 0);

    const rowBase = unitBase * qty;
    const rowExtra = unitExtra * qty;
    const rowTotal = rowBase + rowExtra;

    subtotalCalc += rowBase;
    surchargeSum += rowExtra;

    // Riga principale con totale riga
    out.push(lr(`${qty}x ${name}`, eurCol(rowTotal)));

    const notePresent = !!(l.notes && trimStr(l.notes));
    if (notePresent) {
      out.push(cut(`   NOTE: ${trimStr(l.notes!)}`, RECEIPT_W));
    }

    if (rowExtra > 0) {
      out.push(lr(`   EXTRA`, eurCol(rowExtra)));
    }

    out.push("");
  }

  out.push(line("-"));

  // =========================
  // TOTALI
  // =========================
  const discount = toNumber(order.discount);
  const totalBase = subtotalCalc + surchargeSum;
  const totalAfterDiscount = Math.max(0, totalBase - discount);

  out.push(lr("SUBTOTALE", eurCol(subtotalCalc)));
  if (surchargeSum > 0) out.push(lr("EXTRA TOTALI", eurCol(surchargeSum)));
  if (discount > 0) out.push(lr("SCONTO", `-${eurCol(discount)}`));

  out.push(line("="));
  out.push(lr("TOTALE", eurCol(totalAfterDiscount)));
  out.push(line("="));

  // spazio sotto
  out.push(repeat("\n", 12).trimEnd());

  return out.join("\n");
}


/**
 * Send a string of data to a network printer over TCP. The IP and
 * port are sanitized to remove whitespace and invalid values. The
 * returned promise resolves when the data has been written and
 * the socket closed, and rejects on any connection error.
 */
import iconv from "iconv-lite";

export async function sendToPrinter(
  ip: string,
  port: number,
  data: string
): Promise<void> {

  const ipClean = trimStr(ip);
  const portClean = Number(port);

  if (!ipClean || !Number.isFinite(portClean) || portClean <= 0) {
    throw new Error(`Invalid printer address ip="${ip}" port="${port}"`);
  }

  const ESC = "\x1B";

  // Selezione codepage EURO (CP858)
  const SELECT_CP858 = ESC + "t" + "\x13";

  // Feed fisico + taglio
  const FEED_AND_CUT =
    ESC + "d" + "\x06" +   // feed reale (6 righe)
    ESC + "i";             // cut completo

  const payload = SELECT_CP858 + data + FEED_AND_CUT;
  const bytes = iconv.encode(payload, "cp858");

  return new Promise((resolve, reject) => {
    const client = new net.Socket();

    client.connect(portClean, ipClean, () => {
      client.write(bytes, () => {
        client.end();
        resolve();
      });
    });

    client.on("error", reject);
  });
}
