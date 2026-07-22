import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('malformed config exits without invoking launchctl remediation', () => {
  const root = mkdtempSync(join(tmpdir(), 'wip-healthcheck-config-'));
  const bin = join(root, 'bin');
  const marker = join(root, 'launchctl-called');
  mkdirSync(bin);
  writeFileSync(join(root, 'config.json'), '{not-json');
  writeFileSync(
    join(bin, 'launchctl'),
    `#!/bin/sh\nprintf called > ${JSON.stringify(marker)}\nexit 99\n`,
  );
  chmodSync(join(bin, 'launchctl'), 0o755);

  try {
    const result = spawnSync(process.execPath, [new URL('../healthcheck.mjs', import.meta.url).pathname], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:/usr/bin:/bin`,
        WIP_HEALTHCHECK_HOME: root,
      },
    });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /Invalid watchdog config/);
    assert.equal(existsSync(marker), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
