'use strict';

/**
 * render.js — Render REST API client
 *
 * Endpoints used:
 *   GET  /v1/services?name=...           list services
 *   POST /v1/services/:id/deploys        trigger a deploy
 *   GET  /v1/services/:id/deploys/:did   deploy status
 *   GET  /v1/services/:id/events         service events (for crash detection)
 *   GET  /v1/logs?serviceId=...          log lines
 *
 * Auth: Bearer token from RENDER_API_KEY env var.
 * All calls have a 20 s timeout and retry up to 3 times on transient errors.
 */

const https = require('https');

const RENDER_API = 'api.render.com';
const RENDER_API_VERSION = '/v1';

function getApiKey() {
  const key = process.env.RENDER_API_KEY;
  if (!key) throw new Error('RENDER_API_KEY environment variable is not set');
  return key;
}

/** Low-level HTTPS request with timeout, retries, and JSON parsing */
function renderRequest(method, path, body = null, retries = 3) {
  return new Promise((resolve, reject) => {
    const attempt = (n) => {
      const payload = body ? JSON.stringify(body) : null;
      const opts = {
        hostname: RENDER_API,
        path: RENDER_API_VERSION + path,
        method,
        headers: {
          'Authorization': `Bearer ${getApiKey()}`,
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 20000,
      };

      const req = https.request(opts, (res) => {
        let raw = '';
        res.on('data', d => raw += d);
        res.on('end', () => {
          // 204 No Content
          if (res.statusCode === 204) return resolve(null);
          let data;
          try { data = JSON.parse(raw); } catch { data = raw; }

          // Retry on 429 (rate limit) or 5xx
          if ((res.statusCode === 429 || res.statusCode >= 500) && n > 0) {
            const wait = res.statusCode === 429 ? 10000 : 3000;
            return setTimeout(() => attempt(n - 1), wait);
          }
          if (res.statusCode >= 400) {
            const msg = (data && data.message) ? data.message : `HTTP ${res.statusCode}`;
            return reject(new Error(`Render API error on ${method} ${path}: ${msg}`));
          }
          resolve(data);
        });
      });

      req.on('timeout', () => {
        req.destroy();
        if (n > 0) return attempt(n - 1);
        reject(new Error(`Render API timeout on ${method} ${path}`));
      });
      req.on('error', (err) => {
        if (n > 0) return setTimeout(() => attempt(n - 1), 2000);
        reject(err);
      });

      if (payload) req.write(payload);
      req.end();
    };
    attempt(retries);
  });
}

// ── Service lookup ──────────────────────────────────────────────────────────

/** List all services; optionally filter by name substring */
async function listServices(nameFilter = null) {
  const qs = nameFilter ? `?name=${encodeURIComponent(nameFilter)}&limit=20` : '?limit=20';
  const data = await renderRequest('GET', `/services${qs}`);
  // API returns array of { service: {...} } objects
  return (data || []).map(item => item.service || item);
}

/** Get a single service by ID */
async function getService(serviceId) {
  return renderRequest('GET', `/services/${serviceId}`);
}

// ── Deploys ─────────────────────────────────────────────────────────────────

/** Trigger a new deploy. Returns a deploy object with .id by fetching the latest deploy after triggering. */
async function triggerDeploy(serviceId, clearCache = false) {
  // Render API returns 202 with empty body — fire and forget
  await renderRequest('POST', `/services/${serviceId}/deploys`, {
    clearCache: clearCache ? 'clear' : 'do_not_clear',
  });
  // Fetch the latest deploy to get the ID
  await sleep(3000); // brief wait for Render to register the deploy
  const deploys = await listDeploys(serviceId, 1);
  if (!deploys || deploys.length === 0) throw new Error('Could not fetch latest deploy after trigger');
  return deploys[0];
}

/** Get deploy status by deploy ID */
async function getDeployStatus(serviceId, deployId) {
  return renderRequest('GET', `/services/${serviceId}/deploys/${deployId}`);
}

/** List recent deploys for a service */
async function listDeploys(serviceId, limit = 5) {
  const data = await renderRequest('GET', `/services/${serviceId}/deploys?limit=${limit}`);
  return (data || []).map(item => item.deploy || item);
}

// ── Owner ID lookup (cached) ─────────────────────────────────────────────────

let _cachedOwnerId = null;
async function getOwnerId() {
  if (_cachedOwnerId) return _cachedOwnerId;
  const owners = await renderRequest('GET', '/owners?limit=1');
  _cachedOwnerId = owners?.[0]?.owner?.id || owners?.[0]?.id;
  if (!_cachedOwnerId) throw new Error('Could not determine Render owner ID');
  return _cachedOwnerId;
}

// ── Logs ─────────────────────────────────────────────────────────────────────

/**
 * Fetch recent log lines for a service.
 * Returns array of { timestamp, message } objects.
 * Render logs API: GET /logs?ownerId=<ownerId>&resource=<serviceId>&limit=N
 */
async function fetchLogs(serviceId, opts = {}) {
  const { limit = 100, startTime = null } = opts;
  const ownerId = await getOwnerId();
  let qs = `?ownerId=${ownerId}&resource=${serviceId}&limit=${limit}`;
  if (startTime) qs += `&startTime=${encodeURIComponent(startTime)}`;
  const data = await renderRequest('GET', `/logs${qs}`);
  const logs = data?.logs || [];
  return logs.map(l => ({
    timestamp: l.timestamp || '',
    // Strip ANSI escape codes from Render log messages
    message: (l.message || '').replace(/\x1b\[[0-9;]*m/g, ''),
    level: l.level || 'info',
  }));
}

// ── Health check ─────────────────────────────────────────────────────────────

/** Ping the deployed service's /health endpoint. Returns { ok, status, body } */
async function pingHealth(serviceUrl) {
  return new Promise((resolve) => {
    const url = serviceUrl.replace(/\/$/, '') + '/health';
    const lib = url.startsWith('https') ? https : require('http');
    const req = lib.get(url, { timeout: 10000 }, (res) => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve({ ok: res.statusCode === 200, status: res.statusCode, body }));
    });
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, status: 0, body: 'timeout' }); });
    req.on('error', (e) => resolve({ ok: false, status: 0, body: e.message }));
  });
}

