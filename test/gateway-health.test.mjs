import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideGatewayHealth,
  evaluateRestartBudget,
  inspectGatewayIdentity,
  probeGatewayEndpoints,
} from '../gateway-health.mjs';

const config = {
  gateway: {
    host: '127.0.0.1',
    port: 18889,
    token: 'current-token',
    plistLabel: 'ai.openclaw.gateway',
    processPattern: 'openclaw-gateway',
  },
  thresholds: {
    probeTimeoutMs: 100,
    gatewayProbeFailureThreshold: 2,
    maxRestartsPerWindow: 3,
    restartWindowMinutes: 15,
  },
};

function identity(overrides = {}) {
  return {
    servicePid: 4242,
    listenerPids: [4242],
    ownsListener: true,
    diagnosticPatternMatched: false,
    ...overrides,
  };
}

const greenProbes = {
  healthz: { ok: true, statusCode: 200 },
  readyz: { ok: true, statusCode: 200 },
  authenticated: { ok: true, statusCode: 200 },
};

test('healthy renamed gateway process does not restart', () => {
  const decision = decideGatewayHealth({
    identity: identity({ diagnosticPatternMatched: false }),
    probes: greenProbes,
    probeFailureThreshold: 2,
  });
  assert.equal(decision.action, 'healthy');
});

test('stale or missing launchd pid is detected', () => {
  const decision = decideGatewayHealth({
    identity: identity({ servicePid: null, listenerPids: [], ownsListener: false }),
    probes: greenProbes,
  });
  assert.deepEqual(decision, {
    action: 'restart',
    reason: 'service-absent',
    probeFailures: 0,
  });
});

test('foreign listener is rejected', () => {
  const decision = decideGatewayHealth({
    identity: identity({ listenerPids: [9001], ownsListener: false }),
    probes: greenProbes,
  });
  assert.equal(decision.action, 'restart');
  assert.equal(decision.reason, 'foreign-listener');
});

test('failed probes restart only at the configured threshold', () => {
  const failedProbes = {
    ...greenProbes,
    readyz: { ok: false, statusCode: 503 },
  };
  const first = decideGatewayHealth({
    identity: identity(),
    probes: failedProbes,
    previousProbeFailures: 0,
    probeFailureThreshold: 2,
  });
  assert.equal(first.action, 'observe');
  assert.equal(first.probeFailures, 1);

  const second = decideGatewayHealth({
    identity: identity(),
    probes: failedProbes,
    previousProbeFailures: first.probeFailures,
    probeFailureThreshold: 2,
  });
  assert.equal(second.action, 'restart');
  assert.equal(second.probeFailures, 2);
});

test('stale token fails the authenticated identity probe', async () => {
  const statuses = new Map([
    ['/healthz', 200],
    ['/readyz', 200],
    ['/v1/models', 401],
  ]);
  const requestFn = (options, callback) => {
    assert.equal(options.port, 18889);
    assert.equal(options.headers.Authorization, 'Bearer current-token');
    const handlers = new Map();
    const req = {
      on(event, handler) { handlers.set(event, handler); return req; },
      destroy() {},
      end() {
        callback({
          statusCode: statuses.get(options.path),
          resume() {},
        });
      },
    };
    return req;
  };

  const probes = await probeGatewayEndpoints(config, {
    requestFn,
    includeAuthenticated: true,
  });
  assert.equal(probes.healthz.ok, true);
  assert.equal(probes.readyz.ok, true);
  assert.equal(probes.authenticated.ok, false);
  assert.equal(probes.authenticated.statusCode, 401);
});

test('gateway port and launchd pid come from config and service state', () => {
  const calls = [];
  const result = inspectGatewayIdentity(config, {
    uid: 501,
    run(file, args) {
      calls.push([file, args]);
      if (file === 'launchctl') return 'pid = 4242\nstate = running';
      if (file === 'lsof') return '4242\n';
      if (file === 'pgrep') throw new Error('no diagnostic match');
      throw new Error(`unexpected command: ${file}`);
    },
  });

  assert.equal(result.servicePid, 4242);
  assert.equal(result.port, 18889);
  assert.equal(result.ownsListener, true);
  assert.equal(result.diagnosticPatternMatched, false);
  assert.deepEqual(calls[1], [
    'lsof',
    ['-nP', '-iTCP:18889', '-sTCP:LISTEN', '-t'],
  ]);
});

test('restart rate limiting preserves the configured rolling window', () => {
  const now = 10_000_000;
  const state = {
    restarts: [
      now - (16 * 60 * 1000),
      now - (10 * 60 * 1000),
      now - (5 * 60 * 1000),
      now - (1 * 60 * 1000),
    ],
  };
  const budget = evaluateRestartBudget(config, state, now);
  assert.equal(budget.allowed, false);
  assert.equal(budget.attempts, 3);
  assert.equal(state.restarts.length, 3);
});
