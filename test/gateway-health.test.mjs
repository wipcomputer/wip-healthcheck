import assert from 'node:assert/strict';
import test from 'node:test';

import {
  decideGatewayHealth,
  evaluateRestartBudget,
  inspectGatewayIdentity,
  parseListeningPorts,
  parseWatchdogConfig,
  probeGatewayEndpoints,
  validateWatchdogConfig,
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
    serviceListenerPorts: [18889],
    configuredPortPids: [4242],
    foreignListenerPids: [],
    foreignListenerError: null,
    portMatchesConfig: true,
    inspectionError: null,
    configurationError: null,
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
    identity: identity({
      servicePid: null,
      serviceListenerPorts: [],
      configuredPortPids: [],
      portMatchesConfig: false,
      ownsListener: false,
    }),
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
    identity: identity({
      servicePid: null,
      serviceListenerPorts: [],
      configuredPortPids: [9001],
      foreignListenerPids: [9001],
      foreignListenerError: 'configured gateway port 18889 is also owned by foreign pid(s): 9001',
      portMatchesConfig: false,
      ownsListener: false,
    }),
    probes: greenProbes,
  });
  assert.equal(decision.action, 'inspection-error');
  assert.equal(decision.reason, 'foreign-listener');
});

test('configured port co-ownership fails closed without restart authority', () => {
  const result = inspectGatewayIdentity(config, {
    uid: 501,
    run(file, args) {
      if (file === 'launchctl') return 'pid = 4242\nstate = running';
      if (file === 'lsof' && args.includes('-Fn')) return 'p4242\nn*:18889\n';
      if (file === 'lsof') return '4242\n9001\n';
      if (file === 'pgrep') return '';
      throw new Error(`unexpected command: ${file}`);
    },
  });
  const decision = decideGatewayHealth({ identity: result, probes: greenProbes });

  assert.deepEqual(result.configuredPortPids, [4242, 9001]);
  assert.deepEqual(result.foreignListenerPids, [9001]);
  assert.equal(result.ownsListener, false);
  assert.deepEqual(decision, {
    action: 'inspection-error',
    reason: 'foreign-listener',
    detail: 'configured gateway port 18889 is also owned by foreign pid(s): 9001',
    probeFailures: 0,
  });
  assert.notEqual(decision.action, 'restart');
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

test('gateway port and listener ownership come from launchd service state', () => {
  const calls = [];
  const result = inspectGatewayIdentity(config, {
    uid: 501,
    run(file, args) {
      calls.push([file, args]);
      if (file === 'launchctl') return 'pid = 4242\nstate = running';
      if (file === 'lsof' && args.includes('-Fn')) return 'p4242\nn*:18889\n';
      if (file === 'lsof') return '4242\n';
      if (file === 'pgrep') throw new Error('no diagnostic match');
      throw new Error(`unexpected command: ${file}`);
    },
  });

  assert.equal(result.servicePid, 4242);
  assert.equal(result.port, 18889);
  assert.deepEqual(result.serviceListenerPorts, [18889]);
  assert.equal(result.ownsListener, true);
  assert.equal(result.diagnosticPatternMatched, false);
  assert.deepEqual(calls[1], [
    'lsof',
    ['-nP', '-a', '-p', '4242', '-iTCP', '-sTCP:LISTEN', '-Fn'],
  ]);
  assert.deepEqual(calls[2], [
    'lsof',
    ['-nP', '-iTCP:18889', '-sTCP:LISTEN', '-t'],
  ]);
});

test('stale watchdog port cannot restart a healthy launchd service', () => {
  const staleConfig = structuredClone(config);
  staleConfig.gateway.port = 18789;
  const result = inspectGatewayIdentity(staleConfig, {
    uid: 501,
    run(file, args) {
      if (file === 'launchctl') return 'pid = 4242\nstate = running';
      if (file === 'lsof' && args.includes('-Fn')) return 'p4242\nn*:18889\n';
      if (file === 'lsof') return '';
      if (file === 'pgrep') return '';
      throw new Error(`unexpected command: ${file}`);
    },
  });
  const decision = decideGatewayHealth({ identity: result, probes: greenProbes });

  assert.equal(result.configurationError, 'configured gateway port 18789 does not match launchd service listener(s): 18889');
  assert.deepEqual(decision, {
    action: 'configuration-error',
    reason: 'gateway-port-mismatch',
    detail: result.configurationError,
    probeFailures: 0,
  });
});

test('service listener inspection failure cannot restart the gateway', () => {
  const result = inspectGatewayIdentity(config, {
    uid: 501,
    run(file, args) {
      if (file === 'launchctl') return 'pid = 4242\nstate = running';
      if (file === 'lsof' && args.includes('-Fn')) throw new Error('lsof service query timed out');
      if (file === 'lsof') return '4242\n';
      if (file === 'pgrep') return '';
      throw new Error(`unexpected command: ${file}`);
    },
  });
  const decision = decideGatewayHealth({ identity: result, probes: greenProbes });

  assert.match(result.inspectionError, /service listener query failed: lsof service query timed out/);
  assert.equal(decision.action, 'inspection-error');
  assert.equal(decision.reason, 'listener-inspection-failed');
});

test('launchd inspection failure cannot restart the gateway', () => {
  const result = inspectGatewayIdentity(config, {
    uid: 501,
    run(file) {
      if (file === 'launchctl') throw Object.assign(new Error('launchctl timed out'), { code: 'ETIMEDOUT' });
      if (file === 'lsof') return '';
      if (file === 'pgrep') return '';
      throw new Error(`unexpected command: ${file}`);
    },
  });
  const decision = decideGatewayHealth({ identity: result, probes: greenProbes });

  assert.match(result.inspectionError, /launchd service query failed: launchctl timed out/);
  assert.equal(decision.action, 'inspection-error');
});

test('known launchd service absence remains restartable', () => {
  const result = inspectGatewayIdentity(config, {
    uid: 501,
    run(file) {
      if (file === 'launchctl') {
        throw Object.assign(new Error('launchctl print failed'), {
          stderr: 'Could not find service in domain for user',
        });
      }
      if (file === 'lsof') return '';
      if (file === 'pgrep') return '';
      throw new Error(`unexpected command: ${file}`);
    },
  });
  const decision = decideGatewayHealth({ identity: result, probes: greenProbes });

  assert.equal(result.inspectionError, null);
  assert.equal(result.serviceError, 'launchd service is absent');
  assert.equal(decision.action, 'restart');
  assert.equal(decision.reason, 'service-absent');
});

test('configured port inspection failure cannot restart the gateway', () => {
  const result = inspectGatewayIdentity(config, {
    uid: 501,
    run(file, args) {
      if (file === 'launchctl') return 'pid = 4242\nstate = running';
      if (file === 'lsof' && args.includes('-Fn')) return 'p4242\nn*:18889\n';
      if (file === 'lsof') throw new Error('lsof configured port query failed');
      if (file === 'pgrep') return '';
      throw new Error(`unexpected command: ${file}`);
    },
  });
  const decision = decideGatewayHealth({ identity: result, probes: greenProbes });

  assert.match(result.inspectionError, /configured port query failed: lsof configured port query failed/);
  assert.equal(decision.action, 'inspection-error');
  assert.equal(decision.reason, 'listener-inspection-failed');
});

test('inconsistent listener snapshots cannot restart the gateway', () => {
  const result = inspectGatewayIdentity(config, {
    uid: 501,
    run(file, args) {
      if (file === 'launchctl') return 'pid = 4242\nstate = running';
      if (file === 'lsof' && args.includes('-Fn')) return 'p4242\nn*:18889\n';
      if (file === 'lsof') return '9001\n';
      if (file === 'pgrep') return '';
      throw new Error(`unexpected command: ${file}`);
    },
  });
  const decision = decideGatewayHealth({ identity: result, probes: greenProbes });

  assert.match(result.inspectionError, /listener queries disagree/);
  assert.equal(decision.action, 'inspection-error');
});

test('lsof no-match exit remains a successful empty inspection', () => {
  const noMatch = Object.assign(new Error('lsof exited with status 1'), {
    status: 1,
    stdout: '',
    stderr: '',
  });
  const result = inspectGatewayIdentity(config, {
    uid: 501,
    run(file) {
      if (file === 'launchctl') return 'pid = 4242\nstate = running';
      if (file === 'lsof') throw noMatch;
      if (file === 'pgrep') return '';
      throw new Error(`unexpected command: ${file}`);
    },
  });
  const decision = decideGatewayHealth({ identity: result, probes: greenProbes });

  assert.equal(result.inspectionError, null);
  assert.equal(decision.action, 'restart');
  assert.equal(decision.reason, 'owned-listener-absent');
});

test('listening ports are parsed from lsof field output', () => {
  assert.deepEqual(parseListeningPorts('p4242\nn127.0.0.1:18889\nn[::1]:18890\n'), [18889, 18890]);
});

test('malformed watchdog configuration fails closed', () => {
  assert.throws(
    () => parseWatchdogConfig('{not-json'),
    /Invalid watchdog config/,
  );
  assert.throws(
    () => validateWatchdogConfig({ ...config, gateway: { ...config.gateway, port: 'not-a-port' } }),
    /Invalid gateway port/,
  );
  assert.throws(
    () => validateWatchdogConfig({ ...config, thresholds: { ...config.thresholds, probeTimeoutMs: 0 } }),
    /Invalid thresholds\.probeTimeoutMs/,
  );
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
