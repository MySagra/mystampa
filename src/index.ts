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
import dotenv from 'dotenv';
import { Printer } from './models';
import { handlePrintOrder } from './routes/print';

// Import the SSE client. This library allows connection to Server‑Sent
// Events endpoints from Node.js.
import { fetchEventSource } from '@microsoft/fetch-event-source';

dotenv.config();

// Configuration variables with defaults
const EXTERNAL_BASE_URL: string = process.env.EXTERNAL_BASE_URL || 'http://localhost:4300';
const ADMIN_USERNAME: string = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD: string = process.env.ADMIN_PASSWORD || 'admin';
const PORT: number = process.env.PORT ? parseInt(process.env.PORT) : 3032;

// When USE_SSE is set to 'true' or 'sse', the service will subscribe to an
// SSE stream. The endpoint for the event source can be configured via SSE_URL.
const USE_SSE: boolean = (process.env.USE_SSE || '').toLowerCase() === 'true' || (process.env.USE_SSE || '').toLowerCase() === 'sse';
const SSE_URL: string = process.env.SSE_URL || 'http://localhost:3001/events/cashier';

// Types for login response
interface LoginUser {
  id: string;
  username: string;
  role: string;
}

// In‑memory caches
let loggedUser: LoginUser | null = null;
let printers: Printer[] = [];

/**
 * Connect to a Server‑Sent Events (SSE) endpoint and process incoming
 * events by calling handlePrintOrder directly. This allows the service
 * to process orders pushed by a backend without requiring HTTP calls.
 */
async function startSSE(): Promise<void> {
  const url = SSE_URL;
  const MAX_RETRIES = 6;
  const RETRY_DELAY_MS = 30_000;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      console.log(`SSE: retry ${attempt}/${MAX_RETRIES} in ${RETRY_DELAY_MS / 1000}s...`);
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }

    const cookie: string | undefined = (global as any).__AUTH_COOKIE;
    console.log(`SSE: connecting to ${url} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`);

    let closedNormally = false;

    try {
      await fetchEventSource(url, {
        openWhenHidden: true,
        method: 'GET',
        fetch: fetch,
        headers: {
          Accept: 'text/event-stream',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        async onopen(response) {
          if (response.ok) {
            console.log('SSE connected successfully');
          } else {
            console.error('SSE connection failed:', response.status, response.statusText);
          }
        },
        async onmessage(event) {
          try {
            if (!event.data) return;
            const payload = JSON.parse(event.data);
            const eventType = event.event ?? '';
            console.log(`SSE received event (type=${eventType}):`, payload);

            if (eventType === 'confirmed-order' || eventType === 'reprint-order') {
              // Call the print handler directly instead of making an HTTP request
              const result = await handlePrintOrder(payload, printers);
              if (result.ok) {
                console.log(`SSE: print order handled successfully`, result);
              } else {
                console.error(`SSE: print order failed:`, result.error);
              }
            } else {
              console.log(`SSE: ignoring event type '${eventType}'`);
            }
          } catch (err) {
            console.error('SSE: failed to handle event', err);
          }
        },
        onclose() {
          console.log('SSE connection closed');
          closedNormally = true;
        },
        onerror(err) {
          console.error('SSE error:', err);
          throw err;
        },
      });
    } catch (err) {
      console.error('SSE: connection lost:', err);
    }

    if (attempt < MAX_RETRIES) {
      console.log(`SSE: will retry (${attempt + 1}/${MAX_RETRIES} retries used)`);
    } else {
      console.error('SSE: max retries reached, giving up reconnection attempts');
    }
  }
}

/**
 * Perform login against the external API.
 * Returns the user object and stores the mysagra_token cookie globally.
 */
async function login(): Promise<LoginUser | null> {
  try {
    const resp = await axiosInstance.post<LoginUser>(`${EXTERNAL_BASE_URL}/auth/login`, {
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
    }, {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });

    // Extract mysagra_token from the Set-Cookie header
    const setCookieHeader = resp.headers['set-cookie'];
    let authCookie: string | undefined;
    if (setCookieHeader) {
      const cookies = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
      for (const c of cookies) {
        const match = c.match(/mysagra_token=([^;]+)/);
        if (match) {
          authCookie = `mysagra_token=${match[1]}`;
          break;
        }
      }
    }

    if (!authCookie) {
      console.error('Login succeeded but mysagra_token cookie not found in response.');
      return null;
    }

    // Store the cookie for use in subsequent API calls
    (global as any).__AUTH_COOKIE = authCookie;
    console.log('Login successful. mysagra_token cookie stored.');
    return resp.data;
  } catch (err: any) {
    console.error('Login failed:', err.message);
    return null;
  }
}

