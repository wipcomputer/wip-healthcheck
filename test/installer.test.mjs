import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const installer = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));

test('installer deploys both runtime modules outside the repository', () => {
  assert.match(installer, /INSTALL_ROOT="\$\{OPENCLAW_HOME:-\$HOME\/\.openclaw\}\/wip-healthcheck"/);
  assert.match(installer, /install -m 644 "\$SCRIPT_DIR\/healthcheck\.mjs"/);
  assert.match(installer, /install -m 644 "\$SCRIPT_DIR\/gateway-health\.mjs"/);
  assert.match(installer, /mv "\$STAGE_DIR" "\$RELEASE_DIR"/);
  assert.match(installer, /<string>\$SCRIPT_PATH<\/string>/);
});

test('installer preserves config and gates launchd bootstrap on authenticated preflight', () => {
  assert.match(installer, /if \[ -e "\$INSTALL_ROOT\/config\.json" \]/);
  assert.match(installer, /chmod 600 "\$INSTALL_ROOT\/config\.json"/);
  const preflight = installer.indexOf('--reenable-preflight');
  const bootstrap = installer.indexOf('launchctl bootstrap');
  assert.ok(preflight > 0);
  assert.ok(bootstrap > preflight);
});

test('isolated install stages a complete runtime before launchd bootstrap', () => {
  const root = mkdtempSync(join(tmpdir(), 'wip-healthcheck-install-'));
  const source = join(root, 'source');
  const bin = join(root, 'bin');
  const home = join(root, 'home');
  const openclawHome = join(root, 'openclaw');
  const trace = join(root, 'trace.log');
  mkdirSync(source);
  mkdirSync(bin);
  mkdirSync(home);
  for (const file of ['install.sh', 'healthcheck.mjs', 'gateway-health.mjs']) {
    cpSync(join(repoRoot, file), join(source, file));
  }
  cpSync(join(repoRoot, 'config.example.json'), join(source, 'config.json'));
  for (const command of ['node', 'launchctl']) {
    const script = join(bin, command);
    writeFileSync(script, `#!/bin/sh\nprintf '%s %s\\n' ${command} "$*" >> "$TRACE"\nexit 0\n`);
    chmodSync(script, 0o755);
  }

  try {
    const result = spawnSync('/bin/bash', [join(source, 'install.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        OPENCLAW_HOME: openclawHome,
        PATH: `${bin}:/usr/bin:/bin`,
        TRACE: trace,
      },
    });
    assert.equal(result.status, 0, result.stderr);

    const installRoot = join(openclawHome, 'wip-healthcheck');
    assert.equal(statSync(join(installRoot, 'config.json')).mode & 0o777, 0o600);
    const releases = readdirSync(join(installRoot, 'runtime'));
    assert.equal(releases.length, 1);
    const releaseDir = join(installRoot, 'runtime', releases[0]);
    assert.equal(statSync(join(releaseDir, 'healthcheck.mjs')).isFile(), true);
    assert.equal(statSync(join(releaseDir, 'gateway-health.mjs')).isFile(), true);

    const plist = readFileSync(join(home, 'Library/LaunchAgents/ai.openclaw.healthcheck.plist'), 'utf8');
    assert.match(plist, new RegExp(`${releaseDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/healthcheck\\.mjs`));
    assert.doesNotMatch(plist, new RegExp(source.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    const calls = readFileSync(trace, 'utf8');
    assert.match(calls, /node .*--reenable-preflight/);
    assert.ok(calls.indexOf('launchctl bootout') < calls.indexOf('launchctl bootstrap'));
    assert.ok(calls.indexOf('--reenable-preflight') < calls.indexOf('launchctl bootstrap'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
