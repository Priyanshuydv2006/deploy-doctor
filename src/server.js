'use strict';

const express = require('express');
const path = require('path');
const fs = require('fs');
const { checkHardcodedSecrets } = require('./checks/secrets');
const { checkEnvVariables } = require('./checks/envVars');
const { checkEphemeralStorage } = require('./checks/ephemeralStorage');
const { checkHealthEndpoint } = require('./checks/healthEndpoint');
const { applyHealthCheckFix } = require('./fixer');
const { parseGitHubInput, fetchGitHubRepo, rimrafSync } = require('./github');

// â”€â”€ SSE heal-log bus â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Active SSE clients listening for heal events
const healClients = new Set();

function broadcastHealEvent(event) {
  const data = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of healClients) {
    try { res.write(data); } catch {}
  }
}

// Monkey-patch the heal narrate so it also broadcasts to SSE clients
function makeSSENarrator() {
  const chalk = require('chalk');
  return function(msg, style = 'normal') {
    const ts = new Date().toLocaleTimeString();
    // Strip chalk codes for the browser
    const clean = msg.replace(/\x1b\[[0-9;]*m/g, '');
    broadcastHealEvent({ type: 'log', style, msg: clean, ts });
    // Also print to terminal
    const prefix = `[${ts}]`;
    if (style === 'step')    console.log(`\n${prefix} â–¶ ${msg}`);
    else if (style === 'ok') console.log(`${prefix} âœ” ${msg}`);
    else if (style === 'warn')console.log(`${prefix} âš  ${msg}`);
    else if (style === 'err') console.log(`${prefix} âœ– ${msg}`);
    else                      console.log(`${prefix}   ${msg}`);
  };
}

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

/** Run all 4 checks against an absolute path and return structured results */
async function runChecks(absolutePath) {
  const [secretIssues, envIssues, storageIssues, healthIssues] = await Promise.all([
    checkHardcodedSecrets(absolutePath),
    checkEnvVariables(absolutePath),
    checkEphemeralStorage(absolutePath),
    checkHealthEndpoint(absolutePath),
  ]);

  const issues = [...secretIssues, ...envIssues, ...storageIssues, ...healthIssues];
  const counts = { Critical: 0, Warning: 0, Info: 0 };
  for (const issue of issues) counts[issue.severity]++;

  const byCheck = {};
  for (const issue of issues) {
    if (!byCheck[issue.check]) byCheck[issue.check] = [];
    byCheck[issue.check].push(issue);
  }

  return {
    summary: {
      critical: counts.Critical,
      warning: counts.Warning,
      info: counts.Info,
      total: issues.length,
      safeToDeploy: counts.Critical === 0,
    },
    byCheck,
    issues,
  };
}

// POST /api/scan  { "repoPath": "/absolute/or/relative/path" }
// Also accepts GitHub URLs â€” auto-detected and handled via /api/scan/github logic
app.post('/api/scan', async (req, res) => {
  const { repoPath } = req.body;
  if (!repoPath || typeof repoPath !== 'string') {
    return res.status(400).json({ error: 'repoPath is required' });
  }

  // If it looks like a GitHub URL/shorthand, delegate
  if (parseGitHubInput(repoPath) && (repoPath.includes('github.com') || /^[\w-]+\/[\w.-]+/.test(repoPath))) {
    return handleGitHubScan(repoPath, res);
  }

  const absolutePath = path.resolve(repoPath);
  if (!fs.existsSync(absolutePath)) {
    return res.status(404).json({ error: `Path not found: ${absolutePath}` });
  }

  try {
    const result = await runChecks(absolutePath);
    res.json({ scannedPath: absolutePath, source: 'local', ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/scan/github  { "repoUrl": "https://github.com/owner/repo" }
app.post('/api/scan/github', async (req, res) => {
  const { repoUrl } = req.body;
  if (!repoUrl) return res.status(400).json({ error: 'repoUrl is required' });
  return handleGitHubScan(repoUrl, res);
});

async function handleGitHubScan(input, res) {
  let tempDir = null;
  try {
    const { tempDir: td, owner, repo, branch } = await fetchGitHubRepo(input);
    tempDir = td;
    const result = await runChecks(tempDir);
    res.json({
      scannedPath: `github.com/${owner}/${repo}@${branch}`,
      source: 'github',
      owner,
      repo,
      branch,
      ...result,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    if (tempDir) rimrafSync(tempDir);
  }
}

// POST /api/fix/health  { "repoPath": "..." }
// Non-interactive version of the health-check fix (no prompts)
app.post('/api/fix/health', async (req, res) => {
  const { repoPath } = req.body;
  if (!repoPath) return res.status(400).json({ error: 'repoPath is required' });

  const absolutePath = path.resolve(repoPath);
  if (!fs.existsSync(absolutePath)) {
    return res.status(404).json({ error: `Path not found: ${absolutePath}` });
  }

  try {
    const result = await applyHealthCheckFixSilent(absolutePath);
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// â”€â”€ SSE endpoint: GET /api/heal/stream â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.get('/api/heal/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.write('data: {"type":"connected"}\n\n');
  healClients.add(res);

  // Keepalive ping every 20s â€” prevents Render/nginx from closing idle SSE connections
  const keepalive = setInterval(() => {
    try { res.write(': ping\n\n'); } catch { clearInterval(keepalive); }
  }, 20000);

  req.on('close', () => {
    clearInterval(keepalive);
    healClients.delete(res);
  });
});

// â”€â”€ POST /api/heal  { repoPath, serviceId?, serviceUrl? } â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
app.post('/api/heal', async (req, res) => {
  const { repoPath, serviceId, serviceUrl } = req.body || {};
  if (!repoPath) return res.status(400).json({ error: 'repoPath is required' });

  res.json({ started: true });

  // Load secrets.env so RENDER_API_KEY + GITHUB_TOKEN are available
  const secretsFile = path.join(__dirname, '../secrets.env');
  if (fs.existsSync(secretsFile)) {
    fs.readFileSync(secretsFile, 'utf8').split('\n').forEach(line => {
      const m = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
    });
  }

  broadcastHealEvent({ type: 'start', repoPath });
  const { runHealWithNarrator } = require('./heal');

  // If input is a GitHub URL/shorthand, download it to a temp dir first
  const isGitHub = parseGitHubInput(repoPath) &&
    (repoPath.includes('github.com') || /^[\w-]+\/[\w.-]+/.test(repoPath));

  let tempDir = null;
  let resolvedPath = repoPath;

  if (isGitHub) {
    broadcastHealEvent({ type: 'log', style: 'step', msg: `Downloading GitHub repo: ${repoPath}â€¦`, ts: new Date().toLocaleTimeString() });
    try {
      const { tempDir: td } = await fetchGitHubRepo(repoPath);
      tempDir = td;
      resolvedPath = td;
      broadcastHealEvent({ type: 'log', style: 'ok', msg: 'Repo downloaded â€” starting heal loop', ts: new Date().toLocaleTimeString() });
    } catch (err) {
      broadcastHealEvent({ type: 'error', msg: `Failed to download repo: ${err.message}` });
      return;
    }
  }

  try {
    await runHealWithNarrator(resolvedPath, { serviceId, serviceUrl }, makeSSENarrator());
    broadcastHealEvent({ type: 'done' });
  } catch (err) {
    broadcastHealEvent({ type: 'error', msg: err.message });
  } finally {
    if (tempDir) rimrafSync(tempDir);
  }
});

function startServer(port = 4242) {
  app.listen(port, () => {
    console.log(`\nðŸ©º Deploy Doctor dashboard â†’ http://localhost:${port}\n`);
    console.log(`   Heal dashboard  â†’ http://localhost:${port}/heal.html\n`);
  });
}

module.exports = { startServer };

// Silent (non-interactive) fix for the web API
async function applyHealthCheckFixSilent(repoPath) {
  const fixer = require('./fixer');
  // Re-implement without prompts
  const ENTRY_CANDIDATES = ['index.js', 'app.js', 'server.js', 'main.js', 'src/index.js', 'src/app.js'];
  let pkgMain = null;
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
    pkgMain = pkg.main || null;
  } catch {}

  const candidates = pkgMain ? [pkgMain, ...ENTRY_CANDIDATES] : ENTRY_CANDIDATES;
  let entryFile = null;
  for (const c of candidates) {
    const full = path.join(repoPath, c);
    if (fs.existsSync(full)) { entryFile = full; break; }
  }
  if (!entryFile) return { success: false, error: 'Could not detect entry file' };

  const original = fs.readFileSync(entryFile, 'utf8');
  const appVar = (original.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:express|require\s*\(\s*["'`]express["'`]\s*\)\s*)\s*\(\s*\)/) || [null, 'app'])[1];
  const snippet = `\n// Health-check endpoint (added by deploy-doctor)\n${appVar}.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));\n`;
  const listenMatch = original.match(/\b(?:app|server)\.listen\s*\(/);
  let insertAt = original.length;
  if (listenMatch && listenMatch.index !== undefined) {
    let idx = listenMatch.index;
    while (idx > 0 && original[idx - 1] !== '\n') idx--;
    insertAt = idx;
  }
  const patched = original.slice(0, insertAt) + snippet + original.slice(insertAt);
  fs.writeFileSync(entryFile, patched, 'utf8');
  return { success: true, file: path.relative(repoPath, entryFile), snippet: snippet.trim() };
}
