'use strict';

/**
 * Auto-fixer — injects a minimal /health route into the detected entry file
 *
 * Supports Express (the only framework in scope for now).
 * Shows a diff before writing, prompts for confirmation.
 */

const fs = require('fs');
const path = require('path');
const prompts = require('prompts');
const chalk = require('chalk');

/** Common entry-point filenames, in priority order */
const ENTRY_CANDIDATES = ['index.js', 'app.js', 'server.js', 'main.js', 'src/index.js', 'src/app.js', 'src/server.js'];

/**
 * Read package.json and return the "main" field if set, otherwise null.
 */
function getPackageMain(repoPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
    return pkg.main || null;
  } catch {
    return null;
  }
}

/**
 * Detect the JS framework from package.json dependencies.
 * Returns 'express' or 'unknown'.
 */
function detectFramework(repoPath) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoPath, 'package.json'), 'utf8'));
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if (deps['express']) return 'express';
    if (deps['fastify']) return 'fastify';
    if (deps['koa']) return 'koa';
    if (deps['hapi'] || deps['@hapi/hapi']) return 'hapi';
  } catch {
    // ignore
  }
  return 'unknown';
}

/**
 * Resolve the entry file to patch.
 */
function resolveEntryFile(repoPath) {
  const pkgMain = getPackageMain(repoPath);
  const candidates = pkgMain
    ? [pkgMain, ...ENTRY_CANDIDATES]
    : ENTRY_CANDIDATES;

  for (const candidate of candidates) {
    const full = path.join(repoPath, candidate);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * Build the health-check snippet appropriate for the detected framework.
 */
function buildHealthSnippet(framework, appVarName = 'app') {
  if (framework === 'express' || framework === 'unknown') {
    return `\n// Health-check endpoint (added by deploy-doctor)\n${appVarName}.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }));\n`;
  }
  if (framework === 'fastify') {
    return `\n// Health-check endpoint (added by deploy-doctor)\n${appVarName}.get('/health', async () => ({ status: 'ok' }));\n`;
  }
  if (framework === 'koa') {
    return `\n// Health-check endpoint (added by deploy-doctor)\nrouter.get('/health', (ctx) => { ctx.body = { status: 'ok' }; });\n`;
  }
  // Generic fallback
  return `\n// Health-check endpoint — manually integrate this into your framework\n// GET /health → 200 { status: 'ok' }\n`;
}

/**
 * Find the variable name used for the express app instance in a file.
 * Looks for: const app = express(), let app = express(), var app = express()
 * Falls back to 'app'.
 */
function detectAppVarName(content) {
  const m = content.match(/(?:const|let|var)\s+(\w+)\s*=\s*(?:express|require\s*\(\s*["'`]express["'`]\s*\)\s*)\s*\(\s*\)/);
  return m ? m[1] : 'app';
}

/**
 * Find the best insertion point: just before app.listen() or at the end of the file.
 * Returns the character index at which to insert.
 */
function findInsertionPoint(content) {
  // Try to insert just before the first app.listen / server.listen call
  const listenMatch = content.match(/\b(?:app|server)\.listen\s*\(/);
  if (listenMatch && listenMatch.index !== undefined) {
    // Walk back to find the start of the line
    let idx = listenMatch.index;
    while (idx > 0 && content[idx - 1] !== '\n') idx--;
    return idx;
  }
  // Fallback: insert at end
  return content.length;
}

/** Render a simple +/- diff for display */
function renderDiff(original, patched, filePath) {
  const origLines = original.split('\n');
  const patchLines = patched.split('\n');

  console.log(chalk.bold(`\n--- ${filePath} (original)`));
  console.log(chalk.bold(`+++ ${filePath} (patched)\n`));

  // Find first differing line
  let firstDiff = 0;
  while (firstDiff < origLines.length && origLines[firstDiff] === patchLines[firstDiff]) firstDiff++;

  const CONTEXT = 3;
  const start = Math.max(0, firstDiff - CONTEXT);
  const end = Math.min(patchLines.length - 1, firstDiff + 8);

  for (let i = start; i <= end; i++) {
    const pLine = patchLines[i];
    const oLine = origLines[i];
    if (oLine === undefined) {
      // New line
      console.log(chalk.green('+ ' + pLine));
    } else if (pLine === oLine) {
      console.log(chalk.dim('  ' + pLine));
    } else {
      console.log(chalk.red('- ' + oLine));
      console.log(chalk.green('+ ' + pLine));
    }
  }
  console.log('');
}

async function applyHealthCheckFix(repoPath) {
  const chalk = require('chalk');
  console.log(chalk.bold('\n🔧 Auto-fix: Health-check endpoint\n'));

  const entryFile = resolveEntryFile(repoPath);
  if (!entryFile) {
    console.log(chalk.yellow('  Could not detect an entry file to patch. Looked for: ' + ENTRY_CANDIDATES.join(', ')));
    console.log(chalk.dim('  Create the health-check route manually.\n'));
    return;
  }

  const framework = detectFramework(repoPath);
  console.log(chalk.dim(`  Entry file : ${path.relative(repoPath, entryFile)}`));
  console.log(chalk.dim(`  Framework  : ${framework}`));

  const original = fs.readFileSync(entryFile, 'utf8');
  const appVar = detectAppVarName(original);
  const snippet = buildHealthSnippet(framework, appVar);
  const insertAt = findInsertionPoint(original);

  const patched = original.slice(0, insertAt) + snippet + original.slice(insertAt);

  renderDiff(original, patched, path.relative(repoPath, entryFile));

  const response = await prompts({
    type: 'confirm',
    name: 'apply',
    message: 'Apply this change?',
    initial: true,
  });

  if (!response.apply) {
    console.log(chalk.yellow('  Skipped.\n'));
    return;
  }

  fs.writeFileSync(entryFile, patched, 'utf8');
  console.log(chalk.green.bold(`  ✔ Written to ${path.relative(repoPath, entryFile)}\n`));
}

module.exports = { applyHealthCheckFix };