// ── Poll helpers ─────────────────────────────────────────────────────────────

const DEPLOY_DONE_STATES   = new Set(['live', 'failed', 'canceled', 'deactivated', 'update_failed', 'build_failed']);
const DEPLOY_FAILED_STATES = new Set(['failed', 'canceled', 'deactivated', 'update_failed', 'build_failed']);

/**
 * Poll a deploy until it reaches a terminal state or times out.
 * Calls onTick(deploy) on each poll.
 * Returns the final deploy object.
 */
async function pollDeploy(serviceId, deployId, {
  intervalMs   = 12000,
  maxWaitMs    = 600000,   // 10 min max
  onTick       = () => {},
} = {}) {
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const deploy = await getDeployStatus(serviceId, deployId);
    onTick(deploy);
    if (DEPLOY_DONE_STATES.has(deploy.status)) return deploy;
    await sleep(intervalMs);
  }
  throw new Error(`Deploy timed out after ${maxWaitMs / 1000}s`);
}

/**
 * Wait for logs to appear after a crash, with retry/backoff.
 * Returns the log lines array.
 */
async function fetchLogsWithRetry(serviceId, {
  maxAttempts = 5,
  backoffMs   = 4000,
  startTime   = null,
} = {}) {
  for (let i = 0; i < maxAttempts; i++) {
    const logs = await fetchLogs(serviceId, { limit: 200, startTime });
    if (logs.length > 0) return logs;
    if (i < maxAttempts - 1) await sleep(backoffMs * (i + 1));
  }
  return [];
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = {
  listServices,
  getService,
  triggerDeploy,
  getDeployStatus,
  listDeploys,
  fetchLogs,
  fetchLogsWithRetry,
  pingHealth,
  pollDeploy,
  DEPLOY_FAILED_STATES,
};
