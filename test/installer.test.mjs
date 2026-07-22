import assert from 'node:assert/strict';
import {
  chmodSync,
  cpSync,
  existsSync,
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
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { decideGatewayHealth, inspectGatewayIdentity } from '../gateway-health.mjs';

const installer = readFileSync(new URL('../install.sh', import.meta.url), 'utf8');
const repoRoot = dirname(fileURLToPath(new URL('../package.json', import.meta.url)));
const scheduledPath = '/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin';
const scheduledExecutables = [
  'id',
  'launchctl',
  'lsof',
  'pgrep',
  'openclaw',
  'sqlite3',
  'tail',
  'grep',
  'ls',
  'head',
  'osascript',
  'sleep',
  'wc',
];

function writeExecutable(path, body) {
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
}

function gatewayConfig(port) {
  return {
    gateway: {
      host: '127.0.0.1',
      port,
      plistLabel: 'ai.openclaw.gateway',
      processPattern: 'openclaw-gateway',
    },
    thresholds: {
      probeTimeoutMs: 1000,
      gatewayProbeFailureThreshold: 2,
      maxRestartsPerWindow: 3,
      restartWindowMinutes: 15,
    },
  };
}

test('installer deploys both runtime modules outside the repository', () => {
  assert.match(installer, /SCHEDULED_OPENCLAW_HOME="\$\{OPENCLAW_HOME:-\$HOME\/\.openclaw\}"/);
  assert.match(installer, /INSTALL_ROOT="\$SCHEDULED_OPENCLAW_HOME\/wip-healthcheck"/);
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

test('generated LaunchAgent PATH resolves every scheduled executable including lsof', () => {
  assert.match(installer, new RegExp(scheduledPath.replaceAll('/', '\\/')));
  for (const executable of scheduledExecutables) {
    assert.match(installer, new RegExp(`\\n  ${executable}\\n`));
  }
  if (process.platform === 'darwin') {
    const lsof = spawnSync('/bin/sh', ['-c', 'command -v lsof'], {
      encoding: 'utf8',
      env: { PATH: scheduledPath },
    });
    assert.equal(lsof.status, 0, lsof.stderr);
    assert.equal(lsof.stdout.trim(), '/usr/sbin/lsof');
  }
});

test('scheduled environment can inspect the launchd service listener identity', () => {
  const root = mkdtempSync(join(tmpdir(), 'wip-healthcheck-identity-'));
  try {
    const bin = join(root, 'bin');
    mkdirSync(bin);
    writeExecutable(join(bin, 'launchctl'), "printf 'pid = 4242\\n'");
    writeExecutable(join(bin, 'pgrep'), 'exit 1');
    writeExecutable(join(bin, 'lsof'), `
case " $* " in
  *" -Fn "*) printf 'p4242\\nn*:18889\\n' ;;
  *) printf '4242\\n' ;;
esac`);
    const identity = inspectGatewayIdentity(gatewayConfig(18889), {
      uid: process.getuid(),
      run(file, args, timeout) {
        return execFileSync(file, args, {
          encoding: 'utf8',
          timeout,
          env: { PATH: `${bin}:${scheduledPath}` },
        }).trim();
      },
    });
    assert.equal(identity.inspectionError, null);
    assert.equal(identity.configurationError, null);
    assert.deepEqual(identity.foreignListenerPids, []);
    assert.equal(identity.ownsListener, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing lsof in the scheduled environment fails closed without restart authority', () => {
  const identity = inspectGatewayIdentity(gatewayConfig(18889), {
    uid: 501,
    run(file, args, timeout) {
      if (file === 'launchctl') return 'pid = 4242\n';
      if (file === 'pgrep') return '';
      return execFileSync(file, args, {
        encoding: 'utf8',
        timeout,
        env: { PATH: '/usr/bin:/bin' },
      }).trim();
    },
  });
  const decision = decideGatewayHealth({
    identity,
    probes: { healthz: { ok: true }, readyz: { ok: true } },
  });
  assert.match(identity.inspectionError, /spawnSync lsof ENOENT/);
  assert.equal(decision.action, 'inspection-error');
  assert.notEqual(decision.action, 'restart');
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
  writeExecutable(join(bin, 'node'), `
printf 'node %s\\n' "$*" >> "${trace}"
printf 'preflight PATH=%s HOME=%s OPENCLAW_HOME=%s WIP_HEALTHCHECK_HOME=%s\\n' \
  "$PATH" "$HOME" "$OPENCLAW_HOME" "$WIP_HEALTHCHECK_HOME" >> "${trace}"
command -v lsof >/dev/null || exit 42
exit 0`);
  writeExecutable(join(bin, 'launchctl'), `printf 'launchctl %s\\n' "$*" >> "${trace}"\nexit 0`);
  writeExecutable(join(bin, 'openclaw'), 'exit 0');

  const fixtureScheduledPath = `${bin}:${scheduledPath}`;

  try {
    const result = spawnSync('/bin/bash', [join(source, 'install.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        OPENCLAW_HOME: openclawHome,
        PATH: fixtureScheduledPath,
        TRACE: trace,
        WIP_HEALTHCHECK_SCHEDULED_PATH: fixtureScheduledPath,
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
    assert.match(plist, new RegExp(`<key>PATH</key>\\s*<string>${fixtureScheduledPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`));
    assert.match(plist, new RegExp(`<key>HOME</key>\\s*<string>${home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`));
    assert.match(plist, new RegExp(`<key>OPENCLAW_HOME</key>\\s*<string>${openclawHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</string>`));
    const calls = readFileSync(trace, 'utf8');
    assert.match(calls, /node .*--reenable-preflight/);
    assert.match(calls, new RegExp(`preflight PATH=${fixtureScheduledPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} HOME=`));
    assert.match(calls, new RegExp(`OPENCLAW_HOME=${openclawHome.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.match(calls, new RegExp(`WIP_HEALTHCHECK_HOME=${installRoot.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    assert.ok(calls.indexOf('launchctl bootout') < calls.indexOf('launchctl bootstrap'));
    assert.ok(calls.indexOf('--reenable-preflight') < calls.indexOf('launchctl bootstrap'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('installer cannot pass interactively when its scheduled environment lacks lsof', () => {
  const root = mkdtempSync(join(tmpdir(), 'wip-healthcheck-broken-scheduled-env-'));
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
  for (const command of ['node', 'launchctl', 'openclaw']) {
    writeExecutable(join(bin, command), `printf '${command} %s\\n' "$*" >> "$TRACE"\nexit 0`);
  }

  try {
    const result = spawnSync('/bin/bash', [join(source, 'install.sh')], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        OPENCLAW_HOME: openclawHome,
        PATH: `${bin}:${scheduledPath}`,
        TRACE: trace,
        WIP_HEALTHCHECK_SCHEDULED_PATH: `${bin}:/usr/bin:/bin`,
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Scheduled environment missing required executable: lsof/);
    assert.equal(existsSync(trace), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
