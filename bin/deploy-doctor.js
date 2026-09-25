#!/usr/bin/env node
'use strict';

const { program } = require('commander');
const { runScan }   = require('../src/index');
const { startServer } = require('../src/server');
const { runHeal }   = require('../src/heal');

program
  .name('deploy-doctor')
  .description('Scan a Node.js repository for deployment risks before shipping to production')
  .version('1.0.0');

program
  .command('scan <path>')
  .description('Scan a repository for deployment risks')
  .option('--fix', 'Enable auto-fix for the missing health-check endpoint')
  .option('--json', 'Output machine-readable JSON instead of terminal report')
  .action(async (repoPath, options) => {
    try {
      await runScan(repoPath, options);
    } catch (err) {
      console.error('Fatal error:', err.message);
      process.exit(1);
    }
  });

program
  .command('serve')
  .description('Launch the Deploy Doctor web dashboard')
  .option('-p, --port <number>', 'Port to listen on', '4242')
  .action((options) => {
    startServer(parseInt(options.port, 10));
  });

program
  .command('heal <path>')
  .description('Self-healing deploy loop: scan → deploy to Render → detect crash → patch → redeploy → verify')
  .option('--service-id <id>',   'Render service ID (or set RENDER_SERVICE_ID env var)')
  .option('--service-url <url>', 'Deployed service base URL for /health check (or set RENDER_SERVICE_URL)')
  .option('--verbose',           'Print full diffs when patching')
  .option('--local-only',        'Patch files locally only — skip Render deploy (useful for demo without live service)')
  .action(async (repoPath, options) => {
    try {
      await runHeal(repoPath, {
        serviceId:  options.serviceId,
        serviceUrl: options.serviceUrl,
        verbose:    !!options.verbose,
        localOnly:  !!options.localOnly,
      });
    } catch (err) {
      console.error('\nFatal error in heal loop:', err.message);
      if (options.verbose) console.error(err.stack);
      process.exit(1);
    }
  });

program.parse(process.argv);
