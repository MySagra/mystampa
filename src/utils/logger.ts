/**
 * Shared structured logger for the mystampa service.
 *
 * - stdout: one human-readable line per entry (`docker logs`)
 * - LOG_DIR/mystampa-YYYY-MM-DD.log: JSON lines, one file per local day
 *
 * Usage: `const log = createLogger('print'); log.info('Printed', { printerId });`
 * Pass caught errors as `{ err }`: they are reduced to a safe subset of fields,
 * because an AxiosError carries the request headers, X-API-KEY included.
 */

// index.ts already loads this first; repeating it (it is idempotent and never
// overrides) keeps LOG_LEVEL and LOG_DIR correct whoever imports the logger.
import 'dotenv/config';
import fs from 'fs';
import path from 'path';
import winston from 'winston';
import DailyRotateFile from 'winston-daily-rotate-file';

const RETENTION_DAYS = 7;
const PURGE_INTERVAL_MS = 60 * 60 * 1000;
const LOG_FILE_RE = /^mystampa-(\d{4}-\d{2}-\d{2})\.log$/;
const MAX_DEPTH = 8;
const REDACTED = '[REDACTED]';

const SENSITIVE_KEY_RE = /api[-_]?key|authorization|cookie|token|passw(or)?d|secret|session/i;

const DEFAULT_LEVEL = 'info';
const requestedLevel = (process.env.LOG_LEVEL || DEFAULT_LEVEL).toLowerCase();
const levelIsValid = requestedLevel in winston.config.npm.levels;
const LOG_LEVEL = levelIsValid ? requestedLevel : DEFAULT_LEVEL;
const LOG_DIR = path.resolve(process.env.LOG_DIR || path.join(process.cwd(), 'logs'));

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

const localDate = (d: Date): string =>
  `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** ISO 8601 in the process time zone (TZ) with its explicit UTC offset. */
function localTimestamp(): string {
  const d = new Date();
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? '+' : '-';
  const abs = Math.abs(offset);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
  return `${localDate(d)}T${time}${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

function scrubSecrets(text: string): string {
  const apiKey = process.env.API_KEY;
  return apiKey && apiKey.length >= 8 ? text.split(apiKey).join(REDACTED) : text;
}

function serializeError(err: any, depth: number, ancestors: WeakSet<object>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    type: err.name,
    message: scrubSecrets(String(err.message)),
  };
  if (err.code !== undefined) out.code = err.code;
  if (err.response?.status !== undefined) out.status = err.response.status;
  if (err.stack) out.stack = scrubSecrets(String(err.stack));
  // fetch() hides the real reason (ECONNREFUSED, ...) in `cause`.
  if (err.cause !== undefined) out.cause = clean(err.cause, '', depth + 1, ancestors);
  return out;
}

/** Copy a value into plain JSON-safe data with every secret removed. */
function clean(value: any, key: string, depth: number, ancestors: WeakSet<object>): unknown {
  if (SENSITIVE_KEY_RE.test(key)) return REDACTED;
  if (typeof value === 'string') return scrubSecrets(value);
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (ArrayBuffer.isView(value)) return `[binary ${value.byteLength} bytes]`;
  if (value instanceof Date) return value.getTime() ? value.toISOString() : 'Invalid Date';
  if (depth >= MAX_DEPTH) return '[Truncated]';
  if (ancestors.has(value)) return '[Circular]';

  ancestors.add(value);
  let out: unknown;
  if (value instanceof Error) {
    out = serializeError(value, depth, ancestors);
  } else if (Array.isArray(value)) {
    out = value.map((item) => clean(item, '', depth + 1, ancestors));
  } else {
    out = Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, clean(v, k, depth + 1, ancestors)])
    );
  }
  ancestors.delete(value);
  return out;
}

/** Fields winston adds to crash entries: process/host dumps we don't want logged. */
const CRASH_NOISE = ['date', 'process', 'os', 'trace', 'stack', 'error', 'exception', 'rejection'];

const sanitize = winston.format((info) => {
  // A log call must never throw into the printing code.
  try {
    if (info.exception || info.rejection) {
      info.err = info.error;
      info.module = 'process';
      info.message = String(info.message).split('\n')[0];
      for (const field of CRASH_NOISE) delete info[field];
    }
    info.message = scrubSecrets(String(info.message));
    for (const key of Object.keys(info)) {
      if (key === 'level' || key === 'message') continue;
      info[key] = clean(info[key], key, 0, new WeakSet());
    }
  } catch (cause) {
    for (const key of Object.keys(info)) {
      if (key !== 'level' && key !== 'message' && key !== 'module') delete info[key];
    }
    info.logFormatError = cause instanceof Error ? cause.message : String(cause);
  }
  return info;
});

