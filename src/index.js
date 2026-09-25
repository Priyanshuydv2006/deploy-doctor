'use strict';

const path = require('path');
const fs = require('fs');
const { checkHardcodedSecrets } = require('./checks/secrets');
const { checkEnvVariables } = require('./checks/envVars');
const { checkEphemeralStorage } = require('./checks/ephemeralStorage');
const { checkHealthEndpoint } = require('./checks/healthEndpoint');
const { renderReport, renderJson } = require('./reporter');
const { applyHealthCheckFix } = require('./fixer');

/**
 * @typedef {Object} Issue
 * @property {'Critical'|'Warning'|'Info'} severity
 * @property {string} check
 * @property {string} file
 * @property {number|null} line
 * @property {string} description
 * @property {string} fix
 */

async function runScan(repoPath, options = {}) {
  const absolutePath = path.resolve(repoPath);

  if (!fs.existsSync(absolutePath)) {
    console.error(`Error: Path does not exist: ${absolutePath}`);
    process.exit(1);
  }

  if (!options.json) {
    const chalk = require('chalk');
    console.log(chalk.bold('\n🩺 Deploy Doctor — scanning ' + absolutePath + '\n'));
  }

  // Run all checks in parallel
  const [secretIssues, envIssues, storageIssues, healthIssues] = await Promise.all([
    checkHardcodedSecrets(absolutePath),
    checkEnvVariables(absolutePath),
    checkEphemeralStorage(absolutePath),
    checkHealthEndpoint(absolutePath),
  ]);

  const issues = [...secretIssues, ...envIssues, ...storageIssues, ...healthIssues];

  if (options.json) {
    renderJson(issues);
    return;
  }

  renderReport(issues);

  // Auto-fix: health-check endpoint
  if (options.fix && healthIssues.length > 0) {
    await applyHealthCheckFix(absolutePath);
  }
}

module.exports = { runScan };