/**
 * Fetch printers list using the stored auth cookie.
 */
async function fetchPrinters(): Promise<Printer[]> {
  const cookie: string | undefined = (global as any).__AUTH_COOKIE;
  try {
    const resp = await axiosInstance.get(`${EXTERNAL_BASE_URL}/v1/printers`, {
      headers: {
        Accept: 'application/json',
        ...(cookie ? { Cookie: cookie } : {}),
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
 * Initialize by logging in and fetching printers. The data
 * is stored in module‑level variables and logged to console.
 */
async function initialize(): Promise<void> {
  loggedUser = await login();
  if (!loggedUser) {
    console.error('Unable to authenticate; printers will not be loaded.');
    return;
  }
  console.log(`Logged in as: ${loggedUser.username} (role: ${loggedUser.role})`);

  // Initial fetch
  printers = await fetchPrinters();
  console.log('Initialization complete. Printers:', JSON.stringify(printers, null, 2));
  runPrinterStatusCheck();

  // Refresh printers every 2 minutes (120000 ms)
  setInterval(async () => {
    try {
      printers = await fetchPrinters();
      console.log('Printers updated via polling.');
      await runPrinterStatusCheck();
    } catch (e) {
      console.error('Failed to update printers:', e);
    }
  }, 120000);

  // If SSE mode is enabled, start listening for events.
  if (USE_SSE) {
    startSSE().catch((err) => {
      console.error('Error starting SSE listener:', err);
    });
  }
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
function probePrinterStatus(ip: string, port: number, timeoutMs = 3000): Promise<'ONLINE' | 'OFFLINE' | 'ERROR'> {
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
          // Bits 5-6 (mask 0x60) indicate no paper present
          if ((byte & 0x60) !== 0) {
            finish('ERROR'); // paper out
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
 * Patch the printer status on the external API using the service-level
 * admin cookie (from .env credentials), NOT the web UI session.
 */
async function patchPrinterStatus(printerId: string, status: 'ONLINE' | 'OFFLINE' | 'ERROR'): Promise<void> {
  const cookie: string | undefined = (global as any).__AUTH_COOKIE;
  if (!cookie) {
    console.warn(`patchPrinterStatus: no auth cookie available, skipping PATCH for printer ${printerId}`);
    return;
  }
  try {
    await axiosInstance.patch(
      `${EXTERNAL_BASE_URL}/v1/printers/${printerId}`,
      { status },
      {
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          Cookie: cookie,
        },
      }
    );
    console.log(`patchPrinterStatus: printer ${printerId} → ${status}`);
  } catch (err: any) {
    console.error(`patchPrinterStatus: failed for printer ${printerId}:`, err.message);
  }
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
    const probed = await probePrinterStatus(printer.ip, printer.port);
    if (probed === 'ERROR') {
      // Paper out — always notify the backend immediately
      console.log(`Printer "${printer.name}" (${printer.ip}:${printer.port}): paper out → ERROR`);
      printer.status = 'ERROR';
      await patchPrinterStatus(printer.id, 'ERROR');
    } else if (probed !== printer.status) {
      // ONLINE / OFFLINE changed — notify the backend
      console.log(`Printer "${printer.name}" (${printer.ip}:${printer.port}): ${printer.status} → ${probed}`);
      printer.status = probed;
      await patchPrinterStatus(printer.id, probed);
    } else {
      console.log(`Printer "${printer.name}" (${printer.ip}:${printer.port}): ${probed} (no change)`);
    }
  }
}

// Kick off initialization asynchronously. Errors are logged.
initialize().catch((err) => console.error('Initialization error:', err));

// Load saved config from config.json to populate env for print handler
const fsSync = require('fs');
const CONFIG_FILE = path.join(process.cwd(), 'config.json');
try {
  if (fsSync.existsSync(CONFIG_FILE)) {
    const savedConfig = JSON.parse(fsSync.readFileSync(CONFIG_FILE, 'utf-8'));
    if (savedConfig.singleTicketCategories) {
      process.env.SINGLE_TICKET_CATEGORIES = savedConfig.singleTicketCategories.join(',');
      console.log('Loaded single ticket categories from config.json');
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

// Serve static files from assets directory
const assetsDir = path.join(process.cwd(), 'assets');
app.use('/assets', express.static(assetsDir));

// Configure EJS as view engine
// Views live in src/views and are not copied by tsc, so resolve from project root
app.set('view engine', 'ejs');
const viewsDir = path.join(__dirname, 'views');
// If running from dist/, views won't exist there — fall back to src/views
if (!fsSync.existsSync(viewsDir)) {
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

/**
 * POST /login - Handle login form submission
 */
app.post('/login', async (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.render('login', { error: 'Username e Password sono obbligatori' });
  }

  try {
    // Use plain axios (not axiosInstance) to avoid the retry interceptor.
    // The web login should fail immediately on wrong credentials.
    const resp = await axios.post(`${EXTERNAL_BASE_URL}/auth/login`, {
      username,
      password,
    }, {
      timeout: 10000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });

    // Extract mysagra_token from the Set-Cookie header
    const setCookieHeader = resp.headers['set-cookie'];
    let tokenValue: string | undefined;
    if (setCookieHeader) {
      const cookieHeaders = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
      for (const c of cookieHeaders) {
        const match = c.match(/mysagra_token=([^;]+)/);
        if (match) {
          tokenValue = match[1];
          break;
        }
      }
    }

    if (!tokenValue) {
      return res.render('login', { error: 'Login riuscito ma token non trovato nella risposta' });
    }

    // Set session cookie for the web UI
    res.cookie('mystampa_session', tokenValue, {
      httpOnly: true,
      secure: false, // set to true if behind HTTPS
      sameSite: 'lax',
      maxAge: 6 * 60 * 60 * 1000, // 6 hours
    });

    return res.redirect('/config');
  } catch (err: any) {
    console.error('Web login failed:', err.message);
    const status = err.response?.status;
    if (status === 401) {
      return res.render('login', { error: 'Credenziali non valide' });
    }
    return res.render('login', { error: 'Errore durante il login' });
  }
});

/**
 * GET /config - Configuration page (requires login)
 */
app.get('/config', (req: Request, res: Response) => {
  const token = req.cookies?.mystampa_session;
  if (!token) {
    return res.redirect('/');
  }
  res.render('config');
});

// --- API Routes for config page ---

/**
 * Read the config file. Returns default empty config if file doesn't exist.
 */
function readConfig(): { singleTicketCategories: string[] } {
  try {
    if (fsSync.existsSync(CONFIG_FILE)) {
      const raw = fsSync.readFileSync(CONFIG_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('Failed to read config file:', e);
  }
  return { singleTicketCategories: [] };
}

/**
 * Write config to file and update env variable.
 */
function writeConfig(config: { singleTicketCategories: string[] }) {
  fsSync.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), 'utf-8');
  // Update env so print handler picks up new values
  process.env.SINGLE_TICKET_CATEGORIES = config.singleTicketCategories.join(',');
}

/**
 * GET /api/categories - Fetch categories from external API
 */
app.get('/api/categories', async (req: Request, res: Response) => {
  const token = req.cookies?.mystampa_session;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const resp = await axios.get(`${EXTERNAL_BASE_URL}/v1/categories`, {
      timeout: 10000,
      headers: {
        Accept: 'application/json',
        Cookie: `mysagra_token=${token}`,
      },
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
  const token = req.cookies?.mystampa_session;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.json(printers.map((p) => ({
    id: p.id,
    name: p.name,
    ip: p.ip,
    port: p.port,
    description: p.description,
    status: p.status,
  })));
});

/**
 * GET /api/config - Get current config
 */
app.get('/api/config', (req: Request, res: Response) => {
  const token = req.cookies?.mystampa_session;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  return res.json(readConfig());
});

/**
 * POST /api/config - Save config
 */
app.post('/api/config', (req: Request, res: Response) => {
  const token = req.cookies?.mystampa_session;
  if (!token) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  const { singleTicketCategories } = req.body;
  if (!Array.isArray(singleTicketCategories)) {
    return res.status(400).json({ error: 'singleTicketCategories must be an array' });
  }
  const config = { singleTicketCategories };
  writeConfig(config);
  return res.json({ ok: true, config });
});

/**
 * POST /logout - Clear session and redirect to login
 */
app.post('/logout', (req: Request, res: Response) => {
  res.clearCookie('mystampa_session');
  res.redirect('/');
});

// Start listening
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});