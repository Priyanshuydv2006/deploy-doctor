'use strict';

/**
 * patcher.js — code patch generator for known deployment issues
 *
 * Each patcher receives the file content + repo path, returns:
 *   { patched: string, diff: string, description: string } | null (if not applicable)
 *
 * Currently implemented:
 *   patchEphemeralSQLite   — replace better-sqlite3/sqlite3 file path with DATABASE_URL env var shim
 *   patchHealthEndpoint    — already in fixer.js; re-exported here for uniform interface
 */

const fs = require('fs');
const path = require('path');

// ── Diff helper ───────────────────────────────────────────────────────────────

function buildDiff(original, patched, filePath) {
  const oLines = original.split('\n');
  const pLines = patched.split('\n');

  const lines = [];
  lines.push(`--- ${filePath} (before)`);
  lines.push(`+++ ${filePath} (after)`);

  // Find first differing line
  let firstDiff = 0;
  while (firstDiff < oLines.length && firstDiff < pLines.length && oLines[firstDiff] === pLines[firstDiff]) firstDiff++;

  // Find last differing line (from end)
  let lastO = oLines.length - 1;
  let lastP = pLines.length - 1;
  while (lastO > firstDiff && lastP > firstDiff && oLines[lastO] === pLines[lastP]) { lastO--; lastP--; }

  const CONTEXT = 3;
  const ctxStart = Math.max(0, firstDiff - CONTEXT);

  // Print context before
  for (let i = ctxStart; i < firstDiff; i++) lines.push('  ' + oLines[i]);

  // Print removed lines
  for (let i = firstDiff; i <= lastO; i++) lines.push('- ' + oLines[i]);

  // Print added lines
  for (let i = firstDiff; i <= lastP; i++) lines.push('+ ' + pLines[i]);

  // Print context after
  const ctxEnd = Math.min(oLines.length - 1, lastO + CONTEXT + (lastP - lastO));
  for (let i = lastO + 1; i <= ctxEnd; i++) lines.push('  ' + oLines[i]);

  return lines.join('\n');
}

// ── SQLite → DATABASE_URL patcher ────────────────────────────────────────────

/**
 * Replaces a hard-wired SQLite file path with a DATABASE_URL-driven approach.
 *
 * Transforms:
 *   const db = new Database('./data/app.db')
 *   → const db = new Database(process.env.DATABASE_URL || ':memory:')
 *
 * Also injects a warning comment explaining that :memory: is the safe fallback
 * for ephemeral environments, and recommends a real hosted DB URL.
 *
 * Returns { patched, diff, description } or null if no SQLite usage found.
 */
