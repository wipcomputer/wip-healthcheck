import { execFileSync } from 'node:child_process';
import { request } from 'node:http';

function defaultRun(file, args, timeout = 5000) {
  return execFileSync(file, args, { encoding: 'utf8', timeout }).trim();
}

function requireGatewayPort(config) {
  const port = Number(config.gateway.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid gateway port: ${config.gateway.port}`);
  }
  return port;
}

function requireServiceLabel(config) {
  const label = String(config.gateway.plistLabel || '').trim();
  if (!/^[A-Za-z0-9._-]+$/.test(label)) {
    throw new Error(`Invalid launchd service label: ${label || '(empty)'}`);
  }
  return label;
}

export function parseLaunchdPid(output) {
  const match = String(output).match(/(?:^|\n)\s*pid\s*=\s*(\d+)\s*(?:\n|$)/m);
  if (!match) return null;
  const pid = Number(match[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

function parsePidList(output) {
  return [...new Set(
    String(output)
      .split(/\s+/)
      .map(Number)
      .filter((pid) => Number.isInteger(pid) && pid > 0),
  )];
}

export function inspectGatewayIdentity(config, options = {}) {
  const run = options.run ?? defaultRun;
  const uid = String(options.uid ?? process.getuid?.() ?? run('id', ['-u']));
  const label = requireServiceLabel(config);
  const port = requireGatewayPort(config);

  let servicePid = null;
  let serviceError = null;
  try {
    servicePid = parseLaunchdPid(run('launchctl', ['print', `gui/${uid}/${label}`], 5000));
    if (!servicePid) serviceError = 'launchd service has no active pid';
  } catch (error) {
    serviceError = error instanceof Error ? error.message : String(error);
  }

  let listenerPids = [];
  try {
    listenerPids = parsePidList(
      run('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], 5000),
    );
  } catch {
    listenerPids = [];
  }

  const processPattern = String(config.gateway.processPattern || '').trim();
  let diagnosticPatternMatched = null;
  if (processPattern) {
    try {
      diagnosticPatternMatched = parsePidList(
        run('pgrep', ['-f', processPattern], 5000),
      ).length > 0;
    } catch {
      diagnosticPatternMatched = false;
    }
  }

  return {
    uid,
    label,
    port,
    servicePid,
    serviceError,
    listenerPids,
    ownsListener: servicePid !== null && listenerPids.includes(servicePid),
    processPattern: processPattern || null,
    diagnosticPatternMatched,
  };
}

export function probeHttpEndpoint(config, path, options = {}) {
  const requestFn = options.requestFn ?? request;
  const timeout = config.thresholds.probeTimeoutMs;
  const port = requireGatewayPort(config);
  const token = String(config.gateway.token || '');

  return new Promise((resolve) => {
    const start = Date.now();
    const headers = token ? { Authorization: `Bearer ${token}` } : {};
    const req = requestFn({
      hostname: config.gateway.host,
      port,
      path,
      method: 'GET',
      headers,
      timeout,
    }, (res) => {
      res.resume();
      resolve({
        ok: res.statusCode === 200,
        statusCode: res.statusCode,
        ms: Date.now() - start,
      });
    });
    req.on('error', (error) => resolve({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      ms: Date.now() - start,
    }));
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout', ms: timeout });
    });
    req.end();
  });
}

export async function probeGatewayEndpoints(config, options = {}) {
  const requests = [
    probeHttpEndpoint(config, '/healthz', options),
    probeHttpEndpoint(config, '/readyz', options),
  ];
  if (options.includeAuthenticated) {
    requests.push(config.gateway.token
      ? probeHttpEndpoint(config, '/v1/models', options)
      : Promise.resolve({ ok: false, error: 'gateway token is missing' }));
  }
  const [healthz, readyz, authenticated] = await Promise.all(requests);
  return {
    healthz,
    readyz,
    ...(options.includeAuthenticated ? { authenticated } : {}),
  };
}

export function decideGatewayHealth(params) {
  const {
    identity,
    probes,
    previousProbeFailures = 0,
    probeFailureThreshold = 2,
  } = params;

  if (!identity.servicePid) {
    if (identity.listenerPids.length > 0) {
      return { action: 'restart', reason: 'foreign-listener', probeFailures: 0 };
    }
    return { action: 'restart', reason: 'service-absent', probeFailures: 0 };
  }
  if (identity.listenerPids.length === 0) {
    return { action: 'restart', reason: 'owned-listener-absent', probeFailures: 0 };
  }
  if (!identity.ownsListener) {
    return { action: 'restart', reason: 'foreign-listener', probeFailures: 0 };
  }

  const failedProbes = Object.entries(probes)
    .filter(([, result]) => !result.ok)
    .map(([name]) => name);
  if (failedProbes.length === 0) {
    return { action: 'healthy', reason: null, probeFailures: 0, failedProbes: [] };
  }

  const probeFailures = previousProbeFailures + 1;
  const threshold = Math.max(1, Number(probeFailureThreshold) || 1);
  return {
    action: probeFailures >= threshold ? 'restart' : 'observe',
    reason: 'endpoint-probe-failed',
    probeFailures,
    failedProbes,
  };
}

export function evaluateRestartBudget(config, state, now = Date.now()) {
  const windowMs = config.thresholds.restartWindowMinutes * 60 * 1000;
  state.restarts = (state.restarts || []).filter((timestamp) => now - timestamp < windowMs);
  return {
    allowed: state.restarts.length < config.thresholds.maxRestartsPerWindow,
    attempts: state.restarts.length,
    now,
  };
}
