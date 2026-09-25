'use strict';

/**
 * Reporter — formats scan results for terminal output or JSON
 */

const chalk = require('chalk');

const SEVERITY_ORDER = ['Critical', 'Warning', 'Info'];

const SEVERITY_STYLES = {
  Critical: chalk.bgRed.white.bold,
  Warning:  chalk.bgYellow.black.bold,
  Info:     chalk.bgCyan.black.bold,
};

const SEVERITY_ICON = {
  Critical: '✖',
  Warning:  '⚠',
  Info:     'ℹ',
};

function formatLocation(issue) {
  if (!issue.file) return '';
  const loc = issue.line ? `${issue.file}:${issue.line}` : issue.file;
  return chalk.dim(` (${loc})`);
}

function renderReport(issues) {
  if (issues.length === 0) {
    console.log(chalk.green.bold('✔ No deployment risks found. Safe to deploy!\n'));
    return;
  }

  // Group by severity
  const grouped = {};
  for (const sev of SEVERITY_ORDER) grouped[sev] = [];
  for (const issue of issues) grouped[issue.severity].push(issue);

  for (const sev of SEVERITY_ORDER) {
    const group = grouped[sev];
    if (group.length === 0) continue;

    const label = SEVERITY_STYLES[sev](` ${sev.toUpperCase()} `);
    console.log(`\n${label}`);
    console.log(chalk.dim('─'.repeat(60)));

    for (const issue of group) {
      const icon = SEVERITY_ICON[sev];
      const iconStyled =
        sev === 'Critical' ? chalk.red(icon) :
        sev === 'Warning'  ? chalk.yellow(icon) :
                             chalk.cyan(icon);

      console.log(`${iconStyled} ${chalk.bold(issue.check)}${formatLocation(issue)}`);
      console.log(`  ${issue.description}`);
      console.log(`  ${chalk.green('→')} ${chalk.italic(issue.fix)}`);
      console.log();
    }
  }

  // Summary line
  const counts = {
    Critical: grouped['Critical'].length,
    Warning:  grouped['Warning'].length,
    Info:     grouped['Info'].length,
  };

  const hasCritical = counts.Critical > 0;
  const verdict = hasCritical
    ? chalk.red.bold('NOT SAFE TO DEPLOY')
    : chalk.green.bold('SAFE TO DEPLOY');

  console.log(chalk.dim('═'.repeat(60)));
  console.log(
    `${chalk.red.bold(counts.Critical + ' Critical')}, ` +
    `${chalk.yellow.bold(counts.Warning + ' Warning')}, ` +
    `${chalk.cyan.bold(counts.Info + ' Info')} — ${verdict}`
  );
  console.log('');
}

function renderJson(issues) {
  const counts = { Critical: 0, Warning: 0, Info: 0 };
  for (const issue of issues) counts[issue.severity]++;

  const output = {
    summary: {
      critical: counts.Critical,
      warning: counts.Warning,
      info: counts.Info,
      safeToDeploy: counts.Critical === 0,
    },
    issues,
  };

  process.stdout.write(JSON.stringify(output, null, 2) + '\n');
}

module.exports = { renderReport, renderJson };
