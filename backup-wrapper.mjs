#!/usr/bin/env node
// wip-healthcheck: Node wrapper for daily backup
// Runs via LaunchAgent. Node has fewer FDA issues than /bin/bash with iCloud paths.
// Reads config.json for backup script path and log location.

import { execSync } from 'node:child_process';
import { appendFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const HOME = process.env.HOME || '';
const OPENCLAW_HOME = process.env.OPENCLAW_HOME || join(HOME, '.openclaw');

// Load config
let config = {};
const configPaths = [
  join(__dirname, 'config.json'),
  join(OPENCLAW_HOME, 'wip-healthcheck', 'config.json'),
];
for (const p of configPaths) {
  if (existsSync(p)) {
    try { config = JSON.parse(readFileSync(p, 'utf8')); break; } catch {}
  }
}

const SCRIPT = config.paths?.backupScript || join(__dirname, 'backup.sh');
const LOG_DIR = join(OPENCLAW_HOME, 'logs');
const LOG = join(LOG_DIR, 'daily-backup.log');

if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

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
      HOME,
      OPENCLAW_HOME,
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
