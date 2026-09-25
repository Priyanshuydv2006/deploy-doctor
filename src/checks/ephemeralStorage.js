'use strict';

/**
 * Check 3 — Ephemeral storage risk
 *
 * Detects usage patterns that write data to the local filesystem in ways
 * that will be silently wiped on platforms with ephemeral storage
 * (Render free tier, Fly.io, Heroku, Railway, etc.).
 *
 * Patterns detected:
 *   - sqlite3 / better-sqlite3  require/import
 *   - fs.writeFile / fs.writeFileSync with a relative path (not /tmp)
 *   - multer({ storage: multer.diskStorage(...) })
 *
 * Severity: Critical
 */

const fs = require('fs');
const path = require('path');
const { glob } = require('glob');

const EPHEMERAL_PATTERNS = [
  {
    // SQLite via sqlite3 or better-sqlite3
    regex: /require\s*\(\s*["'`](sqlite3|better-sqlite3)["'`]\s*\)|from\s+["'`](sqlite3|better-sqlite3)["'`]/,
    description: 'SQLite database detected — the DB file will be wiped on every redeploy on platforms with ephemeral filesystems (Render free tier, Heroku, Railway)',
    fix: 'Replace SQLite with a hosted database (PostgreSQL, MySQL, MongoDB Atlas) and use a connection URL from an environment variable',
    name: 'SQLite dependency',
  },
  {
    // fs.writeFile / fs.writeFileSync with a relative path argument (not /tmp or absolute)
    // Matches: fs.writeFile("./uploads/file.txt") or writeFileSync('data.json')
    regex: /fs\.writeFile(?:Sync)?\s*\(\s*["'`](?!\/tmp|https?:\/\/)([^/'"` ][^'"` ]*|\.[/\\][^'"` ]*)["'`]/,
    description: 'Local file write to a relative path — written files will not persist across deploys or container restarts on ephemeral hosting platforms',
    fix: 'Use persistent cloud storage (AWS S3, GCS, Cloudinary) for uploaded/generated files; for truly temporary files use /tmp',
    name: 'fs.writeFile to relative path',
  },
  {
    // multer diskStorage
    regex: /multer\.diskStorage\s*\(/,
    description: 'multer diskStorage detected — uploaded files are saved to local disk and will be lost on redeploy or container restart on ephemeral hosting platforms',
    fix: 'Replace multer diskStorage with multer-s3 or store files in cloud object storage (S3, GCS) using a stream/buffer approach',
    name: 'multer diskStorage',
  },
];

async function checkEphemeralStorage(repoPath) {
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

    for (const { regex, description, fix, name } of EPHEMERAL_PATTERNS) {
      const seen = new Set(); // avoid duplicate reports per file per pattern
      lines.forEach((line, idx) => {
        if (seen.has(name)) return;
        regex.lastIndex = 0;
        if (regex.test(line)) {
          seen.add(name);
          issues.push({
            severity: 'Critical',
            check: 'Ephemeral Storage',
            file: path.relative(repoPath, file),
            line: idx + 1,
            description,
            fix,
          });
        }
      });
    }
  }

  return issues;
}

module.exports = { checkEphemeralStorage };
