'use strict';

// Load RENDER_API_KEY from secrets.env in the tool's own directory if present
// (never committed — add secrets.env to .gitignore)
const _secretsFile = require('path').join(__dirname, '../secrets.env');
if (require('fs').existsSync(_secretsFile)) {
  require('fs').readFileSync(_secretsFile, 'utf8').split('\n').forEach(line => {
    const m = line.match(/^([A-Z_]+)\s*=\s*(.+)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
  });
}

/**
 * heal.js — Self-healing deploy loop orchestrator
 *
 * Command: deploy-doctor heal <path>
 *
 * Flow (max 3 attempts):
 *   1. Part-1 scan → report predicted risks
 *   2. Trigger Render deploy via API
 *   3. Poll until deploy reaches terminal state
 *   4. If failed/crashed → fetch logs → find root cause → cross-ref Part-1 checks
 *   5. Patch the offending file(s)
 *   6. Show diff, confirm, write, commit (git add+commit if git available, else just write)
 *   7. Trigger redeploy → poll → verify /health
 *   8. Print before/after report
 */

const fs   = require('fs');
const path = require('path');
const chalk = require('chalk');
const { pushFilesToGitHub, parseGitHubRepo } = require('./github-push');

const { checkEphemeralStorage } = require('./checks/ephemeralStorage');
const { checkHealthEndpoint }   = require('./checks/healthEndpoint');
const { patchFile }             = require('./patcher');
const { applyHealthCheckFix: applyHealthCheckFixSilent } = require('./fixer');

const render = require('./render');

// ── Narrator (the "wow moment") ───────────────────────────────────────────────

// Default narrator — chalk terminal output
function defaultNarrate(msg, style = 'normal') {
  const ts = new Date().toLocaleTimeString();
  const prefix = chalk.dim(`[${ts}]`);
  if (style === 'step')    console.log(`\n${prefix} ${chalk.cyan.bold('▶')} ${chalk.bold(msg)}`);
  else if (style === 'ok') console.log(`${prefix} ${chalk.green('✔')} ${msg}`);
  else if (style === 'warn')console.log(`${prefix} ${chalk.yellow('⚠')} ${msg}`);
  else if (style === 'err') console.log(`${prefix} ${chalk.red('✖')} ${msg}`);
  else if (style === 'dim') console.log(`${prefix} ${chalk.dim(msg)}`);
  else                      console.log(`${prefix}   ${msg}`);
}

// Current narrator — can be swapped for SSE broadcasting
let narrate = defaultNarrate;

function separator(char = '─', len = 60) {
  console.log(chalk.dim(char.repeat(len)));
}

// ── Log analysis ──────────────────────────────────────────────────────────────

/** Patterns that indicate ephemeral-storage related crashes */
const CRASH_SIGNATURES = [
  { pattern: /SQLITE_CANTOPEN|unable to open database|SQLITE_READONLY|directory does not exist/i, cause: 'sqlite-ephemeral', check: 'Ephemeral Storage' },
  { pattern: /ENOENT.*\.db|no such file.*\.db/i,                           cause: 'sqlite-ephemeral',  check: 'Ephemeral Storage' },
  { pattern: /EROFS|read.only file system/i,                               cause: 'readonly-fs',        check: 'Ephemeral Storage' },
  { pattern: /ENOENT.*\.(log|txt|json)|no such file or directory/i,       cause: 'file-write-ephemeral', check: 'Ephemeral Storage' },
  { pattern: /Error: listen EADDRINUSE/i,                                  cause: 'port-conflict',      check: null },
  { pattern: /Cannot find module/i,                                        cause: 'missing-dependency', check: null },
];

function analyzeLogsForCrash(logLines) {
  const messages = logLines.map(l => l.message || '');
  const findings = [];

  for (const line of messages) {
    for (const sig of CRASH_SIGNATURES) {
      if (sig.pattern.test(line)) {
        findings.push({ line, cause: sig.cause, check: sig.check });
        break;
      }
    }
  }

  return findings;
}

/** Find the most likely error line in logs */
function findErrorLines(logLines) {
  return logLines.filter(l => {
    const m = (l.message || '').toLowerCase();
    return m.includes('error') || m.includes('failed') || m.includes('enoent') ||
           m.includes('sqlite') || m.includes('crash') || m.includes('unhandled') ||
           m.includes('exit code') || l.level === 'error';
  });
}

// ── File patching ─────────────────────────────────────────────────────────────

/**
 * Scan the repo for ephemeral-storage issues, apply patches to all affected files.
 * Returns array of { file, patches, finalContent }.
 */
async function patchRepoForEphemeralIssues(repoPath) {
  const storageIssues = await checkEphemeralStorage(repoPath);
  if (storageIssues.length === 0) return [];

  // Get unique files that have issues
  const affectedFiles = [...new Set(storageIssues.map(i => i.file).filter(Boolean))];
  const results = [];

  for (const relFile of affectedFiles) {
    const absFile = path.join(repoPath, relFile);
    let content;
    try { content = fs.readFileSync(absFile, 'utf8'); } catch { continue; }

    const { patches, finalContent } = patchFile(content, relFile);
    if (patches.length > 0) {
      results.push({ file: relFile, absFile, patches, originalContent: content, finalContent });
    }
  }

  // Also check for missing health endpoint and patch that too
  const healthIssues = await checkHealthEndpoint(repoPath);
  if (healthIssues.length > 0) {
    // Use the silent fixer — it writes directly; we just record that it was done
    results.push({ file: '__health_endpoint__', patches: [{ patchName: 'health-endpoint', description: 'Injected GET /health route' }] });
  }

  return results;
}

// ── Git commit helper ─────────────────────────────────────────────────────────

async function tryGitCommit(repoPath, message) {
  const { execSync } = require('child_process');
  try {
    execSync('git add -A', { cwd: repoPath, timeout: 10000, stdio: 'pipe' });
    execSync(`git commit -m "${message}"`, { cwd: repoPath, timeout: 10000, stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Push all patched files to GitHub via the API (no git binary needed).
 * Returns true if push succeeded.
 */
async function pushPatchesToGitHub(patchResults, absPath, githubInfo, branch) {
  const filesToPush = [];

  for (const pr of patchResults) {
    if (pr.file === '__health_endpoint__') {
      // Health endpoint was injected — read the written entry file back
      const CANDIDATES = ['index.js','app.js','server.js','main.js'];
      let pkgMain = null;
      try { pkgMain = JSON.parse(fs.readFileSync(path.join(absPath,'package.json'),'utf8')).main; } catch {}
      const candidates = pkgMain ? [pkgMain,...CANDIDATES] : CANDIDATES;
      for (const c of candidates) {
        const full = path.join(absPath, c);
        if (fs.existsSync(full)) {
          filesToPush.push({ path: c, content: fs.readFileSync(full,'utf8') });
          break;
        }
      }
      continue;
    }
    // For normal patches, push the finalContent
    filesToPush.push({ path: pr.file, content: pr.finalContent });
  }

  if (filesToPush.length === 0) return false;

  const results = await pushFilesToGitHub({
    owner: githubInfo.owner,
    repo:  githubInfo.repo,
    branch,
    message: 'fix: deploy-doctor auto-patch — ephemeral storage + health check',
    files: filesToPush,
  });

  return results;
}

// ── Before/after report ───────────────────────────────────────────────────────

function printFinalReport(report) {
  separator('═');
  console.log(chalk.bold('\n🩺 Deploy Doctor — Self-Healing Report\n'));

  console.log(chalk.bold('BEFORE'));
  separator();
  console.log(`  Deploy status  : ${chalk.red(report.before.deployStatus)}`);
  if (report.before.errorLine) {
    console.log(`  Crash log line : ${chalk.red.italic(report.before.errorLine)}`);
  }
  console.log(`  Root cause     : ${chalk.yellow(report.before.rootCause)}`);
  console.log(`  Predicted by   : Deploy Doctor check "${chalk.cyan(report.before.predictedByCheck)}"`);

  console.log(chalk.bold('\nPATCHES APPLIED'));
  separator();
  for (const p of report.patches) {
    console.log(`  ${chalk.green('✔')} ${chalk.bold(p.file)} — ${p.description}`);
  }

  console.log(chalk.bold('\nAFTER'));
  separator();
  if (report.after.healthy) {
    console.log(`  Deploy status  : ${chalk.green(report.after.deployStatus)}`);
    console.log(`  Health check   : ${chalk.green('GET /health → 200 OK ✔')}`);
    console.log(`  Response       : ${chalk.dim(report.after.healthBody)}`);
  } else {
    console.log(`  Deploy status  : ${chalk.yellow(report.after.deployStatus)}`);
    console.log(`  Health check   : ${chalk.red('Failed — ' + report.after.healthError)}`);
  }

  separator('═');
  if (report.after.healthy) {
    console.log(chalk.green.bold('\n  ✔ App is live and healthy. Self-healing loop succeeded.\n'));
  } else {
    console.log(chalk.red.bold('\n  ✖ App is still unhealthy after max attempts.\n'));
    console.log(chalk.dim('  Review the patches above and check Render dashboard for details.\n'));
  }
}

// ── Main heal loop ────────────────────────────────────────────────────────────

const MAX_ATTEMPTS = 3;

// Wrapper that accepts a custom narrator (for SSE streaming to browser)
async function runHealWithNarrator(repoPath, options = {}, narratorFn = null) {
  const prev = narrate;
  if (narratorFn) narrate = narratorFn;
  try {
    await runHeal(repoPath, options);
  } finally {
    narrate = prev;
  }
}

async function runHeal(repoPath, options = {}) {
  const absPath = path.resolve(repoPath);
  if (!fs.existsSync(absPath)) {
    narrate(`Path not found: ${absPath}`, 'err');
    process.exit(1);
  }

  // Load .heal.json config if present (service ID, URL)
  let config = {};
  const configPath = path.join(absPath, '.heal.json');
  if (fs.existsSync(configPath)) {
    try { config = JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch {}
  }

  const serviceId  = options.serviceId  || config.serviceId  || process.env.RENDER_SERVICE_ID;
  const serviceUrl = options.serviceUrl || config.serviceUrl || process.env.RENDER_SERVICE_URL;

  if (!serviceId) {
    narrate('No Render service ID found. Pass --service-id <id>, set RENDER_SERVICE_ID env var, or add a .heal.json with {"serviceId":"...","serviceUrl":"..."}', 'err');
    process.exit(1);
  }

  separator('═');
  console.log(chalk.bold('\n🩺 Deploy Doctor — Self-Healing Deploy Loop'));
  console.log(chalk.dim(`   Repo     : ${absPath}`));
  console.log(chalk.dim(`   Service  : ${serviceId}`));
  console.log(chalk.dim(`   Platform : Render\n`));
  separator('═');

  // ── Step 1: Pre-flight scan ──────────────────────────────────────────────
  narrate('Step 1/7 — Running pre-flight scan to predict risks…', 'step');
  const storageIssues = await checkEphemeralStorage(absPath);
  const healthIssues  = await checkHealthEndpoint(absPath);
  const allIssues     = [...storageIssues, ...healthIssues];

  if (allIssues.length === 0) {
    narrate('No critical deployment risks detected. Nothing to heal.', 'ok');
  } else {
    narrate(`Pre-flight found ${storageIssues.length} ephemeral-storage risk(s) + ${healthIssues.length} health-check issue(s)`, 'warn');
    for (const issue of allIssues) {
      narrate(`  ${chalk.red('→')} [${issue.severity}] ${issue.description}`, 'dim');
    }
  }

  // ── Local-only mode: patch without deploying ──────────────────────────────
  if (options.localOnly) {
    narrate('\n[local-only mode] Applying patches without deploying to Render…', 'step');
    const patchResults = await patchRepoForEphemeralIssues(absPath);
    if (patchResults.length === 0) {
      narrate('No auto-patchable issues found.', 'warn');
    } else {
      for (const pr of patchResults) {
        if (pr.file === '__health_endpoint__') {
          narrate('Injected /health endpoint into entry file', 'ok');
          continue;
        }
        if (options.verbose) {
          for (const p of pr.patches) {
            separator(); console.log(chalk.dim(p.diff || '')); separator();
          }
        }
        fs.writeFileSync(pr.absFile, pr.finalContent, 'utf8');
        narrate(`Patched + written: ${chalk.cyan(pr.file)}`, 'ok');
      }
    }
    narrate('\nPatches applied locally. Push to GitHub and redeploy Render to complete the heal.', 'ok');
    return;
  }

  narrate(chalk.dim('\n  ℹ  Note: Render deploys from your connected GitHub repo. Local patches must be'), 'dim');
  narrate(chalk.dim('     pushed to GitHub before a redeploy can pick them up.\n'), 'dim');

  const report = {
    before:  { deployStatus: 'unknown', errorLine: null, rootCause: 'unknown', predictedByCheck: 'Ephemeral Storage' },
    patches: [],
    after:   { deployStatus: 'unknown', healthy: false, healthBody: '', healthError: '' },
    attempts: 0,
  };

  let lastDeployId = null;
  let deployStartTime = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    report.attempts = attempt;
    narrate(`\nAttempt ${attempt}/${MAX_ATTEMPTS}`, 'step');

    // ── Step 2: Trigger deploy ─────────────────────────────────────────────
    narrate('Step 2/7 — Triggering deploy on Render…', 'step');
    let deploy;
    try {
      deploy = await render.triggerDeploy(serviceId, attempt > 1);
      lastDeployId    = deploy.id;
      deployStartTime = new Date().toISOString();
      narrate(`Deploy triggered → ID: ${chalk.cyan(deploy.id)}`, 'ok');
    } catch (err) {
      narrate(`Failed to trigger deploy: ${err.message}`, 'err');
      if (err.message.includes('rate limit') || err.message.includes('429')) {
        narrate('Render rate-limited. Waiting 30 s…', 'warn');
        await sleep(30000);
        continue;
      }
      break;
    }

    // ── Step 3: Poll deploy status ─────────────────────────────────────────
    narrate('Step 3/7 — Polling deploy status…', 'step');
    let finalDeploy;
    try {
      finalDeploy = await render.pollDeploy(serviceId, deploy.id, {
        intervalMs: 8000,
        maxWaitMs:  300000,
        onTick: (d) => narrate(`  deploy status: ${chalk.yellow(d.status)}`, 'dim'),
      });
    } catch (err) {
      narrate(`Deploy poll error: ${err.message}`, 'err');
      break;
    }

    report.before.deployStatus = finalDeploy.status;
    narrate(`Deploy finished with status: ${chalk.bold(finalDeploy.status)}`, finalDeploy.status === 'live' ? 'ok' : 'err');

    // ── Step 4a: If live — verify health ──────────────────────────────────
    if (finalDeploy.status === 'live' && serviceUrl) {
      narrate('Step 4/7 — Deploy succeeded, verifying /health endpoint…', 'step');
      await sleep(5000); // wait for process to fully start
      const health = await render.pingHealth(serviceUrl);
      if (health.ok) {
        report.after.deployStatus = 'live';
        report.after.healthy      = true;
        report.after.healthBody   = health.body;
        narrate(`/health returned ${health.status} — ${health.body}`, 'ok');
        printFinalReport(report);
        return;
      } else {
        narrate(`/health returned ${health.status} (${health.body}) — app is up but unhealthy`, 'warn');
      }
    }

    if (finalDeploy.status === 'live' && !serviceUrl) {
      narrate('Deploy is live. No serviceUrl configured — cannot verify /health. Set RENDER_SERVICE_URL or add to .heal.json.', 'warn');
      report.after.deployStatus = 'live';
      report.after.healthy = true;
      printFinalReport(report);
      return;
    }

    // ── Step 4b: Fetch crash logs ──────────────────────────────────────────
    narrate('Step 4/7 — Fetching crash logs from Render…', 'step');
    await sleep(6000); // logs may take a moment to flush

    let logLines = [];
    try {
      logLines = await render.fetchLogsWithRetry(serviceId, {
        maxAttempts: 5,
        backoffMs:   4000,
        startTime:   deployStartTime,
      });
      narrate(`Fetched ${logLines.length} log lines`, 'ok');
    } catch (err) {
      narrate(`Could not fetch logs: ${err.message}`, 'warn');
    }

    // ── Step 5: Analyze root cause ─────────────────────────────────────────
    narrate('Step 5/7 — Analyzing root cause…', 'step');
    const errorLines  = findErrorLines(logLines);
    const crashFindings = analyzeLogsForCrash(logLines);

    if (errorLines.length > 0) {
      const topErr = errorLines[0].message;
      report.before.errorLine = topErr;
      narrate(`Key error line: ${chalk.red.italic(topErr)}`, 'err');
    }

    if (crashFindings.length > 0) {
      const top = crashFindings[0];
      report.before.rootCause        = top.cause;
      report.before.predictedByCheck = top.check || 'Ephemeral Storage';
      narrate(`Root cause identified: ${chalk.yellow.bold(top.cause)}`, 'warn');
      narrate(`Cross-referenced: Deploy Doctor predicted this with "${top.check}" check ✔`, 'ok');
    } else {
      // Fallback: use pre-flight scan results
      if (storageIssues.length > 0) {
        report.before.rootCause        = 'ephemeral-storage (predicted by pre-flight scan)';
        report.before.predictedByCheck = 'Ephemeral Storage';
        narrate('No clear log signature — using pre-flight scan prediction: ephemeral storage risk', 'warn');
      } else {
        narrate('Could not determine root cause from logs. Manual inspection needed.', 'warn');
        if (attempt >= MAX_ATTEMPTS) break;
        continue;
      }
    }

    // ── Step 6: Patch files ────────────────────────────────────────────────
    narrate('Step 6/7 — Generating and applying code patches…', 'step');
    const patchResults = await patchRepoForEphemeralIssues(absPath);

    if (patchResults.length === 0) {
      narrate('No auto-patchable issues found. Cannot proceed automatically.', 'err');
      break;
    }

    for (const pr of patchResults) {
      if (pr.file === '__health_endpoint__') {
        // Apply health endpoint fix
        try {
          const { applyHealthCheckFix } = require('./fixer');
          // Silent version
          const ENTRY_CANDIDATES = ['index.js','app.js','server.js','main.js'];
          let pkgMain = null;
          try { pkgMain = JSON.parse(fs.readFileSync(path.join(absPath,'package.json'),'utf8')).main; } catch {}
          const candidates = pkgMain ? [pkgMain,...ENTRY_CANDIDATES] : ENTRY_CANDIDATES;
          for (const c of candidates) {
            const full = path.join(absPath, c);
            if (fs.existsSync(full)) {
              const orig = fs.readFileSync(full,'utf8');
              const appVar = (orig.match(/(?:const|let|var)\s+(\w+)\s*=\s*express\s*\(\s*\)/) || [null,'app'])[1];
              const snippet = `\n// Health-check endpoint (added by deploy-doctor)\n${appVar}.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));\n`;
              const listenMatch = orig.match(/\b(?:app|server)\.listen\s*\(/);
              let insertAt = orig.length;
              if (listenMatch?.index !== undefined) { let idx=listenMatch.index; while(idx>0&&orig[idx-1]!=='\n')idx--; insertAt=idx; }
              fs.writeFileSync(full, orig.slice(0,insertAt)+snippet+orig.slice(insertAt));
              narrate(`Injected /health endpoint into ${chalk.cyan(c)}`, 'ok');
              break;
            }
          }
        } catch {}
        report.patches.push({ file: 'entry file', description: 'Injected GET /health → 200 { status: "ok" }' });
        continue;
      }

      // Show diff
      for (const p of pr.patches) {
        narrate(`Patching ${chalk.cyan(pr.file)} — ${p.description}`, 'ok');
        if (options.verbose) {
          separator();
          console.log(chalk.dim(p.diff || ''));
          separator();
        }
      }

      // Write the patched file
      fs.writeFileSync(pr.absFile, pr.finalContent, 'utf8');
      narrate(`Written: ${chalk.cyan(pr.file)}`, 'ok');

      for (const p of pr.patches) {
        report.patches.push({ file: pr.file, description: p.description });
      }
    }

    // Push patches to GitHub (which triggers Render auto-deploy)
    narrate('Step 6b/7 — Pushing patches to GitHub…', 'step');

    let pushed = false;
    const githubInfo = config.githubRepo
      ? parseGitHubRepo('https://github.com/' + config.githubRepo)
      : null;

    if (!githubInfo) {
      // Fall back to local git commit
      const committed = await tryGitCommit(absPath, 'fix: deploy-doctor auto-patch for ephemeral storage risks');
      if (committed) {
        narrate('Git commit created (push manually to trigger redeploy)', 'ok');
      } else {
        narrate('No githubRepo in .heal.json and git not available — add "githubRepo":"owner/repo" to .heal.json for auto-push', 'warn');
      }
    } else {
      try {
        const pushResults = await pushPatchesToGitHub(patchResults, absPath, githubInfo, config.branch || 'main');
        for (const r of pushResults) {
          narrate(`Pushed ${chalk.cyan(r.path)} → commit ${chalk.dim(r.commitSha?.slice(0,8))}`, 'ok');
        }
        narrate('GitHub push complete — Render will auto-deploy from the new commit', 'ok');
        pushed = true;
        // Wait for Render to pick up the new commit
        narrate('Waiting 15s for Render to detect the new commit…', 'dim');
        await sleep(15000);
      } catch (err) {
        narrate(`GitHub push failed: ${err.message}`, 'err');
        narrate('Tip: set GITHUB_TOKEN in secrets.env (needs repo scope)', 'warn');
      }
    }

    // ── Step 7: Redeploy ───────────────────────────────────────────────────
    narrate('Step 7/7 — Triggering redeploy with patched code…', 'step');
    // (next loop iteration will do the deploy)
    // Update loop state and continue
    continue;
  }

  // ── Final status if loop ended without resolution ──────────────────────────
  if (!report.after.healthy) {
    narrate(`\nMax attempts (${MAX_ATTEMPTS}) reached. Checking final deploy status…`, 'warn');
    if (serviceUrl) {
      const health = await render.pingHealth(serviceUrl).catch(() => ({ ok: false, body: 'unreachable' }));
      report.after.healthy    = health.ok;
      report.after.healthBody = health.body;
      report.after.healthError = health.ok ? '' : `HTTP ${health.status}: ${health.body}`;
      report.after.deployStatus = health.ok ? 'live' : 'failed';
    }
  }

  printFinalReport(report);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { runHeal, runHealWithNarrator };
