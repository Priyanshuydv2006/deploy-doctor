# 🩺 Deploy Doctor

A CLI tool that scans a Node.js backend repository for deployment risks before it ships to production. Built for the **IBM Bob 2.0 Hackathon — Release & Deployment track**.

---

## Installation

```bash
cd deploy-doctor
npm install
```

To use the `deploy-doctor` command globally:

```bash
npm link
```

Or run directly with Node:

```bash
node bin/deploy-doctor.js scan <path-to-repo>
```

---

## Usage

### Basic scan

```bash
deploy-doctor scan ./my-api
```

### Scan with auto-fix for missing health-check endpoint

```bash
deploy-doctor scan ./my-api --fix
```

### Machine-readable JSON output (for CI pipelines)

```bash
deploy-doctor scan ./my-api --json
```

---

## Demo (against the included sample repo)

```bash
node bin/deploy-doctor.js scan sample-repo
```

Expected output: **6 Critical, 4 Warning, 1 Info — NOT SAFE TO DEPLOY**

To demo the health-check auto-fix:

```bash
node bin/deploy-doctor.js scan sample-repo --fix
```

Deploy Doctor will detect the missing `/health` endpoint, show you a diff of the proposed change, and ask for confirmation before writing the file.

---

## Checks

| # | Check | Severity | Description |
|---|-------|----------|-------------|
| 1 | **Hardcoded Secrets** | 🔴 Critical | Detects API keys, tokens, passwords assigned as string literals in source code |
| 2 | **Env Variable Coverage** | 🟡 Warning | Compares `process.env.X` usages against `.env.example`; flags missing or unused variables |
| 3 | **Ephemeral Storage** | 🔴 Critical | Detects SQLite, `fs.writeFile` to relative paths, and `multer.diskStorage` that will fail on platforms with ephemeral filesystems |
| 4 | **Health Check Endpoint** | 🔵 Info | Checks for `/health`, `/healthz`, `/status`, or `/ping` routes. Supports `--fix` auto-generation |

---

## Auto-Fix: Health-Check Endpoint

When `--fix` is passed and no health-check route is found, Deploy Doctor will:

1. Detect the framework (Express, Fastify, Koa) from `package.json`
2. Detect the entry file from `package.json "main"` or common names (`index.js`, `app.js`, `server.js`)
3. Detect the Express app variable name
4. Insert a minimal route just before `app.listen()`:
   ```js
   // Health-check endpoint (added by deploy-doctor)
   app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));
   ```
5. Show a diff and ask for confirmation before writing

---

## JSON Output Schema

```json
{
  "summary": {
    "critical": 6,
    "warning": 4,
    "info": 1,
    "safeToDeploy": false
  },
  "issues": [
    {
      "severity": "Critical",
      "check": "Hardcoded Secrets",
      "file": "index.js",
      "line": 16,
      "description": "Potential hardcoded secret (variable assignment) found in source code",
      "fix": "Move this value to an environment variable and reference it via process.env.YOUR_VAR"
    }
  ]
}
```

---

## Self-Healing Deploy Loop (Part 2)

### Prerequisites

1. A Render account with a deployed Web Service
2. A Render API key (Account → API Keys)
3. Your service ID (`srv-xxxx` from the dashboard URL)

### Setup

Edit `heal-demo-app/.heal.json`:
```json
{
  "serviceId": "srv-xxxx",
  "serviceUrl": "https://your-app.onrender.com"
}
```

Set your API key:
```bash
export RENDER_API_KEY=rnd_XXXXXXXXXXXX
```

### Run the heal loop

```bash
node bin/deploy-doctor.js heal ./heal-demo-app --verbose
```

### What happens (narrated in real time)

```
▶ Step 1/7 — Running pre-flight scan to predict risks…
⚠  Pre-flight found 1 ephemeral-storage risk(s) + 1 health-check issue(s)
   → [Critical] SQLite database detected — will be wiped on redeploy

▶ Step 2/7 — Triggering deploy on Render…
✔  Deploy triggered → ID: dep-abc123

▶ Step 3/7 — Polling deploy status…
   deploy status: building
   deploy status: failed

▶ Step 4/7 — Fetching crash logs from Render…
✔  Fetched 47 log lines
✖  SQLITE_CANTOPEN: unable to open database file ./data/app.db

▶ Step 5/7 — Analyzing root cause…
✔  Root cause: sqlite-ephemeral
✔  Cross-referenced: Deploy Doctor predicted this with "Ephemeral Storage" check ✔

▶ Step 6/7 — Generating and applying code patches…
✔  Patching server.js — Replaced SQLite path with process.env.DATABASE_URL
✔  Written: server.js
✔  Injected /health endpoint into server.js

▶ Step 7/7 — Triggering redeploy with patched code…
   deploy status: building → live

▶ Verifying /health endpoint…
✔  GET /health → 200 { "status": "ok" }
```

### Final report

```
BEFORE
  Deploy status  : failed
  Crash log line : SQLITE_CANTOPEN: unable to open database file
  Root cause     : sqlite-ephemeral
  Predicted by   : Deploy Doctor check "Ephemeral Storage"

PATCHES APPLIED
  ✔ server.js — Replaced hardcoded SQLite path with process.env.DATABASE_URL
  ✔ entry file — Injected GET /health → 200 { status: "ok" }

AFTER
  Deploy status  : live
  Health check   : GET /health → 200 OK ✔
  Response       : {"status":"ok"}

  ✔ App is live and healthy. Self-healing loop succeeded.
```

---

## Project Structure

```
deploy-doctor/
├── bin/
│   └── deploy-doctor.js        # CLI entry point (scan / serve / heal)
├── src/
│   ├── index.js                # Scan orchestrator
│   ├── reporter.js             # Terminal + JSON output
│   ├── fixer.js                # Health-check auto-fix
│   ├── patcher.js              # Code patch generator (SQLite, fs.write, multer)
│   ├── render.js               # Render REST API client
│   ├── heal.js                 # Self-healing deploy loop orchestrator
│   ├── github.js               # GitHub repo zip downloader
│   ├── server.js               # Dashboard Express server
│   └── checks/
│       ├── secrets.js          # Check 1: Hardcoded secrets
│       ├── envVars.js          # Check 2: Env variable coverage
│       ├── ephemeralStorage.js # Check 3: Ephemeral storage risk
│       └── healthEndpoint.js  # Check 4: Missing health check
├── public/
│   └── index.html              # Animated dashboard UI
├── sample-repo/                # Demo repo with intentional issues
│   ├── index.js
│   ├── routes/users.js
│   └── .env.example
└── heal-demo-app/              # Deliberately broken app for heal demo
    ├── server.js               # Crashes with SQLITE_CANTOPEN on Render
    ├── .heal.json              # Render service config
    └── .env.example
```
