import { execFileSync } from 'node:child_process';
import { request } from 'node:http';

function defaultRun(file, args, timeout = 5000) {
  return execFileSync(file, args, { encoding: 'utf8', timeout }).trim();
}

function requireGatewayPort(config) {
  const port = Number(config.gateway?.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid gateway port: ${config.gateway?.port}`);
  }
  return port;
}

function requireServiceLabel(config) {
  const label = String(config.gateway?.plistLabel || '').trim();
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

function commandOutput(value) {
  if (value === undefined || value === null) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8').trim() : String(value).trim();
}

function runLsofQuery(run, args) {
  try {
    return { output: run('lsof', args, 5000), error: null };
  } catch (error) {
    const stdout = commandOutput(error?.stdout);
    const stderr = commandOutput(error?.stderr);
    if (error?.status === 1 && !stdout && !stderr) {
      return { output: '', error: null };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { output: '', error: stderr || message || 'unknown lsof failure' };
  }
}

export function parseListeningPorts(output) {
  const ports = [];
  for (const line of String(output).split('\n')) {
    const match = line.match(/(?:^n|\s)(?:\[[^\]]+\]|[^:\s]+):(\d+)(?:\s|$|\s*\(LISTEN\))/);
    if (!match) continue;
    const port = Number(match[1]);
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.push(port);
  }
  return [...new Set(ports)].sort((a, b) => a - b);
}

export function validateWatchdogConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('Watchdog config must be a JSON object');
  }
  requireGatewayPort(config);
  requireServiceLabel(config);
  if (!config.gateway.host || typeof config.gateway.host !== 'string') {
    throw new Error('Invalid gateway host');
  }
  const positiveNumbers = [
    ['thresholds.probeTimeoutMs', config.thresholds?.probeTimeoutMs],
    ['thresholds.gatewayProbeFailureThreshold', config.thresholds?.gatewayProbeFailureThreshold],
    ['thresholds.maxRestartsPerWindow', config.thresholds?.maxRestartsPerWindow],
    ['thresholds.restartWindowMinutes', config.thresholds?.restartWindowMinutes],
  ];
  for (const [name, value] of positiveNumbers) {
    if (!Number.isFinite(Number(value)) || Number(value) <= 0) {
      throw new Error(`Invalid ${name}: ${value}`);
    }
  }
  return config;
}

export function parseWatchdogConfig(raw, source = 'watchdog config') {
  let config;
  try {
    config = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid ${source}: ${error.message}`);
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error(`Invalid ${source}: root must be an object`);
  }
  return config;
}

export function inspectGatewayIdentity(config, options = {}) {
  const run = options.run ?? defaultRun;
  const uid = String(options.uid ?? process.getuid?.() ?? run('id', ['-u']));
  const label = requireServiceLabel(config);
  const port = requireGatewayPort(config);

  let servicePid = null;
  let serviceError = null;
  let serviceInspectionError = null;
  try {
    servicePid = parseLaunchdPid(run('launchctl', ['print', `gui/${uid}/${label}`], 5000));
    if (!servicePid) serviceError = 'launchd service has no active pid';
  } catch (error) {
    const stderr = commandOutput(error?.stderr);
    const message = stderr || (error instanceof Error ? error.message : String(error));
    if (/could not find service|service not found/iu.test(message)) {
      serviceError = 'launchd service is absent';
    } else {
      serviceInspectionError = message || 'unknown launchd inspection failure';
    }
  }

  let serviceListenerPorts = [];
  let serviceListenerError = null;
  if (servicePid) {
    const result = runLsofQuery(
      run,
      ['-nP', '-a', '-p', String(servicePid), '-iTCP', '-sTCP:LISTEN', '-Fn'],
    );
    serviceListenerPorts = parseListeningPorts(result.output);
    serviceListenerError = result.error;
  }

  const configuredPortResult = runLsofQuery(
    run,
    ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'],
  );
  const configuredPortPids = parsePidList(configuredPortResult.output);
  const configuredPortError = configuredPortResult.error;

  const portMatchesConfig = serviceListenerPorts.includes(port);
  const configuredPortOwnedByService = servicePid !== null && configuredPortPids.includes(servicePid);
  const inspectionErrors = [
    serviceInspectionError ? `launchd service query failed: ${serviceInspectionError}` : null,
    serviceListenerError ? `service listener query failed: ${serviceListenerError}` : null,
    configuredPortError ? `configured port query failed: ${configuredPortError}` : null,
  ].filter(Boolean);
  const snapshotInconsistent = servicePid !== null
    && inspectionErrors.length === 0
    && portMatchesConfig !== configuredPortOwnedByService;
  if (snapshotInconsistent) {
    inspectionErrors.push(
      `listener queries disagree about whether service pid ${servicePid} owns configured port ${port}`,
    );
  }
  const inspectionError = inspectionErrors.length > 0 ? inspectionErrors.join('; ') : null;
  const configurationError = !inspectionError
    && servicePid
    && serviceListenerPorts.length > 0
    && !portMatchesConfig
    ? `configured gateway port ${port} does not match launchd service listener(s): ${serviceListenerPorts.join(', ')}`
    : null;

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
    serviceInspectionError,
    serviceListenerPorts,
    serviceListenerError,
    configuredPortPids,
    configuredPortError,
    portMatchesConfig,
    inspectionError,
    configurationError,
    ownsListener: servicePid !== null
      && !inspectionError
      && portMatchesConfig
      && configuredPortOwnedByService,
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

  if (identity.inspectionError) {
    return {
      action: 'inspection-error',
      reason: 'listener-inspection-failed',
      detail: identity.inspectionError,
      probeFailures: 0,
    };
  }
  if (identity.configurationError) {
    return {
      action: 'configuration-error',
      reason: 'gateway-port-mismatch',
      detail: identity.configurationError,
      probeFailures: 0,
    };
  }
  if (!identity.servicePid) {
    if (identity.configuredPortPids.length > 0) {
      return { action: 'restart', reason: 'foreign-listener', probeFailures: 0 };
    }
    return { action: 'restart', reason: 'service-absent', probeFailures: 0 };
  }
  if (identity.serviceListenerPorts.length === 0) {
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
