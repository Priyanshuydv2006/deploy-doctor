'use strict';

/**
 * github.js — download a GitHub repo as a zip via the GitHub API,
 * extract it to a temp directory, and return the path.
 *
 * No git binary required. Uses only Node.js built-ins.
 *
 * Supports URL formats:
 *   https://github.com/owner/repo
 *   https://github.com/owner/repo/tree/branch
 *   github.com/owner/repo   (no protocol)
 *   owner/repo              (shorthand)
 */

const https = require('https');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

/** Parse a GitHub URL/shorthand into { owner, repo, branch } */
function parseGitHubInput(input) {
  input = input.trim().replace(/\.git$/, '');

  // Full URL: https://github.com/owner/repo[/tree/branch]
  let m = input.match(/(?:https?:\/\/)?github\.com\/([^/]+)\/([^/]+)(?:\/tree\/([^/]+))?/);
  if (m) return { owner: m[1], repo: m[2], branch: m[3] || null };

  // Shorthand: owner/repo[@branch]
  m = input.match(/^([^/]+)\/([^@]+)(?:@(.+))?$/);
  if (m) return { owner: m[1], repo: m[2], branch: m[3] || null };

  return null;
}

/** Fetch the default branch name from the GitHub API */
function fetchDefaultBranch(owner, repo) {
  return new Promise((resolve, reject) => {
    const opts = {
      hostname: 'api.github.com',
      path: `/repos/${owner}/${repo}`,
      headers: { 'User-Agent': 'deploy-doctor/1.0' },
    };
    https.get(opts, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        try {
          const data = JSON.parse(raw);
          if (data.message) return reject(new Error(`GitHub API: ${data.message}`));
          resolve(data.default_branch || 'main');
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });
}

/** Download a URL, following up to 5 redirects, returning a Buffer */
function downloadBuffer(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    if (redirectsLeft === 0) return reject(new Error('Too many redirects'));
    const lib = url.startsWith('https') ? https : require('http');
    lib.get(url, { headers: { 'User-Agent': 'deploy-doctor/1.0' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return resolve(downloadBuffer(res.headers.location, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    }).on('error', reject);
  });
}

/**
 * Minimal ZIP parser — extracts all file entries from a ZIP buffer to disk.
 * Handles DEFLATE and stored (method 0) entries. Skips directories.
 * Strip the first path component (GitHub zips as owner-repo-sha/<files>).
 */
function extractZip(zipBuf, destDir) {
  // Find the End of Central Directory record
  let eocd = -1;
  for (let i = zipBuf.length - 22; i >= 0; i--) {
    if (zipBuf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd === -1) throw new Error('Invalid ZIP: EOCD not found');

  const cdOffset = zipBuf.readUInt32LE(eocd + 16);
  const cdEntries = zipBuf.readUInt16LE(eocd + 10);

  let pos = cdOffset;
  const entries = [];

  for (let i = 0; i < cdEntries; i++) {
    if (zipBuf.readUInt32LE(pos) !== 0x02014b50) break;
    const method      = zipBuf.readUInt16LE(pos + 10);
    const compSize    = zipBuf.readUInt32LE(pos + 20);
    const uncompSize  = zipBuf.readUInt32LE(pos + 24);
    const fnLen       = zipBuf.readUInt16LE(pos + 28);
    const extraLen    = zipBuf.readUInt16LE(pos + 30);
    const commentLen  = zipBuf.readUInt16LE(pos + 32);
    const localOffset = zipBuf.readUInt32LE(pos + 42);
    const filename    = zipBuf.slice(pos + 46, pos + 46 + fnLen).toString('utf8');
    entries.push({ method, compSize, uncompSize, localOffset, filename });
    pos += 46 + fnLen + extraLen + commentLen;
  }

  for (const entry of entries) {
    if (entry.filename.endsWith('/')) continue; // directory

    // Strip leading component (github.com zip has "owner-repo-sha/...")
    const stripped = entry.filename.replace(/^[^/]+\//, '');
    if (!stripped) continue;

    // Parse local file header to get actual data offset
    const lPos = entry.localOffset;
    if (zipBuf.readUInt32LE(lPos) !== 0x04034b50) continue;
    const lFnLen    = zipBuf.readUInt16LE(lPos + 26);
    const lExtraLen = zipBuf.readUInt16LE(lPos + 28);
    const dataStart = lPos + 30 + lFnLen + lExtraLen;
    const compData  = zipBuf.slice(dataStart, dataStart + entry.compSize);

    const outPath = path.join(destDir, stripped);
    fs.mkdirSync(path.dirname(outPath), { recursive: true });

    if (entry.method === 0) {
      // Stored (no compression)
      fs.writeFileSync(outPath, compData);
    } else if (entry.method === 8) {
      // DEFLATE
      const raw = zlib.inflateRawSync(compData);
      fs.writeFileSync(outPath, raw);
    }
    // skip other compression methods
  }
}

/**
 * Main export: given a GitHub URL/shorthand, download + extract to a temp
 * dir and return { tempDir, owner, repo, branch }.
 * Caller is responsible for cleanup (rimrafSync(tempDir)).
 */
async function fetchGitHubRepo(input) {
  const parsed = parseGitHubInput(input);
  if (!parsed) throw new Error('Could not parse GitHub URL. Try: https://github.com/owner/repo');

  const { owner, repo } = parsed;
  let { branch } = parsed;

  if (!branch) branch = await fetchDefaultBranch(owner, repo);

  const zipUrl = `https://github.com/${owner}/${repo}/archive/refs/heads/${branch}.zip`;
  const zipBuf = await downloadBuffer(zipUrl);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `deploy-doctor-${repo}-`));
  extractZip(zipBuf, tempDir);
  return { tempDir, owner, repo, branch };
}

/** Remove a directory tree synchronously */
function rimrafSync(dirPath) {
  try { fs.rmSync(dirPath, { recursive: true, force: true }); } catch {}
}

module.exports = { parseGitHubInput, fetchGitHubRepo, rimrafSync };
