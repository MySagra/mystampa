/**
 * Entry point for the mystampa service written in TypeScript.
 *
 * The service authenticates against an external API, fetches printers,
 * caches them in memory, and listens for SSE events to process print
 * jobs. It also serves EJS pages for login and configuration.
 */

import express, { Request, Response } from 'express';
import axios from 'axios';
import axiosInstance from './utils/axiosInstance';
import cookieParser from 'cookie-parser';
import net from 'net';
import path from 'path';
import fs from 'fs';
import dotenv from 'dotenv';
import { Printer } from './models';
import { handlePrintOrder, handleOrderCancelled } from './routes/print';
import { handleGeneralClosure } from './routes/closure';
import { sendDrawerOpen } from './utils/printer';
import { resolveEffectiveIp, resolveIpFromMac } from './utils/arp';
import { patchPrinterIp, patchPrinterStatus } from './utils/api';


dotenv.config();

if (!process.env.API_KEY) {
  console.error('[Config] FATAL: API_KEY env var not set. Set it in .env or environment and restart.');
  process.exit(1);
}

// Configuration variables with defaults
const API_URL: string = process.env.API_URL || 'http://localhost:4300';
const API_KEY: string = process.env.API_KEY;
const PORT = 3032;


// In‑memory cache
let printers: Printer[] = [];

/**
 * Connect to a Server‑Sent Events (SSE) endpoint and process incoming
 * events by calling handlePrintOrder directly. This allows the service
 * to process orders pushed by a backend without requiring HTTP calls.
 */
