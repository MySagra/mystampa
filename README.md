<div align="center">

<p align="center">
  <img src="public/banner.png" alt="Banner" width="100%" />
</p>

# 🖨️ MyStampa 

**Automated Thermal Print Service for the MySagra Ecosystem**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![Node.js](https://img.shields.io/badge/Node.js-20.x-green)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)
[![Docker](https://img.shields.io/badge/Docker-ready-2496ED)](https://www.docker.com/)

[Features](#-features) • [How It Works](#-how-it-works) • [Installation](#-installation) • [Docker](#-docker-deployment) • [Configuration](#-configuration)

</div>

---

## About

**MyStampa** is a headless print service built with Node.js and TypeScript. It is part of the **MySagra** ecosystem and is responsible for receiving confirmed orders from the backend via Server-Sent Events (SSE) and routing them to the correct ESC/POS thermal printers over TCP.

It also monitors the status of all configured printers (online, offline, paper out) and reports changes back to the backend in real time.

A lightweight web UI is included for configuration — managing single-ticket categories and viewing live printer status.

---

## Features

### Automated Print Service
- **SSE-based order reception** — connects to the backend and listens for `confirmed-order` and `reprint-order` events (plus `settings-update` for live settings changes)
- **Kitchen receipts** — routes order items to the correct kitchen printer based on food configuration
- **Cash receipts** — prints fiscal receipts with itemized totals, discounts, surcharges and payment method
- **Single tickets** — prints individual cut tickets for configurable item categories
- **Logo support** — prints the sagra logo configured on the backend and the MySagra footer on cash receipts (ESC/POS raster graphics)
- **Print queue** — failed jobs are queued and retried automatically every 60 seconds

### Printer Monitoring
- **TCP probing** — probes each printer via socket every 2 minutes using ESC/POS `DLE EOT 4`
- **Paper status detection** — distinguishes between ONLINE, OFFLINE and paper-out (ERROR)
- **Backend sync** — PATCHes the printer status on the backend only when it changes

### Web UI
- **Login** — authenticates against the MySagra backend using user credentials
- **Category config** — select which item categories should print individual cut tickets
- **Printer overview** — live list of all printers with their current status

---

## How It Works

```
MySagra Backend
      │
      │  SSE  (X-API-KEY)
      ▼
  MyStampa
      │
      ├──► Kitchen Printer 1  (TCP ESC/POS)
      ├──► Kitchen Printer 2  (TCP ESC/POS)
      └──► Cash Register Printer  (TCP ESC/POS)
```

1. On startup MyStampa fetches the printer list and the settings (`/v1/settings`) from the backend using the API key.
2. It connects to the SSE endpoint at `API_URL/events/printer` and keeps the connection alive.
3. When a `confirmed-order` or `reprint-order` event arrives, it fetches food and cash register details from the backend, builds the receipts and sends them to the appropriate printers over TCP.
4. When a `settings-update` event arrives, it replaces the cached settings (e.g. a new receipt logo).
5. Every 2 minutes it probes all printers and PATCHes any status changes to the backend.

**Authentication is split into two independent layers:**
- **Automated service** → `X-API-KEY` header on all backend API calls
- **Web UI** → standard credential login against `API_URL/auth/login`; the returned session token is stored in a cookie for the duration of the session

---

## Installation

### Prerequisites

- **Node.js** 20.x or higher
- Access to a MySagra backend instance
- ESC/POS thermal printers reachable over TCP

### Local Development

1. **Clone the repository**
   ```bash
   git clone https://github.com/MySagra/mystampa.git
   cd mystampa
   ```

2. **Install dependencies**
   ```bash
   npm install
   ```

3. **Configure environment variables**
   ```bash
   cp .env.example .env
   ```
   Edit `.env` with your values (see [Configuration](#-configuration)).

4. **Start in development mode**
   ```bash
   npm run dev
   ```

5. **Open the web UI**

   Navigate to [http://localhost:3032](http://localhost:3032)

---

## Docker Deployment

MyStampa is designed to run as a Docker container alongside the rest of the MySagra stack.

### Using Docker Compose

1. **Create your `.env` file**
   ```bash
   cp .env.example .env
   ```
   Fill in `API_URL` and `API_KEY`.

2. **Start the container**
   ```bash
   docker-compose up -d
   ```

3. **Access the web UI**

   The application will be available at [http://localhost:3032](http://localhost:3032)

### Docker Configuration

The Dockerfile uses a multi-stage build:
- **deps** — installs npm packages
- **builder** — compiles TypeScript
- **runner** — minimal production image running `node dist/index.js`

The container joins the `mysagra-network` external Docker network to reach the backend.

The named volume `mystampa_config` is used to persist the configuration (single-ticket categories) across container restarts and image updates. It is created automatically by Docker on first run — no manual setup required.

---

## Receipt Logo

Every fiscal receipt prints the sagra logo at the top. The logo is **configured centrally on the MySagra backend** (sagra settings → receipt logo): there is nothing to copy into MyStampa or into the Docker container.

### How it works

1. At startup MyStampa calls `GET API_URL/v1/settings` and reads `sagra.receiptLogo` (e.g. `/uploads/receipt_logo/receipt-logo-….png`).
2. The image is downloaded from `API_URL` + `receiptLogo`, converted to ESC/POS raster graphics once and kept in memory.
3. When the settings change, the backend sends a `settings-update` SSE event: MyStampa applies it immediately and downloads the new logo, **no restart required**. Settings are also re-fetched on every SSE reconnection, so a change made while the service was offline is not missed.

If the sagra has no logo configured (or it cannot be downloaded), the **MySagra logo** bundled with the service (`resources/mysagralogo.png`) is printed instead. The same image is also used for the MySagra footer, which is always printed.

> **Tips for best results:**
> - Use a square or landscape image, ideally **300–600 px wide**
> - Black-and-white or high-contrast images print best on thermal paper
> - Supported formats: PNG, JPG/JPEG

### Ticket number or order code

Whether receipts show the ticket number (`N° ORDINE`) or the order code is also read from the backend settings: `settings.tickets.showNumbers` (`true` → ticket number, `false` → order code). It follows `settings-update` events like the logo; until the settings are loaded the order code is used. The old `SHOW_NUMBERS` environment variable is no longer read.

### Currency

Amounts on receipts and closure reports use the currency from `settings.general.currency`, also updated by `settings-update`. The symbols match the admin panel: `€` (EUR), `£` (GBP), `CA$` (CAD), `A$` (AUD); the other currencies (CHF, USD, SEK, NOK, DKK, PLN, CZK, HUF, RON, BGN) are printed by code, e.g. `12,34 CHF`. HUF has no decimals. Until the settings are loaded, `EUR` is used.

---

## Configuration

All configuration is done via environment variables. Copy `.env.example` to `.env` and fill in the values.

| Variable  | Description                                              | Example                          |
|-----------|----------------------------------------------------------|----------------------------------|
| `API_URL` | Base URL of the MySagra backend                          | `http://mysagra-backend:4300`    |
| `API_KEY` | API key for the automated print service (`X-API-KEY`)    | `ms_pt_xxxxxxxxxxxxx`            |
| `LOG_LEVEL` | Log verbosity: `error`, `warn`, `info`, `http`, `verbose`, `debug`, `silly` (default `info`) | `info` |
| `LOG_DIR` | Directory for the daily log files (default `./logs`)      | `/app/logs`                      |
| `TZ`      | Time zone of log timestamps and daily log files (Docker image default `Europe/Rome`) | `Europe/Rome` |

> **How to get the API key**: the API key is generated and displayed after your first login to the MySagra admin panel. Once obtained, copy it into the `API_KEY` field in your `.env` file and restart the service.

> The API key is used exclusively by the automated service (SSE connection, printer fetching, status patching, food/cash-register lookups). The web UI authenticates separately using user credentials.

---

## Logging

Logs are written to two places:

- **stdout** — one readable line per entry, available through `docker logs mystampa`. Docker keeps at most 3 files of 10 MB each with the provided `docker-compose.yml`.
- **`LOG_DIR/mystampa-YYYY-MM-DD.log`** — one JSON object per line, with fields such as `module`, `printerId` and `eventType`.

A new file starts every day at midnight in the `TZ` time zone. Files are kept for 7 days, today included; older ones are deleted at startup and then checked every hour. In Docker they live in the named volume `mystampa_logs`, so they survive container restarts and image updates. If you deploy with your own compose file, mount a volume on `/app/logs`. If the directory is not writable, the service keeps running and logs to stdout only.

API keys, cookies, tokens and passwords are removed from log entries. At the default `info` level an SSE event is logged as a summary; `LOG_LEVEL=debug` also logs the full payload, including customer names and notes.

---

## Project Structure

```
mystampa/
├── src/
│   ├── index.ts              # Entry point — Express server, SSE client, printer polling
│   ├── models.ts             # Domain models and API interfaces
│   ├── routes/
│   │   └── print.ts          # Print order handler (kitchen + cash receipts)
│   ├── utils/
│   │   ├── axiosInstance.ts  # Axios with retry interceptor
│   │   ├── printer.ts        # ESC/POS receipt builder and TCP send
│   │   ├── printQueue.ts     # Failed-job queue with periodic retry
│   │   ├── image.ts          # Logo rasterization for ESC/POS
│   │   ├── settingsCache.ts  # Backend settings (/v1/settings + settings-update) and receipt logo
│   │   └── logger.ts         # Structured logging, daily files, 7-day retention
│   └── views/
│       ├── login.ejs         # Web UI login page
│       └── config.ejs        # Web UI configuration page
├── public/                   # Static files (favicon, banner, login-bg, logo.svg)
├── resources/                # Bundled print resources (mysagralogo.png footer)
├── Dockerfile
├── docker-compose.yml
└── .env.example
```

---

## Available Scripts

| Command         | Description                              |
|-----------------|------------------------------------------|
| `npm run dev`   | Start with ts-node and hot reload        |
| `npm run build` | Compile TypeScript to `dist/`            |
| `npm start`     | Build and run the production server      |

---

## License

This project is licensed under the **GNU Affero General Public License v3.0 (AGPL-3.0)**.

- You can use, modify, and distribute this software
- You must disclose source code of any modifications
- You must license derivative works under AGPL-3.0
- Network use counts as distribution (must provide source)

See the [LICENSE](LICENSE) file for full details.

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/amazing-feature`
3. Commit your changes: `git commit -m 'Add amazing feature'`
4. Push to the branch: `git push origin feature/amazing-feature`
5. Open a Pull Request

---

<div align="center">

**Made with ❤️ by the MySagra Team**

Part of the [MySagra](https://github.com/MySagra) ecosystem

[⬆ Back to Top](#mystampa)

</div>