const fileFormat = winston.format.printf(({ timestamp, level, module, message, ...fields }) =>
  JSON.stringify({ timestamp, level, module, message, ...fields })
);

function errorDetails(err: any): string {
  if (err === null || typeof err !== 'object') return `\n${err}`;
  const own = `\n${err.stack ?? err.message ?? JSON.stringify(err)}`;
  return err.cause === undefined ? own : `${own}\nCaused by:${errorDetails(err.cause)}`;
}

const consoleFormat = winston.format.printf(({ timestamp, level, module, message, err, ...fields }) => {
  const extra = JSON.stringify(fields);
  return `${timestamp} ${level.toUpperCase().padEnd(5)} [${module ?? 'app'}] ${message}`
    + (extra === '{}' ? '' : ` ${extra}`)
    + (err === undefined ? '' : errorDetails(err));
});

/**
 * Delete daily files older than the retention window (today + 6 previous days).
 *
 * winston-daily-rotate-file's `maxFiles` is not used on purpose: it only purges
 * when a new file is opened, so a service left idle between events would keep
 * old logs indefinitely. This also needs no audit file to stay in sync.
 */
export function purgeOldLogs(): void {
  const now = new Date(Date.now());
  const cutoff = localDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - (RETENTION_DAYS - 1)));
  try {
    for (const name of fs.readdirSync(LOG_DIR)) {
      const match = LOG_FILE_RE.exec(name);
      if (match && match[1] < cutoff) fs.rmSync(path.join(LOG_DIR, name), { force: true });
    }
  } catch (err) {
    logger.error('Log retention purge failed', { module: 'logger', dir: LOG_DIR, err });
  }
}

function isLogDirWritable(): { ok: true } | { ok: false; err: unknown } {
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.accessSync(LOG_DIR, fs.constants.W_OK);
    return { ok: true };
  } catch (err) {
    return { ok: false, err };
  }
}

export const logger = winston.createLogger({
  level: LOG_LEVEL,
  format: winston.format.combine(
    sanitize(),
    winston.format.timestamp({ format: localTimestamp })
  ),
  transports: [
    new winston.transports.Console({
      format: consoleFormat,
      handleExceptions: true,
      handleRejections: true,
    }),
  ],
});

// A full disk or a broken volume must degrade logging, never stop the printing.
// Reported once per distinct failure: once a file stream breaks, every later
// write fails the same way until the next daily file is opened.
let lastLogFailure = '';
function reportLogFailure(err: Error): void {
  if (err.message === lastLogFailure) return;
  lastLogFailure = err.message;
  process.stderr.write(`Log file write failed, stdout logging continues: ${scrubSecrets(err.message)}\n`);
}
logger.on('error', reportLogFailure);

const logDirCheck = isLogDirWritable();
if (logDirCheck.ok) {
  const fileTransport = new DailyRotateFile({
    dirname: LOG_DIR,
    filename: 'mystampa-%DATE%.log',
    datePattern: 'YYYY-MM-DD',
    format: fileFormat,
    handleExceptions: true,
    handleRejections: true,
  });
  // The rotating stream's errors are not forwarded to the transport: without
  // this listener they surface as an uncaught exception and stop the service.
  (fileTransport as unknown as { logStream: NodeJS.EventEmitter }).logStream.on('error', reportLogFailure);
  logger.add(fileTransport);
  purgeOldLogs();
  setInterval(purgeOldLogs, PURGE_INTERVAL_MS).unref();
  logger.info('File logging enabled', {
    module: 'logger',
    logLevel: LOG_LEVEL,
    dir: LOG_DIR,
    retentionDays: RETENTION_DAYS,
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
} else {
  logger.warn('Log directory not writable, logging to stdout only', {
    module: 'logger',
    dir: LOG_DIR,
    err: logDirCheck.err,
  });
}

if (!levelIsValid) {
  logger.warn('Invalid LOG_LEVEL, using default', {
    module: 'logger',
    requested: requestedLevel,
    logLevel: LOG_LEVEL,
  });
}

/**
 * Just the reason of a failure, for expected ones such as an unreachable
 * printer, logged as `{ error: errorMessage(err) }`: a stack adds nothing there.
 */
export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Create a logger whose entries all carry the given `module` field. */
export function createLogger(module: string): winston.Logger {
  return logger.child({ module });
}
