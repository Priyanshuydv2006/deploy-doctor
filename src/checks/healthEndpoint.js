'use strict';

/**
 * Check 4 — Missing health-check endpoint
 *
 * Looks for any route registered on one of the standard health-check paths:
 *   /health, /healthz, /status, /ping
 *
 * Works for Express-style route definitions:
 *   app.get('/health', ...) / router.get('/health', ...)
 *   app.all('/healthz', ...)
 *
 * Severity: Info
 * Supports auto-fix (see fixer.js)
 */

const fs = require('fs');
const path = require('path');
const { glob } = require('glob');

const HEALTH_PATHS = ['/health', '/healthz', '/status', '/ping'];

// Matches: app.get('/health', ...) | router.get('/healthz', ...) | app.all('/ping', ...)
const ROUTE_REGEX = /(?:app|router)\s*\.\s*(?:get|all|use)\s*\(\s*["'`](\/[^"'`]*)["'`]/g;

async function checkHealthEndpoint(repoPath) {
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

    ROUTE_REGEX.lastIndex = 0;
    let match;
    while ((match = ROUTE_REGEX.exec(content)) !== null) {
      const routePath = match[1].split('?')[0].toLowerCase(); // strip query
      if (HEALTH_PATHS.some(hp => routePath === hp || routePath.startsWith(hp + '/'))) {
        // Found a health-check route — no issue
        return [];
      }
    }
  }

  // None found
  return [
    {
      severity: 'Info',
      check: 'Health Check Endpoint',
      file: null,
      line: null,
      description: 'No health-check endpoint found (expected one of: /health, /healthz, /status, /ping)',
      fix: 'Add a GET /health route that returns HTTP 200 with { status: "ok" }. Run with --fix to auto-generate it.',
    },
  ];
}

module.exports = { checkHealthEndpoint };
