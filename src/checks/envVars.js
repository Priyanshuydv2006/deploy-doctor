'use strict';

/**
 * Check 2 — Missing / unused environment variables
 *
 * Parses .env.example for declared variable names, then scans all .js/.ts
 * files for process.env.X usages.  Reports:
 *   - Variables used in code but missing from .env.example  → Warning
 *   - Variables declared in .env.example but never used in code → Warning
 *
 * Severity: Warning
 */

const fs = require('fs');
const path = require('path');
const { glob } = require('glob');

/** Parse KEY=value lines from a .env-style file; returns Set of key names */
function parseEnvFile(filePath) {
  const keys = new Set();
  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch {
    return keys;
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (key) keys.add(key);
  }
  return keys;
}

/** Scan source files and collect all process.env.KEY references */
async function collectUsedEnvVars(repoPath) {
  const usages = new Map(); // key → [{file, line}]

  const files = await glob('**/*.{js,ts}', {
    cwd: repoPath,
    ignore: ['**/node_modules/**', '**/*.test.*', '**/*.spec.*', '**/dist/**', '**/build/**'],
    absolute: true,
  });

  // Match: process.env.KEY  or  process.env["KEY"]  or  process.env['KEY']
  const ENV_REF = /process\.env(?:\.([A-Z_a-z]\w*)|(?:\[["'])([A-Z_a-z]\w*)(?:["']\]))/g;

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    const lines = content.split('\n');
    lines.forEach((line, idx) => {
      ENV_REF.lastIndex = 0;
      let m;
      while ((m = ENV_REF.exec(line)) !== null) {
        const key = m[1] || m[2];
        if (!key) continue;
        if (!usages.has(key)) usages.set(key, []);
        usages.get(key).push({ file: path.relative(repoPath, file), line: idx + 1 });
      }
    });
  }

  return usages;
}

async function checkEnvVariables(repoPath) {
  const issues = [];

  const envExamplePath = path.join(repoPath, '.env.example');
  const envExampleExists = fs.existsSync(envExamplePath);
  const declaredKeys = envExampleExists ? parseEnvFile(envExamplePath) : new Set();

  const usedVars = await collectUsedEnvVars(repoPath);

  if (!envExampleExists && usedVars.size === 0) {
    // Nothing to check
    return issues;
  }

  if (!envExampleExists && usedVars.size > 0) {
    issues.push({
      severity: 'Warning',
      check: 'Environment Variables',
      file: '.env.example',
      line: null,
      description: '.env.example is missing — cannot verify environment variable coverage',
      fix: 'Create a .env.example listing all required environment variables (without real values)',
    });
    return issues;
  }

  // Variables used in code but absent from .env.example
  for (const [key, refs] of usedVars.entries()) {
    if (!declaredKeys.has(key)) {
      const firstRef = refs[0];
      issues.push({
        severity: 'Warning',
        check: 'Environment Variables',
        file: firstRef.file,
        line: firstRef.line,
        description: `process.env.${key} is used in code but not declared in .env.example`,
        fix: `Add ${key}= to .env.example so other developers know this variable is required`,
      });
    }
  }

  // Variables declared in .env.example but never referenced in code
  for (const key of declaredKeys) {
    if (!usedVars.has(key)) {
      issues.push({
        severity: 'Warning',
        check: 'Environment Variables',
        file: '.env.example',
        line: null,
        description: `${key} is declared in .env.example but never referenced via process.env`,
        fix: `Remove ${key} from .env.example if it is no longer needed, or add a process.env.${key} reference`,
      });
    }
  }

  return issues;
}

module.exports = { checkEnvVariables };
