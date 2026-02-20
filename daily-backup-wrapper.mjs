#!/usr/bin/env node
// Wrapper for daily-backup.sh — runs via LaunchAgent
// Node has fewer FDA issues than /bin/bash with iCloud paths

import { execSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

const SCRIPT = '/Users/lesa/Documents/wipcomputer--mac-mini-01/staff/Lēsa/scripts/daily-backup.sh';
const LOG = '/Users/lesa/.openclaw/logs/daily-backup.log';

function log(msg) {
  const ts = new Date().toISOString();
  const line = `${ts} ${msg}\n`;
  appendFileSync(LOG, line);
  process.stdout.write(line);
}

try {
  log('Starting daily backup');
  const output = execSync(`/bin/bash "${SCRIPT}"`, {
    encoding: 'utf8',
    timeout: 300000,
    env: {
      ...process.env,
      HOME: '/Users/lesa',
      PATH: '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin',
    },
  });
  log('Backup output:\n' + output);
  log('Backup completed successfully');
} catch (err) {
  log(`Backup FAILED: ${err.message}`);
  if (err.stdout) log(`stdout: ${err.stdout}`);
  if (err.stderr) log(`stderr: ${err.stderr}`);
  process.exit(1);
}
