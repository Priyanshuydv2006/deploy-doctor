'use strict';

/**
 * Check 1 — Hardcoded secrets detection
 *
 * Scans all .js/.ts files for patterns that look like inline secret assignments.
 * Two strategies:
 *   A) Variable name contains a sensitive keyword AND is assigned a literal string value
 *   B) The value itself matches a well-known API key format (Stripe, AWS, etc.)
 *
 * Severity: Critical
 */

const fs = require('fs');
const path = require('path');
const { glob } = require('glob');

const SECRET_PATTERNS = [
  {
    // Strategy A: variable name contains secret / password / token / key, assigned a literal
    // Covers: JWT_SECRET = '...', apiSecret = '...', stripeSecretKey = '...', password = '...'
    regex: /\b([A-Za-z_]\w*(?:SECRET|PASSWORD|PASSWD|PWD|TOKEN|API_?KEY|APIKEY|PRIVATE_?KEY|AUTH_?KEY|ACCESS_?KEY|CLIENT_?SECRET|secret|password|passwd|token|apikey|api_key|private_key|auth_key|access_key|client_secret)\w*)\s*=\s*['"`]([^'"`\r\n]{6,})['"`]/,
    name: 'Potential hardcoded secret (variable assignment)',
    allowProcessEnv: true,
  },
  {
    // Strategy B-1: Stripe-style keys  sk_live_ / sk_test_ / pk_live_ / pk_test_ / rk_live_
    regex: /['"`](sk[_-](?:live|test)_[a-zA-Z0-9]{20,}|pk[_-](?:live|test)_[a-zA-Z0-9]{20,}|rk[_-]live_[a-zA-Z0-9]+)['"`]/,
    name: 'Likely Stripe API key',
    allowProcessEnv: false,
  },
  {
    // Strategy B-2: OpenAI-style  sk-...  (hyphen, no underscore)
    regex: /['"`](sk-[a-zA-Z0-9]{20,})['"`]/,
    name: 'Likely OpenAI API key',
    allowProcessEnv: false,
  },
  {
    // Strategy B-3: AWS Access Key ID
    regex: /['"`](AKIA[0-9A-Z]{16})['"`]/,
    name: 'Likely AWS Access Key ID',
    allowProcessEnv: false,
  },
  {
    // Strategy B-4: Twilio Account SID / Auth Token patterns
    regex: /['"`](AC[a-f0-9]{32}|SK[a-f0-9]{32})['"`]/,
    name: 'Likely Twilio SID/token',
    allowProcessEnv: false,
  },
];

// Lines that are almost certainly safe to skip
const ALLOWLIST = [
  /process\.env[.[]/,    // env lookup
  /^\s*\/\//,            // comment
  /^\s*\*/               // JSDoc
];

function isAllowlisted(line) {
  return ALLOWLIST.some(p => p.test(line));
}

async function checkHardcodedSecrets(repoPath) {
  const issues = [];

  const files = await glob('**/*.{js,ts}', {
    cwd: repoPath,
    ignore: ['**/node_modules/**', '**/*.test.*', '**/*.spec.*', '**/dist/**', '**/build/**'],
    absolute: true,
  });

  for (const file of files) {
    let content;
    try {
      content = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }

    const lines = content.split('\n');

    for (const { regex, name, allowProcessEnv } of SECRET_PATTERNS) {
      lines.forEach((line, idx) => {
        if (isAllowlisted(line)) return;
        regex.lastIndex = 0;
        if (regex.test(line)) {
          // For strategy A, skip if the RHS is actually process.env (belt-and-suspenders)
          if (allowProcessEnv && /process\.env[.[]/i.test(line)) return;
          issues.push({
            severity: 'Critical',
            check: 'Hardcoded Secrets',
            file: path.relative(repoPath, file),
            line: idx + 1,
            description: `${name} found in source code`,
            fix: 'Move this value to an environment variable and reference it via process.env.YOUR_VAR',
          });
        }
      });
    }
  }

  // Deduplicate: keep only first issue per (file, line) pair to avoid multi-pattern double-reporting
  const seen = new Set();
  return issues.filter(issue => {
    const key = `${issue.file}:${issue.line}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

module.exports = { checkHardcodedSecrets };