async function startSSE(): Promise<void> {
  const url = `${API_URL}/events/printer`;
  const BASE_DELAY_MS = 5_000;
  const MAX_DELAY_MS = 120_000;
  const CONNECT_TIMEOUT_MS = 30_000;
  const MAX_BUFFER_SIZE = 1024 * 1024; // 1 MB guard against malformed/huge events
  let attempt = 0;

  // Infinite retry loop with exponential backoff — never gives up
  while (true) {
    if (attempt > 0) {
      const delay = Math.min(BASE_DELAY_MS * Math.pow(2, attempt - 1), MAX_DELAY_MS);
      console.log(`SSE: retry ${attempt} in ${delay / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    attempt++;
    console.log(`SSE: connecting to ${url} (attempt ${attempt})`);

    const controller = new AbortController();
    // Abort if the server accepts the TCP connection but never sends HTTP headers
    const connectTimeout = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: {
          Accept: 'text/event-stream',
          'X-API-KEY': API_KEY,
        },
      });
      clearTimeout(connectTimeout); // headers received — connection established

      if (!response.ok || !response.body) {
        console.error(`SSE connection failed: ${response.status} ${response.statusText}`);
      } else {
        console.log('SSE connected successfully');
        attempt = 0; // reset backoff counter on successful connection

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Guard against unbounded buffer growth from malformed events
            if (buffer.length > MAX_BUFFER_SIZE) {
              console.error('SSE: buffer exceeded limit (malformed event?), resetting connection');
              break;
            }

            const lines = buffer.split('\n');
            buffer = lines.pop() ?? '';

            let eventType = '';
            let eventData = '';

            for (const line of lines) {
              if (line.startsWith('event:')) {
                eventType = line.slice(6).trim();
              } else if (line.startsWith('data:')) {
                const chunk = line.slice(5).trim();
                eventData = eventData ? eventData + '\n' + chunk : chunk;
              } else if (line === '') {
                if (eventData) {
                  try {
                    const payload = JSON.parse(eventData);
                    console.log(`SSE received event (type=${eventType}):`, payload);

                    if (eventType === 'confirmed-order' || eventType === 'reprint-order') {
                      const order = payload.createdOrder ?? payload;
                      const result = await handlePrintOrder(order, printers);
                      if (result.ok) {
                        console.log('SSE: print order handled successfully', result);
                      } else {
                        console.error('SSE: print order failed:', result.error);
                      }
                    } else if (eventType === 'order-cancelled') {
                      const result = await handleOrderCancelled(payload, printers);
                      if (result.ok) {
                        console.log('SSE: order cancellation handled successfully', result);
                      } else {
                        console.error('SSE: order cancellation failed:', result.error);
                      }
                    } else if (eventType === 'general-closure') {
                      const result = await handleGeneralClosure(payload, printers);
                      if (result.ok) {
                        console.log('SSE: general closure handled successfully', result);
                      } else {
                        console.error('SSE: general closure failed:', result.error);
                      }
                    } else if (eventType === 'open-drawer') {
                      const printerId = payload.printerId;
                      const pr = printers.find(p => p.id === printerId);
                      if (pr) {
                        sendDrawerOpen(pr.ip, pr.port).catch(err => {
                          console.warn(`SSE: drawer open failed for ${printerId}:`, err.message);
                        });
                      } else {
                        console.warn(`SSE: no printer found for open-drawer printerId=${printerId}`);
                      }
                    } else {
                      console.log(`SSE: ignoring event type '${eventType}'`);
                    }
                  } catch (err) {
                    console.error('SSE: failed to handle event', err);
                  }
                }
                eventType = '';
                eventData = '';
              }
            }
          }
        } finally {
          // Always release the reader to avoid resource leaks
          reader.cancel().catch(() => {});
        }

        console.log('SSE connection closed, will reconnect');
      }
    } catch (err) {
      clearTimeout(connectTimeout);
      console.error('SSE: connection error:', err);
    }
  }
}

/**
 * Fetch printers list using the API key.
 */
async function fetchPrinters(): Promise<Printer[]> {
  try {
    const resp = await axiosInstance.get(`${API_URL}/v1/printers`, {
      headers: {
        Accept: 'application/json',
        'X-API-KEY': API_KEY,
      },
    });
    const list: Printer[] = (resp.data as any[]).map(Printer.fromJson);
    return list;
  } catch (err: any) {
    console.error('Fetching printers failed:', err.message);
    return [];
  }
}

/**
 * Initialize by fetching printers. The data
 * is stored in module‑level variables and logged to console.
 */
async function initialize(): Promise<void> {
  // Initial fetch
  printers = await fetchPrinters();
  console.log('Initialization complete. Printers:', JSON.stringify(printers, null, 2));
  runPrinterStatusCheck();

  // Refresh printers every 2 minutes (120000 ms).
  // Guard flag prevents concurrent executions if a cycle takes longer than the interval.
  let isUpdatingPrinters = false;
  setInterval(async () => {
    if (isUpdatingPrinters) return;
    isUpdatingPrinters = true;
    try {
      printers = await fetchPrinters();
      console.log('Printers updated via polling.');
      await runPrinterStatusCheck();
    } catch (e) {
      console.error('Failed to update printers:', e);
    } finally {
      isUpdatingPrinters = false;
    }
  }, 120000);

  startSSE().catch((err) => {
    console.error('Error starting SSE listener:', err);
  });
}

/**
 * Probe a printer TCP socket to determine its real status.
 *
 * - If the TCP connection fails → OFFLINE
 * - If connected → sends ESC/POS DLE EOT 4 (0x10 0x04 0x04) to query
 *   paper roll status. If bit 5 or 6 of the response byte is set,
 *   the printer has no paper → ERROR. Otherwise → ONLINE.
 * - If the printer does not reply (e.g. non-ESC/POS device) we assume ONLINE.
 */
function probePrinterStatusOnce(ip: string, port: number, timeoutMs = 3000): Promise<'ONLINE' | 'OFFLINE' | 'ERROR'> {
  return new Promise((resolve) => {
    if (!ip || !port || isNaN(port)) {
      resolve('OFFLINE');
      return;
    }
    const socket = new net.Socket();
    let resolved = false;
    let responseData = Buffer.alloc(0);

    const finish = (status: 'ONLINE' | 'OFFLINE' | 'ERROR') => {
      if (!resolved) {
        resolved = true;
        socket.destroy();
        resolve(status);
      }
    };

    socket.setTimeout(timeoutMs);
    socket.connect(port, ip, () => {
      // TCP connected — query paper roll sensor status via ESC/POS DLE EOT 4
      socket.write(Buffer.from([0x10, 0x04, 0x04]));
      // Give the printer up to 500 ms to respond
      setTimeout(() => {
        if (responseData.length > 0) {
          const byte = responseData[0];
          // Bit 5 e 6 entrambi settati (0x60) → carta finita (allineato con getPrinterStatus)
          const paperEnded = (byte & 0x60) === 0x60;
          // Bit 2 e 3 entrambi settati (0x0C) → carta quasi finita, ma ancora funzionante
          const paperLow = (byte & 0x0C) === 0x0C;
          if (paperEnded) {
            finish('ERROR'); // paper out
          } else if (paperLow) {
            finish('ONLINE'); // carta bassa, ma la stampante è ancora funzionante
          } else {
            finish('ONLINE');
          }
        } else {
          // No ESC/POS response — TCP reachable, assume ONLINE
          finish('ONLINE');
        }
      }, 500);
    });

    socket.on('data', (chunk) => {
      responseData = Buffer.concat([responseData, chunk]);
    });

    socket.on('error', () => finish('OFFLINE'));
    socket.on('timeout', () => finish('OFFLINE'));
  });
}

/**
 * Probe all cached printers and update their status.
 *
 * - ERROR (paper out): always PATCH immediately so the backend is
 *   notified as fast as possible regardless of the previous state.
 * - ONLINE / OFFLINE: only PATCH when the status has actually changed
 *   from the previous known state to avoid unnecessary API calls.
 */
async function runPrinterStatusCheck(): Promise<void> {
  if (printers.length === 0) return;
  console.log(`Printer status check: probing ${printers.length} printer(s)...`);
  for (const printer of printers) {
    const primaryIp = resolveEffectiveIp(printer.ip, printer.mac) ?? printer.ip;
    let probed = await probePrinterStatusOnce(primaryIp, printer.port);

    // If OFFLINE and we have both IP and MAC, the IP may have changed (DHCP).
    // Try resolving the current IP from the ARP table and retry once.
    if (probed === 'OFFLINE' && printer.mac && printer.ip) {
      const macIp = resolveIpFromMac(printer.mac);
      if (macIp && macIp !== primaryIp) {
        console.log(`Printer "${printer.name}": IP ${primaryIp} offline, retrying with MAC-resolved IP ${macIp}`);
        probed = await probePrinterStatusOnce(macIp, printer.port);
        if (probed !== 'OFFLINE') {
          // IP changed — update DB and in-memory record
          console.log(`Printer "${printer.name}": IP updated ${printer.ip} → ${macIp}`);
          printer.ip = macIp;
          await patchPrinterIp(printer.id, macIp);
        }
      }
    }

    const addr = printer.mac ? `MAC:${printer.mac} (${printer.ip})` : `${printer.ip}:${printer.port}`;
    if (probed === 'ERROR') {
      console.log(`Printer "${printer.name}" (${addr}): paper out → ERROR`);
      printer.status = 'ERROR';
      await patchPrinterStatus(printer.id, 'ERROR');
    } else if (probed !== printer.status) {
      console.log(`Printer "${printer.name}" (${addr}): ${printer.status} → ${probed}`);
      printer.status = probed;
      await patchPrinterStatus(printer.id, probed);
    } else {
      console.log(`Printer "${printer.name}" (${addr}): ${probed} (no change)`);
    }
  }
}

// Kick off initialization asynchronously. Errors are logged.
initialize().catch((err) => console.error('Initialization error:', err));

// Load saved config from config.json to populate env for print handler
const CONFIG_FILE = path.join(process.cwd(), 'data', 'config.json');
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const savedConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    if (savedConfig.singleTicketCategories) {
      process.env.SINGLE_TICKET_CATEGORIES = savedConfig.singleTicketCategories.join(',');
      console.log('Loaded single ticket categories from config.json');
    }
    if (savedConfig.stationTicketsEnabled !== undefined) {
      process.env.STATION_TICKETS_ENABLED = savedConfig.stationTicketsEnabled ? 'true' : 'false';
      console.log('Loaded stationTicketsEnabled from config.json:', savedConfig.stationTicketsEnabled);
    }
  }
} catch (e) {
  console.error('Failed to load config.json on startup:', e);
}

// Configure Express
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Serve static files
const assetsDir = path.join(process.cwd(), 'assets');
app.use('/assets', express.static(assetsDir));
const publicDir = path.join(process.cwd(), 'public');
app.use('/public', express.static(publicDir));

// Configure EJS as view engine
// Views live in src/views and are not copied by tsc, so resolve from project root
app.set('view engine', 'ejs');
const viewsDir = path.join(__dirname, 'views');
// If running from dist/, views won't exist there — fall back to src/views
if (!fs.existsSync(viewsDir)) {
  app.set('views', path.join(__dirname, '..', 'src', 'views'));
} else {
  app.set('views', viewsDir);
}

// --- Web Routes ---

/**
 * GET / - Login page
 */
app.get('/', (req: Request, res: Response) => {
  // If already authenticated via cookie, redirect to config
  const token = req.cookies?.mystampa_session;
  if (token) {
    return res.redirect('/config');
  }
  res.render('login', { error: null });
});

const ALLOWED_ROLES = ['admin', 'maintainer'];

/**
 * Check that the request has a valid session cookie and an allowed role cookie.
 * Returns true if authorized, false otherwise.
 */
function isAuthorized(req: Request): boolean {
  const token = req.cookies?.mystampa_session;
  const role = req.cookies?.mystampa_role;
  return !!(token && role && ALLOWED_ROLES.includes(role));
}

/**
 * POST /login - Handle login form submission
 */
app.post('/login', async (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.render('login', { error: 'Username e Password sono obbligatori' });
  }

  try {
    // Use plain axios to avoid the retry interceptor — fail immediately on wrong credentials
    const resp = await axios.post(`${API_URL}/auth/login`, { username, password }, {
      timeout: 10000,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    });

    const setCookieHeader = resp.headers['set-cookie'];
    let tokenValue: string | undefined;
    if (setCookieHeader) {
      const cookieHeaders = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
      for (const c of cookieHeaders) {
        // Match the token name allowing optional spaces around = and before ;
        const match = c.match(/(?:^|;)\s*mysagra_token\s*=\s*([^;]*)/);
        if (match) { tokenValue = match[1].trim(); break; }
      }
    }

    if (!tokenValue) {
      return res.render('login', { error: 'Login riuscito ma token non trovato nella risposta' });
    }

    const role: string = resp.data?.role ?? '';
    if (!ALLOWED_ROLES.includes(role)) {
      return res.render('login', { error: 'Accesso negato: ruolo non autorizzato' });
    }

    const cookieOptions = {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax' as const,
      maxAge: 6 * 60 * 60 * 1000,
    };
    res.cookie('mystampa_session', tokenValue, cookieOptions);
    res.cookie('mystampa_role', role, cookieOptions);

    return res.redirect('/config');
  } catch (err: any) {
    const status = err.response?.status;
    if (status === 401) return res.render('login', { error: 'Credenziali non valide' });
    return res.render('login', { error: 'Errore durante il login' });
  }
});

/**
 * GET /config - Configuration page (requires admin or maintainer role)
 */
app.get('/config', (req: Request, res: Response) => {
  if (!req.cookies?.mystampa_session) {
    return res.redirect('/');
  }
  if (!isAuthorized(req)) {
    return res.status(403).render('login', { error: 'Accesso negato: ruolo non autorizzato' });
  }
  res.render('config');
});

// --- API Routes for config page ---

/**
 * Read the config file asynchronously. Returns default empty config if file doesn't exist.
 */
interface AppConfig {
  singleTicketCategories: string[];
  stationTicketsEnabled: boolean;
}

async function readConfig(): Promise<AppConfig> {
  try {
    await fs.promises.access(CONFIG_FILE);
    const raw = await fs.promises.readFile(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return {
      singleTicketCategories: parsed.singleTicketCategories ?? [],
      stationTicketsEnabled: parsed.stationTicketsEnabled ?? false,
    };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error('Failed to read config file:', e);
    }
  }
  return { singleTicketCategories: [], stationTicketsEnabled: false };
}

async function writeConfig(config: AppConfig): Promise<void> {
  await fs.promises.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
  await fs.promises.writeFile(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  process.env.SINGLE_TICKET_CATEGORIES = config.singleTicketCategories.join(',');
  process.env.STATION_TICKETS_ENABLED = config.stationTicketsEnabled ? 'true' : 'false';
}

/**
 * GET /api/categories - Fetch categories from external API
 */
app.get('/api/categories', async (req: Request, res: Response) => {
  const token = req.cookies?.mystampa_session;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  if (!isAuthorized(req)) return res.status(403).json({ error: 'Forbidden' });
  try {
    const resp = await axios.get(`${API_URL}/v1/categories`, {
      timeout: 10000,
      headers: { Accept: 'application/json', Cookie: `mysagra_token=${token}` },
    });
    return res.json(resp.data);
  } catch (err: any) {
    console.error('Failed to fetch categories:', err.message);
    return res.status(502).json({ error: 'Failed to fetch categories' });
  }
});

/**
 * GET /api/printers - Return in-memory printers list with live status
 */
app.get('/api/printers', (req: Request, res: Response) => {
  if (!req.cookies?.mystampa_session) return res.status(401).json({ error: 'Not authenticated' });
  if (!isAuthorized(req)) return res.status(403).json({ error: 'Forbidden' });
  return res.json(printers.map((p) => ({
    id: p.id,
    name: p.name,
    ip: p.ip,
    mac: p.mac,
    port: p.port,
    description: p.description,
    status: p.status,
  })));
});

/**
 * GET /api/config - Get current config
 */
app.get('/api/config', async (req: Request, res: Response) => {
  if (!req.cookies?.mystampa_session) return res.status(401).json({ error: 'Not authenticated' });
  if (!isAuthorized(req)) return res.status(403).json({ error: 'Forbidden' });
  return res.json(await readConfig());
});

/**
 * POST /api/config - Save config
 */
app.post('/api/config', async (req: Request, res: Response) => {
  if (!req.cookies?.mystampa_session) return res.status(401).json({ error: 'Not authenticated' });
  if (!isAuthorized(req)) return res.status(403).json({ error: 'Forbidden' });
  const { singleTicketCategories, stationTicketsEnabled } = req.body;
  if (!Array.isArray(singleTicketCategories)) {
    return res.status(400).json({ error: 'singleTicketCategories must be an array' });
  }
  const current = await readConfig();
  const config: AppConfig = {
    singleTicketCategories,
    stationTicketsEnabled: stationTicketsEnabled !== undefined ? Boolean(stationTicketsEnabled) : current.stationTicketsEnabled,
  };
  try {
    await writeConfig(config);
  } catch (e) {
    console.error('Failed to write config:', e);
    return res.status(500).json({ error: 'Failed to save config' });
  }
  return res.json({ ok: true, config });
});

/**
 * POST /logout - Clear session and redirect to login
 */
app.post('/logout', (_req: Request, res: Response) => {
  res.clearCookie('mystampa_session');
  res.clearCookie('mystampa_role');
  res.redirect('/');
});

// Start listening
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});