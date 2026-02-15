/**
 * Entry point for the mystampa service written in TypeScript.
 *
 * The service authenticates against an external API, fetches categories
 * and printers, caches them in memory, and exposes an endpoint `/print`
 * to process print jobs. On each print job it finds the printer for
 * each category and logs the intended output. Optionally it could send
 * data over TCP to a receipt printer using its IP and port.
 */

import express, { Request, Response, NextFunction } from 'express';
import axiosInstance from './utils/axiosInstance';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import path from 'path';
import dotenv from 'dotenv';
import { Category, Printer, PrintJob, CategorizedItems, OrderItem, Food } from './models';

// Import the SSE client. This library allows connection to Server‑Sent
// Events endpoints from Node.js. When USE_SSE is enabled via env
// variables the service will connect to an event stream instead of
// exposing the HTTP /print endpoint exclusively.
import { fetchEventSource } from '@microsoft/fetch-event-source';

dotenv.config();

// Configuration variables with defaults
const EXTERNAL_BASE_URL: string = process.env.EXTERNAL_BASE_URL || 'http://localhost:4300';
const ADMIN_USERNAME: string = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD: string = process.env.ADMIN_PASSWORD || 'admin';
const PORT: number = process.env.PORT ? parseInt(process.env.PORT) : 1234;

// When USE_SSE is set to 'true' or 'sse', the service will subscribe to an
// SSE stream instead of relying solely on the /print endpoint. The
// endpoint for the event source can be configured via SSE_URL.
const USE_SSE: boolean = (process.env.USE_SSE || '').toLowerCase() === 'true' || (process.env.USE_SSE || '').toLowerCase() === 'sse';
const SSE_URL: string = process.env.SSE_URL || 'http://localhost:3001/events/cashier';

// Types for login response
interface LoginResponse {
  user: any;
  accessToken: string;
}

// In‑memory caches
let authInfo: LoginResponse | null = null;
let categories: Category[] = [];
let printers: Printer[] = [];

/**
 * Connect to a Server‑Sent Events (SSE) endpoint and forward incoming
 * events to the local /print endpoint. This allows the service to
 * process orders pushed by a backend without requiring external
 * clients to invoke the REST API directly. The SSE URL and usage
 * are controlled via the USE_SSE and SSE_URL environment variables.
 */
async function startSSE(): Promise<void> {
  const url = SSE_URL;
  const localPort = PORT;
  // Access the JWT saved during initialization. Without a token the
  // Authorization header will be omitted; if the backend enforces
  // authentication the connection may fail.
  const token: string | undefined = (global as any).__AUTH_TOKEN;
  console.log(`SSE: connecting to ${url} (USE_SSE=${USE_SSE})`);
  try {
    await fetchEventSource(url, {
      openWhenHidden: true,
      method: 'GET',
      fetch: fetch,
      headers: {
        Accept: 'text/event-stream',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      // Note: an AbortController could be passed in to allow manual
      // shutdown, but here we keep a persistent connection.
      async onopen(response) {
        if (response.ok) {
          console.log('SSE connected successfully');
        } else {
          console.error('SSE connection failed:', response.status, response.statusText);
        }
      },
      async onmessage(event) {
        // Each event data should contain a JSON object representing
        // an IncomingOrder. Forward it to the /print endpoint so the
        // existing printing logic can process it.
        try {
          if (!event.data) return;
          const payload = JSON.parse(event.data);
          console.log('SSE received event:', payload);
          // Forward to the local /print route for processing. This
          // reuses the existing business logic rather than duplicating it.
          await axiosInstance.post(
            `http://localhost:${localPort}/print`,
            payload,
            { headers: { 'Content-Type': 'application/json' } },
          );
        } catch (err) {
          console.error('SSE: failed to handle event', err);
        }
      },
      onclose() {
        console.log('SSE connection closed');
      },
      onerror(err) {
        console.error('SSE error:', err);
        // Rethrow to trigger automatic reconnection behaviour in
        // fetchEventSource. Without this the stream may silently end.
        throw err;
      },
    });
  } catch (err) {
    console.error('SSE: error establishing connection', err);
  }
}

// Extend Express Request interface to carry cached data
declare global {
  namespace Express {
    interface Request {
      categories?: Category[];
      printers?: Printer[];
    }
  }
}

/**
 * Perform login against the external API to obtain an access token.
 */
async function login(): Promise<LoginResponse | null> {
  try {
    const resp = await axiosInstance.post<LoginResponse>(`${EXTERNAL_BASE_URL}/auth/login`, {
      username: ADMIN_USERNAME,
      password: ADMIN_PASSWORD,
    }, {
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
    return resp.data;
  } catch (err: any) {
    console.error('Login failed:', err.message);
    return null;
  }
}

/**
 * Fetch available categories using the provided token.
 */
async function fetchCategories(token: string): Promise<Category[]> {
  try {
    const resp = await axiosInstance.get(`${EXTERNAL_BASE_URL}/v1/categories?available=true`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    const list: Category[] = (resp.data as any[]).map(Category.fromJson);
    return list;
  } catch (err: any) {
    console.error('Fetching categories failed:', err.message);
    return [];
  }
}

/**
 * Fetch printers list using the provided token.
 */
async function fetchPrinters(token: string): Promise<Printer[]> {
  try {
    const resp = await axiosInstance.get(`${EXTERNAL_BASE_URL}/v1/printers`, {
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${token}`,
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
 * Initialize by logging in and fetching categories and printers. The data
 * is stored in module‑level variables and logged to console.
 */
async function initialize(): Promise<void> {
  authInfo = await login();
  if (!authInfo) {
    console.error('Unable to authenticate; categories and printers will not be loaded.');
    return;
  }
  const token = authInfo.accessToken;
  // Expose token on the global object for routes to reuse
  (global as any).__AUTH_TOKEN = token;
  categories = await fetchCategories(token);
  printers = await fetchPrinters(token);
  console.log('Initialization complete. Categories:', JSON.stringify(categories, null, 2));
  console.log('Initialization complete. Printers:', JSON.stringify(printers, null, 2));

  // If SSE mode is enabled, start listening for events. This
  // invocation is non‑blocking: fetchEventSource will attempt to
  // reconnect automatically on errors. It is important to call this
  // after authentication so that the Authorization header can be
  // included in the SSE connection. The local server does not need to
  // be fully started at this point; events will be forwarded to
  // /print once the listener is bound.
  if (USE_SSE) {
    startSSE().catch((err) => {
      console.error('Error starting SSE listener:', err);
    });
  }
}

// Kick off initialization asynchronously. Errors are logged.
initialize().catch((err) => console.error('Initialization error:', err));


// Configure Express
const app = express();
app.use(cors());
app.use(express.json());

// Middleware to attach cached categories and printers to the request
app.use((req: Request, res: Response, next: NextFunction) => {
  req.categories = categories;
  req.printers = printers;
  next();
});

// Import and mount the print router
import printRouter from './routes/print';
app.use('/print', printRouter);

// Serve swagger documentation
const swaggerDocument = require(path.join(__dirname, '..', 'swagger.json'));
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));

// Root route
app.get('/', (req: Request, res: Response) => {
  res.json({ message: 'mystampa service is running', docs: '/api-docs' });
});

// Start listening
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});