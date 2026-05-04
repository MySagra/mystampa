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
import fs from 'fs';
import path from 'path';
import iconv from 'iconv-lite';
import { IncomingOrder } from '../models';
import { loadImageAsEscPos } from './image';

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

// Convert UTC date string to Italy local time (DD/MM/YYYY HH:MM).
// Explicit timeZone required: Node.js in Docker runs with TZ=UTC so
// methods like getHours() and Intl without timeZone both return UTC.
function formatLocalDate(dateStr: string): string {
  const d = new Date(dateStr);
  if (isNaN(d.getTime())) return dateStr;
  const fmt = new Intl.DateTimeFormat('it-IT', {
    timeZone: 'Europe/Rome',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = Object.fromEntries(fmt.formatToParts(d).map(({ type, value }) => [type, value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
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
 * Word wraps a string to a specific maximum width.
 * Returns an array of strings, each at most `maxWidth` characters.
 * It attempts to break the string at word boundaries.
 */
function wrapText(text: string, maxWidth: number, indent: string = ''): string[] {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if ((currentLine + word).length > maxWidth) {
      if (currentLine.length > 0) {
        lines.push(currentLine.trimEnd());
      }

      const prefix = lines.length > 0 ? indent : '';
      currentLine = prefix;

      if ((currentLine + word).length > maxWidth) {
        // A single word is longer than the max width, we have to hard split it
        let tempWord = word;
        while ((currentLine + tempWord).length > maxWidth) {
          const cutLen = Math.max(1, maxWidth - currentLine.length);
          lines.push(currentLine + tempWord.substring(0, cutLen));
          tempWord = tempWord.substring(cutLen);
          currentLine = indent;
        }
        currentLine += tempWord + ' ';
      } else {
        currentLine += word + ' ';
      }
    } else {
      currentLine += word + ' ';
    }
  }

  // Se l'ultima riga ha solo l'indentazione (niente testo vero), non la pushiamo
  if (currentLine.trim().length > 0) {
    lines.push(currentLine.trimEnd());
  }

  return lines;
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
  const RECEIPT_W = 48; // Font A su 80mm usa 48 caratteri

  const out: string[] = [];

  const repeat = (ch: string, n: number) => ch.repeat(Math.max(0, n));
  const line = (ch = "-") => repeat(ch, RECEIPT_W);
  const cut = (s: string, w: number) => (s.length <= w ? s : s.slice(0, w));

  // ESC/POS size
  const GS = "\x1D";
  const TXT_NORMAL = GS + "!" + "\x00";
  const TXT_BIG = GS + "!" + "\x11"; // 2x width + 2x height
  const TXT_MEDIUM = GS + "!" + "\x01"; // double height only (slightly bigger)

  // =========================
  // HEADER (esattamente come richiesto)
  // =========================
  out.push("");

  let topInfo = `PROGR: ${progress}`;
  if (trimStr(order.displayCode)) {
    topInfo = `COD: ${trimStr(order.displayCode)} - ${topInfo}`;
  }

  // Aggiunta ORA sulla stessa riga (se c'è spazio, o andrà accapo automaticamente se troppo lungo)
  let timeStr = "";
  if (trimStr(order.confirmedAt)) {
    timeStr = formatLocalDate(order.confirmedAt as string);
  }

  if (timeStr) {
    // Aggiungi la data/ora sulla stessa riga allineata a destra o semplicemente dopo uno spazio
    const timeText = `  ORA: ${timeStr}`;
    if ((topInfo + timeText).length <= RECEIPT_W) {
      // Pad per spingere l'ora verso destra
      const padding = RECEIPT_W - topInfo.length - timeText.length;
      topInfo += " ".repeat(Math.max(1, padding)) + timeText;
    } else {
      // Se non c'è spazio, appendi normalmente
      topInfo += timeText;
    }
  }

  out.push(cut(topInfo, RECEIPT_W));
  out.push(line("="));

  const table = trimStr(order.table) || "-";
  const customer = trimStr(order.customer) || "-";
  const hasTable = order.table !== "NO_TABLE_PRESET";

  // Metti TAVOLO e PROGR sulla stessa riga, se possibile
  const tavProgLine = hasTable ? `N°: ${progress} - TAVOLO: ${table}` : `N°: ${progress}`;
  out.push(TXT_BIG + cut(tavProgLine, Math.floor(RECEIPT_W / 2)) + TXT_NORMAL); // TXT_BIG dimezza i caratteri stampabili sulla riga (circa 24 totali)

  if (customer !== "-") {
    const custLine = `CLIENTE: ${customer}`;
    if (custLine.length <= Math.floor(RECEIPT_W / 2)) {
      // Entra con il font grande (doppia larghezza)
      out.push(TXT_BIG + custLine + TXT_NORMAL);
    } else if (custLine.length <= RECEIPT_W) {
      // Entra con il font normale o solo doppia altezza (TXT_MEDIUM)
      out.push(TXT_MEDIUM + custLine + TXT_NORMAL);
    } else {
      // Troppo lungo, taglia al limite massimo del foglio
      out.push(TXT_MEDIUM + cut(custLine, RECEIPT_W) + TXT_NORMAL);
    }
  }

  if (trimStr(order.displayCode))
    out.push(TXT_MEDIUM + `CODICE: ${trimStr(order.displayCode)}` + TXT_NORMAL);

  out.push(line("-"));

  // =========================
  // ITEMS
  // =========================
  for (const l of lines) {
    const qty = l.quantity ?? 1;
    const name = trimStr(l.foodName) || "FOOD";

    const namePrefix = `${qty}x `;
    const indent = " ".repeat(namePrefix.length);
    const wrappedName = wrapText(namePrefix + name, RECEIPT_W, indent);

    for (const wrapLine of wrappedName) {
      out.push(TXT_MEDIUM + wrapLine + TXT_NORMAL);
    }

    if (l.notes && trimStr(l.notes)) {
      const noteIndent = indent + "  - ";
      // Dividiamo le note per virgola, rimuoviamo gli spazi vuoti e stampiamo ogni nota a capo
      const noteItems = trimStr(l.notes).split(',').map(n => n.trim()).filter(n => n.length > 0);

      for (const note of noteItems) {
        const wrappedNotes = wrapText(`${noteIndent}${note}`, RECEIPT_W, indent + "    ");
        for (const wrapNote of wrappedNotes) {
          out.push(wrapNote);
        }
      }
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
export async function buildCashReceipt(
  order: IncomingOrder,
  lines: CashReceiptLine[],
  singleTickets?: KitchenReceiptLine[]
): Promise<(string | Buffer)[]> {
  const RECEIPT_W = 48; // Font A su 80mm usa 48 caratteri

  const parts: (string | Buffer)[] = [];
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
    left = left === null || left === undefined ? '' : String(left).trimEnd();
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

  // =========================
  // HEADER
  // =========================
  const GS = "\x1D";
  const ESC = "\x1B";
  const TXT_NORMAL = GS + "!" + "\x00";
  const TXT_BIG = GS + "!" + "\x11";
  const BOLD_ON = ESC + "E" + "\x01";
  const BOLD_OFF = ESC + "E" + "\x00";
  
  if (trimStr(order.displayCode))
    out.push(TXT_BIG + BOLD_ON + `Codice Ordine: ${order.displayCode}` + BOLD_OFF + TXT_NORMAL);
  if (trimStr(order.ticketNumber))
    out.push(cut(`NUMERO: ${trimStr(order.ticketNumber)}`, RECEIPT_W));
  if (trimStr(order.table) !== "NO_TABLE_PRESET")
    out.push(cut(`TAVOLO: ${trimStr(order.table) || "-"}`, RECEIPT_W));
  out.push(cut(`CLIENTE: ${trimStr(order.customer) || "-"}`, RECEIPT_W));

  if (trimStr(order.paymentMethod)) {
    let pmStr = trimStr(order.paymentMethod).toUpperCase();
    if (pmStr === 'CASH') pmStr = 'CONTANTI';
    else if (pmStr === 'CARD') pmStr = 'PAGAMENTO ELETTRONICO';

    out.push(cut(`PAGAMENTO: ${pmStr}`, RECEIPT_W));
  }

  if (trimStr(order.confirmedAt)) {
    out.push(cut(`ORA: ${formatLocalDate(order.confirmedAt as string)}`, RECEIPT_W));
  }

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
    // Wrappiamo il testo di sinistra in modo da evitare che sovrascriva spazi 
    // Risolviamo il prezzo a destra sempre sulla prima riga
    const priceStr = eurCol(rowTotal);
    const availableWidthForName = RECEIPT_W - priceStr.length - 1; // 1 per lo spazio minimo

    const namePrefix = `${qty}x `;
    const indent = " ".repeat(namePrefix.length);
    const wrappedNameLines = wrapText(namePrefix + name, availableWidthForName, indent);

    // Prima riga con il prezzo
    out.push(lr(wrappedNameLines[0] || "", priceStr));

    // Righe successive del nome senza prezzo
    for (let i = 1; i < wrappedNameLines.length; i++) {
      out.push(cut(wrappedNameLines[i], RECEIPT_W));
    }

    const notePresent = !!(l.notes && trimStr(l.notes));
    if (notePresent) {
      const noteIndent = indent + "      "; // 6 chars for 'NOTE: '
      const wrappedNotes = wrapText(`${indent}NOTE: ${trimStr(l.notes!)}`, RECEIPT_W, noteIndent);
      for (const wrapNote of wrappedNotes) {
        out.push(wrapNote);
      }
    }

    if (rowExtra > 0) {
      out.push(lr(`${indent}EXTRA`, eurCol(rowExtra)));
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

  // Check for logo
  const possibleLogos = ['logo.png', 'logo.jpg', 'logo.jpeg'];
  for (const lo of possibleLogos) {
    let logoPath = path.join(process.cwd(), 'assets', lo);
    if (!fs.existsSync(logoPath)) {
      logoPath = path.join(process.cwd(), 'default-assets', lo);
    }

    if (fs.existsSync(logoPath)) {
      const logoBuf = await loadImageAsEscPos(logoPath, {
        paperWidth: 576, // 80mm paper requires 576 dots width for centering
        exactWidth: 210 // 30% smaller than 300
      });
      if (logoBuf.length > 0) {
        parts.push(logoBuf);
      } else {
        console.warn(`[Printer] Logo at ${logoPath} returned empty buffer, skipping.`);
      }
      break;
    }
  }

  // Push the main text with padding above to separate from the logo
  // And an extra \n at the end to add a blank line before the footer
  parts.push("\n\n\n" + out.join("\n") + "\n\n");

  // FOOTER (mysagra logo + mysagra.com)
  let mysagraPath = path.join(process.cwd(), 'assets', 'mysagralogo.png');
  if (!fs.existsSync(mysagraPath)) {
    mysagraPath = path.join(process.cwd(), 'default-assets', 'mysagralogo.png');
  }

  let mysagraFooterBuf: Buffer | null = null;
  if (fs.existsSync(mysagraPath)) {
    mysagraFooterBuf = await loadImageAsEscPos(mysagraPath, {
      paperWidth: 576, // 80mm paper requires 576 dots width for centering
      exactHeight: 48, // raddoppiata l'altezza per renderlo più grande
      inlineText: "mysagra.com"
    });
    if (mysagraFooterBuf.length > 0) {
      parts.push(mysagraFooterBuf);
    } else {
      console.warn(`[Printer] Footer image at ${mysagraPath} returned empty buffer, skipping.`);
    }
  }

  // spazio sotto (restored to original behavior which was basically 0 because of trimEnd)
  parts.push(repeat("\n", 12).trimEnd());

  // =========================
  // SINGLE TICKETS
  // =========================
  if (singleTickets && singleTickets.length > 0) {
    const ESC = "\x1B";
    const FEED_AND_CUT = Buffer.from(ESC + "d" + "\x06" + ESC + "i", "ascii");
    const GS = "\x1D";
    const TXT_BIG = GS + "!" + "\x11"; // 2x width + 2x height
    const TXT_NORMAL = GS + "!" + "\x00";

    for (const ticket of singleTickets) {
      parts.push(FEED_AND_CUT);

      const qty = ticket.quantity ?? 1;
      const name = trimStr(ticket.foodName).toUpperCase();

      let ticketStr = `\n\n${TXT_BIG}${qty}x ${name}${TXT_NORMAL}\n`;

      let subTitle = "";
      if (trimStr(order.displayCode)) subTitle += `CODICE: ${trimStr(order.displayCode)}`;
      if (trimStr(order.customer)) {
        if (subTitle) subTitle += ` - `;
        subTitle += `CLIENTE: ${trimStr(order.customer)}`;
      }

      if (subTitle) {
        ticketStr += `${cut(subTitle, RECEIPT_W)}\n`;
      }

      ticketStr += `\n`;
      parts.push(ticketStr);

      if (mysagraFooterBuf && mysagraFooterBuf.length > 0) {
        parts.push(mysagraFooterBuf);
      }
    }
  }

  return parts;
}


/**
 * Send a string of data to a network printer over TCP. The IP and
 * port are sanitized to remove whitespace and invalid values. The
 * returned promise resolves when the data has been written and
 * the socket closed, and rejects on any connection error.
 */
export async function sendToPrinter(
  ip: string,
  port: number,
  data: (string | Buffer)[] | string | Buffer
): Promise<void> {

  const ipClean = trimStr(ip);
  const portClean = Number(port);

  if (!ipClean || !Number.isFinite(portClean) || portClean <= 0) {
    throw new Error(`Invalid printer address ip="${ip}" port="${port}"`);
  }

  const ESC = "\x1B";

  // Selezione codepage EURO (CP858)
  const SELECT_CP858 = Buffer.from(ESC + "t" + "\x13", "ascii");

  // Feed fisico + taglio
  const FEED_AND_CUT = Buffer.from(ESC + "d" + "\x06" + ESC + "i", "ascii"); // Restored feed to 6 exactly as original

  const normalized = Array.isArray(data) ? data : [data];
  const buffers: Buffer[] = [SELECT_CP858];

  for (const item of normalized) {
    if (Buffer.isBuffer(item)) {
      buffers.push(item);
    } else {
      buffers.push(iconv.encode(item, "cp858"));
    }
  }

  buffers.push(FEED_AND_CUT);
  const payload = Buffer.concat(buffers);

  return new Promise((resolve, reject) => {
    const client = new net.Socket();
    let settled = false;

    const overallTimeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        client.destroy();
        reject(new Error(`Timeout: printer ${ipClean}:${portClean} did not respond`));
      }
    }, 5000);

    client.connect(portClean, ipClean, () => {
      client.write(payload, () => {
        clearTimeout(overallTimeout);
        settled = true;
        client.end();
        resolve();
      });
    });

    client.on("error", (err) => {
      clearTimeout(overallTimeout);
      if (!settled) {
        settled = true;
        reject(err);
      }
    });
  });
}

/**
 * Check the printer status (specifically paper status) before printing.
 * Returns "OK", "CARTA_QUASI_FINITA", or "CARTA_FINITA".
 * Throws error if connection fails or timeout.
 */
export async function getPrinterStatus(ip: string, port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new net.Socket();

    // Timeout dopo 3 secondi se la stampante non risponde
    const timeout = setTimeout(() => {
      client.destroy();
      reject(new Error("Timeout: la stampante non risponde"));
    }, 3000);

    const onError = (err: Error) => {
      clearTimeout(timeout);
      client.destroy();
      reject(err);
    };

    client.on("error", onError);

    client.connect(port, ip, () => {
      // Chiediamo lo stato del rotolo di carta (DLE EOT 4)
      const queryStatus = Buffer.from([0x10, 0x04, 0x04]);
      client.write(queryStatus);
    });

    client.on("data", (data) => {
      clearTimeout(timeout);
      const statusByte = data[0];

      // Analisi del byte di risposta (Standard ESC/POS)
      // Bit 5 e 6 indicano se la carta sta finendo o è finita
      const paperEnded = (statusByte & 0x60) === 0x60;
      const paperLow = (statusByte & 0x0C) === 0x0C;

      // Rimuovi il listener prima di destroy per evitare eventi 'error' non gestiti
      client.removeListener("error", onError);
      client.destroy();

      console.log("Carta finita: ", paperEnded);
      console.log("Carta quasi finita: ", paperLow);

      if (paperEnded) resolve("CARTA_FINITA");
      else if (paperLow) resolve("CARTA_QUASI_FINITA");
      else resolve("OK");
    });
  });
}

/**
 * Build a cancellation receipt. Prints a large "ORDINE ANNULLATO" header
 * followed by display code, customer name and table (when present).
 * Sent to every kitchen printer involved in the original order.
 */
export function buildCancellationReceipt(
  displayCode: string | null | undefined,
  customer: string | null | undefined,
  table: string | null | undefined,
): string {
  const RECEIPT_W = 48;
  const out: string[] = [];

  const GS = "\x1D";
  const ESC = "\x1B";
  const TXT_NORMAL = GS + "!" + "\x00";
  const TXT_BIG = GS + "!" + "\x11";
  const TXT_MEDIUM = GS + "!" + "\x01";
  const BOLD_ON = ESC + "E" + "\x01";
  const BOLD_OFF = ESC + "E" + "\x00";

  const repeat = (ch: string, n: number) => ch.repeat(Math.max(0, n));
  const line = (ch = "-") => repeat(ch, RECEIPT_W);
  const cut = (s: string, w: number) => (s.length <= w ? s : s.slice(0, w));

  out.push("");
  out.push(line("="));
  out.push(TXT_BIG + BOLD_ON + "ORDINE ANNULLATO" + BOLD_OFF + TXT_NORMAL);
  out.push(line("="));
  out.push("");

  if (trimStr(displayCode)) {
    out.push(TXT_MEDIUM + `CODICE: ${trimStr(displayCode)}` + TXT_NORMAL);
  }

  const customerStr = trimStr(customer);
  if (customerStr) {
    out.push(TXT_MEDIUM + cut(`CLIENTE: ${customerStr}`, RECEIPT_W) + TXT_NORMAL);
  }

  const tableStr = trimStr(table);
  if (tableStr && tableStr !== "NO_TABLE_PRESET") {
    out.push(TXT_MEDIUM + `TAVOLO: ${tableStr}` + TXT_NORMAL);
  }

  out.push("");
  out.push(line("-"));

  return out.join("\n");
}

/**
 * Build a closure report receipt with general statistics and category breakdowns.
 * Returns an array of parts where the first element is the main report and subsequent
 * elements are individual category tickets.
 */
export function buildGeneralClosureReport(reportData: any): (string | Buffer)[][] {
  const RECEIPT_W = 48;
  const receipts: (string | Buffer)[][] = [];

  const repeat = (ch: string, n: number) => ch.repeat(Math.max(0, n));
  const line = (ch = "-") => repeat(ch, RECEIPT_W);
  const cut = (s: string, w: number) => (s.length <= w ? s : s.slice(0, w));
  const padRight = (s: string, w: number) =>
    s.length >= w ? s : s + repeat(" ", w - s.length);

  const lr = (left: string, right: string) => {
    left = String(left).trimEnd();
    right = String(right).trim();
    const space = 1;
    const leftW = RECEIPT_W - right.length - space;
    const leftCut = cut(left, Math.max(0, leftW));
    return padRight(leftCut, Math.max(0, leftW)) + repeat(" ", space) + right;
  };

  const eur = (n: number) => {
    const v = Number.isFinite(n) ? n : 0;
    return `€${v.toFixed(2).replace(".", ",")}`;
  };

  const GS = "\x1D";
  const ESC = "\x1B";
  const TXT_NORMAL = GS + "!" + "\x00";
  const TXT_BIG = GS + "!" + "\x11";
  const TXT_MEDIUM = GS + "!" + "\x01";
  const BOLD_ON = ESC + "E" + "\x01";
  const BOLD_OFF = ESC + "E" + "\x00";

  // =========================
  // MAIN REPORT
  // =========================
  const mainOut: string[] = [];
  const report = reportData.report;

  mainOut.push("");
  mainOut.push(TXT_BIG + BOLD_ON + "CHIUSURA GENERALE" + BOLD_OFF + TXT_NORMAL);
  mainOut.push(line("="));

  // Format timestamp
  if (report.timestamp) {
    mainOut.push(cut(`DATA: ${formatLocalDate(report.timestamp)}`, RECEIPT_W));
  }

  mainOut.push(line("-"));
  mainOut.push(TXT_MEDIUM + BOLD_ON + "RIEPILOGO GENERALE" + BOLD_OFF + TXT_NORMAL);
  mainOut.push(line("-"));

  mainOut.push(lr("Totale Ordini:", String(report.totalOrders || 0)));
  mainOut.push(lr("Incasso Totale:", eur(report.totalRevenue || 0)));
  mainOut.push(lr("Incasso Contanti:", eur(report.totalCashRevenue || 0)));
  mainOut.push(lr("Incasso Elettronico:", eur(report.totalCardRevenue || 0)));

  // Cash Register Stats
  if (report.cashRegisterStats && report.cashRegisterStats.length > 0) {
    mainOut.push("");
    mainOut.push(line("="));
    mainOut.push(TXT_MEDIUM + BOLD_ON + "STATISTICHE PER CASSA" + BOLD_OFF + TXT_NORMAL);
    mainOut.push(line("="));

    for (const crStat of report.cashRegisterStats) {
      mainOut.push("");
      mainOut.push(BOLD_ON + cut(crStat.cashRegisterName || "Cassa", RECEIPT_W) + BOLD_OFF);
      mainOut.push(line("-"));
      mainOut.push(lr("Totale:", eur(crStat.totalRevenue || 0)));
      mainOut.push(lr("Contanti:", eur(crStat.totalCashRevenue || 0)));
      mainOut.push(lr("Elettronico:", eur(crStat.totalCardRevenue || 0)));
    }
  }

  // Category Stats
  if (report.categoryStats && report.categoryStats.length > 0) {
    mainOut.push("");
    mainOut.push(line("="));
    mainOut.push(TXT_MEDIUM + BOLD_ON + "STATISTICHE PER CATEGORIA" + BOLD_OFF + TXT_NORMAL);
    mainOut.push(line("="));

    for (const catStat of report.categoryStats) {
      mainOut.push(lr(cut((catStat.categoryName || "Categoria").toUpperCase(), RECEIPT_W - 10), eur(catStat.revenue || 0)));
    }
  }

  mainOut.push("");
  mainOut.push(line("="));
  mainOut.push("");

  receipts.push(["\n\n" + mainOut.join("\n") + "\n\n"]);

  // =========================
  // CATEGORY TICKETS
  // =========================
  if (report.categoryStats && report.categoryStats.length > 0) {
    for (const catStat of report.categoryStats) {
      const catOut: string[] = [];

      const catQty = catStat.quantity || 0;
      const catName = (catStat.categoryName || "Categoria").toUpperCase();

      catOut.push("");
      catOut.push(TXT_BIG + BOLD_ON + `${catQty}x ${catName}` + BOLD_OFF + TXT_NORMAL);
      catOut.push(line("="));

      if (catStat.foodStats && catStat.foodStats.length > 0) {
        catOut.push("");
        catOut.push(line("-"));
        catOut.push(BOLD_ON + "DETTAGLIO PRODOTTI" + BOLD_OFF);
        catOut.push(line("-"));

        for (const foodStat of catStat.foodStats) {
          catOut.push("");
          catOut.push(cut(`${foodStat.quantity || 0}x ${foodStat.foodName || "Prodotto"}`, RECEIPT_W));
        }
      }

      catOut.push("");
      catOut.push(line("="));
      catOut.push("");

      receipts.push(["\n\n" + catOut.join("\n") + "\n\n"]);
    }
  }

  return receipts;
}