function patchEphemeralSQLite(content, filePath) {
  // Match: new Database('...') or new Database("...") or require('sqlite3')
  const SQLITE_CONSTRUCTOR = /new\s+Database\s*\(\s*(['"`])([^'"`]+)\1\s*\)/g;

  if (!SQLITE_CONSTRUCTOR.test(content)) return null;
  SQLITE_CONSTRUCTOR.lastIndex = 0;

  const envComment = [
    '// Deploy Doctor patch: replaced hardcoded SQLite path with DATABASE_URL env var.',
    '// Set DATABASE_URL to a hosted DB connection string (e.g. PostgreSQL on Render)',
    '// or leave unset to fall back to in-memory SQLite (data lost on restart — testing only).',
  ].join('\n');

  // Replace the whole statement: find the line containing new Database(...) and replace it
  let patched = content.replace(
    /^([ \t]*)(.+new\s+Database\s*\()(['"`])([^'"`]+)\3(\s*\))/gm,
    (match, indent, prefix, q, filePth) => {
      if (filePth === ':memory:') return match;
      // Preserve the variable declaration prefix (e.g. "const db = ")
      const varDecl = prefix.replace(/new\s+Database\s*\($/, '').trimEnd();
      const lines = [
        `${indent}${envComment.split('\n').join('\n' + indent)}`,
        `${indent}${varDecl ? varDecl + '\n' + indent : ''}new Database(process.env.DATABASE_URL || ':memory:')`,
      ];
      return lines.join('\n');
    }
  );

  // Ensure DATABASE_URL is mentioned in .env.example awareness comment if not already there
  const diff = buildDiff(content, patched, filePath);
  return {
    patched,
    diff,
    description: 'Replaced hardcoded SQLite file path with process.env.DATABASE_URL (falls back to :memory: for ephemeral environments)',
    envVarsAdded: ['DATABASE_URL'],
  };
}

// ── fs.writeFile relative path patcher ───────────────────────────────────────

/**
 * Replaces fs.writeFile/writeFileSync calls to relative paths with /tmp paths.
 * This is the minimal safe change for Render's ephemeral filesystem.
 */
function patchRelativeFileWrite(content, filePath) {
  const FS_WRITE = /(fs\.writeFile(?:Sync)?)\s*\(\s*(['"`])(\.\/[^'"`]+)\2/g;

  if (!FS_WRITE.test(content)) return null;
  FS_WRITE.lastIndex = 0;

  const envComment = '// Deploy Doctor patch: redirected relative file write to /tmp (ephemeral but survives process lifetime).\n// For persistence across deploys, use cloud storage (S3, GCS, Cloudinary).';

  let patched = content.replace(FS_WRITE, (match, fn, q, relPath) => {
    const basename = path.basename(relPath);
    return `${fn}(\`/tmp/${basename}\``;
  });

  // Add comment above first patched write
  patched = patched.replace(/(fs\.writeFile(?:Sync)?\s*\(`\/tmp\/)/, envComment + '\n$1');

  const diff = buildDiff(content, patched, filePath);
  return {
    patched,
    diff,
    description: 'Redirected fs.writeFile relative path to /tmp — data survives process lifetime but not redeploys. Migrate to cloud storage for true persistence.',
    envVarsAdded: [],
  };
}

// ── multer diskStorage patcher ────────────────────────────────────────────────

/**
 * Replaces multer diskStorage destination to /tmp.
 * Full S3 migration is out of scope for auto-patch; this keeps the app alive.
 */
function patchMulterDiskStorage(content, filePath) {
  const MULTER_DEST = /(destination\s*:\s*)(['"`])\.(\/[^'"`]*)(['"`])/g;

  if (!MULTER_DEST.test(content)) return null;
  MULTER_DEST.lastIndex = 0;

  const envComment = '// Deploy Doctor patch: multer destination redirected to /tmp.\n// For production, replace diskStorage with multer-s3 or stream to cloud storage.';

  let patched = content.replace(MULTER_DEST, `$1'/tmp'`);
  patched = patched.replace(/(destination\s*:\s*'\/tmp')/, envComment + '\n  $1');

  const diff = buildDiff(content, patched, filePath);
  return {
    patched,
    diff,
    description: 'Multer diskStorage destination redirected to /tmp. Migrate to cloud storage (multer-s3) for production.',
    envVarsAdded: [],
  };
}

// ── Entry-point patcher ───────────────────────────────────────────────────────

/**
 * Try all available patchers against a file.
 * Returns array of { patchName, patched, diff, description, envVarsAdded }.
 */
function patchFile(content, relFilePath) {
  const results = [];
  const p1 = patchEphemeralSQLite(content, relFilePath);
  if (p1) results.push({ patchName: 'sqlite-to-env', ...p1 });

  // Chain: apply each patch on top of previous
  let working = p1 ? p1.patched : content;

  const p2 = patchRelativeFileWrite(working, relFilePath);
  if (p2) { results.push({ patchName: 'fs-write-to-tmp', ...p2 }); working = p2.patched; }

  const p3 = patchMulterDiskStorage(working, relFilePath);
  if (p3) { results.push({ patchName: 'multer-to-tmp', ...p3 }); working = p3.patched; }

  return { patches: results, finalContent: working };
}

module.exports = { patchFile, patchEphemeralSQLite, patchRelativeFileWrite, patchMulterDiskStorage, buildDiff };
