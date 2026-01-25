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
import axios from 'axios';
import cors from 'cors';
import swaggerUi from 'swagger-ui-express';
import path from 'path';
import dotenv from 'dotenv';
import { Category, Printer, PrintJob, CategorizedItems, OrderItem, Food } from './models';

dotenv.config();

// Configuration variables with defaults
const EXTERNAL_BASE_URL: string = process.env.EXTERNAL_BASE_URL || 'http://localhost:4300';
const ADMIN_USERNAME: string = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASSWORD: string = process.env.ADMIN_PASSWORD || 'admin';
const PORT: number = process.env.PORT ? parseInt(process.env.PORT) : 1234;

// Types for login response
interface LoginResponse {
  user: any;
  accessToken: string;
}

// In‑memory caches
let authInfo: LoginResponse | null = null;
let categories: Category[] = [];
let printers: Printer[] = [];

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
    const resp = await axios.post<LoginResponse>(`${EXTERNAL_BASE_URL}/auth/login`, {
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
    const resp = await axios.get(`${EXTERNAL_BASE_URL}/v1/categories?available=true`, {
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
    const resp = await axios.get(`${EXTERNAL_BASE_URL}/v1/printers`, {
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
  res.json({ message: 'Mycassa service is running', docs: '/api-docs' });
});

// Start listening
app.listen(PORT, () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});