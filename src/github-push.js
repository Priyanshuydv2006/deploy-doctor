'use strict';

/**
 * github-push.js — push a single file update to a GitHub repo via the REST API
 *
 * No git binary required. Uses only Node.js built-ins + your GITHUB_TOKEN.
 *
 * Usage:
 *   const { pushFileToGitHub } = require('./github-push');
 *   await pushFileToGitHub({
 *     owner: 'myuser',
 *     repo:  'my-repo',
 *     path:  'server.js',
 *     content: '<file contents as string>',
 *     message: 'fix: deploy-doctor auto-patch',
 *     branch: 'main',   // optional, defaults to repo default branch
 *   });
 */

const https = require('https');

function getGitHubToken() {
  const t = process.env.GITHUB_TOKEN;
  if (!t) throw new Error('GITHUB_TOKEN environment variable is not set.\nCreate one at https://github.com/settings/tokens (needs repo scope) and set it in secrets.env');
  return t;
}

function githubRequest(method, path, body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : null;
    const opts = {
      hostname: 'api.github.com',
      path,
      method,
      headers: {
        'Authorization': `Bearer ${getGitHubToken()}`,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'deploy-doctor/1.0',
        'Content-Type': 'application/json',
        ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
      },
      timeout: 20000,
    };

    const req = https.request(opts, (res) => {
      let raw = '';
      res.on('data', d => raw += d);
      res.on('end', () => {
        if (res.statusCode === 204) return resolve(null);
        let data;
        try { data = JSON.parse(raw); } catch { data = raw; }
        if (res.statusCode >= 400) {
          const msg = data?.message || `HTTP ${res.statusCode}`;
          return reject(new Error(`GitHub API ${method} ${path}: ${msg}`));
        }
        resolve(data);
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error(`GitHub API timeout: ${path}`)); });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** Get the current SHA of a file (needed for updates) */
async function getFileSha(owner, repo, filePath, branch) {
  try {
    const ref = branch ? `?ref=${encodeURIComponent(branch)}` : '';
    const data = await githubRequest('GET', `/repos/${owner}/${repo}/contents/${filePath}${ref}`);
    return data.sha;
  } catch (err) {
    if (err.message.includes('404')) return null; // file doesn't exist yet
    throw err;
  }
}

/**
 * Push one or more file updates to a GitHub repo in a single API call each.
 *
 * @param {object} opts
 * @param {string} opts.owner
 * @param {string} opts.repo
 * @param {string} opts.branch        defaults to repo's default branch
 * @param {string} opts.message       commit message
 * @param {Array<{path: string, content: string}>} opts.files
 */
async function pushFilesToGitHub({ owner, repo, branch, message, files }) {
  // Resolve default branch if not specified
  if (!branch) {
    const repoData = await githubRequest('GET', `/repos/${owner}/${repo}`);
    branch = repoData.default_branch || 'main';
  }

  const results = [];
  for (const file of files) {
    const sha = await getFileSha(owner, repo, file.path, branch);
    const body = {
      message,
      content: Buffer.from(file.content, 'utf8').toString('base64'),
      branch,
      ...(sha ? { sha } : {}),
    };
    const result = await githubRequest('PUT', `/repos/${owner}/${repo}/contents/${file.path}`, body);
    results.push({
      path: file.path,
      sha: result?.content?.sha,
      commitSha: result?.commit?.sha,
      commitUrl: result?.commit?.html_url,
    });
  }
  return results;
}

/**
 * Get owner/repo from a GitHub URL stored in the Render service's repo URL,
 * or from a .heal.json githubRepo field.
 * Parses: https://github.com/owner/repo[.git]
 */
function parseGitHubRepo(url) {
  const m = url?.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

module.exports = { pushFilesToGitHub, parseGitHubRepo, getFileSha };
