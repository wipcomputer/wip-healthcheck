#!/usr/bin/env node
// wip-healthcheck — External health watchdog for OpenClaw / LDM OS
// Zero npm dependencies. Runs via LaunchAgent every 3 minutes.
// Monitors: gateway process, HTTP probe, file descriptors, token usage, memory systems.
// Auto-remediates: restarts gateway, warns agent about tokens.
// Escalates via agent (chatCompletions) or direct iMessage fallback.

import { execFileSync, execSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { request } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  decideGatewayHealth,
  evaluateRestartBudget,
  inspectGatewayIdentity,
  parseWatchdogConfig,
  probeGatewayEndpoints,
  validateWatchdogConfig,
} from './gateway-health.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const RUNTIME_HOME = process.env.WIP_HEALTHCHECK_HOME || __dirname;

// ─── Config & State ────────────────────────────────────────────────────────

const CONFIG_PATH = join(RUNTIME_HOME, 'config.json');
const STATE_PATH = join(RUNTIME_HOME, 'state.json');
const LOG_DIR = join(RUNTIME_HOME, 'logs');

const DEFAULTS = {
  gateway: {
    host: '127.0.0.1',
    port: 18789,
    token: '',            // auto-loaded from openclaw.json if empty
    plistLabel: 'ai.openclaw.gateway',
    processPattern: 'openclaw-gateway', // diagnostic only; never restart authority
  },
  thresholds: {
    fdWarningPct: 80,
    fdSoftCap: 10000,     // used when ulimit is unlimited
    tokenWarningPct: 80,
    tokenCriticalPct: 92,
    maxRestartsPerWindow: 3,
    restartWindowMinutes: 15,
    probeTimeoutMs: 5000,
    gatewayProbeFailureThreshold: 2,
  },
  escalation: {
    escalationContact: '',    // iMessage address for fallback — set in config.json
    model: '',                // model for agent messages (empty = use gateway default)
    viaAgent: true,           // try agent first, direct iMessage as fallback
    cooldownMinutes: 15,      // min time between escalations
  },
  paths: {
    openclawHome: process.env.OPENCLAW_HOME || join(process.env.HOME || '', '.openclaw'),
    sessionExports: '',       // path to session export dir (skip check if empty)
    backupRoot: '',           // path to backup root dir (skip check if empty)
  },
};

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && target[key]) {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function loadConfig() {
  let user = {};
  const standardConfigPath = join(
    process.env.OPENCLAW_HOME || join(process.env.HOME || '', '.openclaw'),
    'wip-healthcheck',
    'config.json',
  );
  const configPaths = [...new Set([CONFIG_PATH, standardConfigPath])];
  for (const p of configPaths) {
    if (existsSync(p)) {
      user = parseWatchdogConfig(readFileSync(p, 'utf8'), `watchdog config ${p}`);
      break;
    }
  }
  const config = deepMerge(DEFAULTS, user);

  // Backwards compat: support old flat openclawHome key
  if (config.openclawHome && !user.paths?.openclawHome) {
    config.paths.openclawHome = config.openclawHome;
  }
  delete config.openclawHome;

  // Backwards compat: support old parkerContact / viaLesa keys
  if (user.escalation?.parkerContact && !user.escalation?.escalationContact) {
    config.escalation.escalationContact = user.escalation.parkerContact;
  }
  if (user.escalation?.viaLesa !== undefined && user.escalation?.viaAgent === undefined) {
    config.escalation.viaAgent = user.escalation.viaLesa;
  }

  // Auto-load gateway token from openclaw.json if not set
  if (!config.gateway.token) {
    try {
      const oc = JSON.parse(readFileSync(join(config.paths.openclawHome, 'openclaw.json'), 'utf8'));
      config.gateway.token = oc.gateway?.auth?.token || '';
    } catch {}
  }

  return validateWatchdogConfig(config);
}

function loadState() {
  if (existsSync(STATE_PATH)) {
    try { return JSON.parse(readFileSync(STATE_PATH, 'utf8')); } catch {}
  }
  return {
    restarts: [],
    consecutiveFailures: 0,
    lastCheck: null,
    lastEscalation: null,
    lastTokenWarning: null,
  };
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function log(level, msg) {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
  const date = new Date().toISOString().slice(0, 10);
  const logFile = join(LOG_DIR, `healthcheck-${date}.log`);
  const ts = new Date().toISOString();
  const line = `${ts} [${level.toUpperCase().padEnd(5)}] ${msg}\n`;
  appendFileSync(logFile, line);
  if (level === 'error' || level === 'warn') process.stderr.write(line);
}

// ─── Health Checks ─────────────────────────────────────────────────────────

function getFdCount(pid) {
  if (!pid) return { count: 0, limit: null };
  try {
    const count = parseInt(
      execSync(`lsof -p ${pid} 2>/dev/null | wc -l`, { encoding: 'utf8', timeout: 10000 }).trim(),
      10
    );
    let limit;
    try {
      const raw = execSync('ulimit -n', { encoding: 'utf8', shell: '/bin/bash', timeout: 5000 }).trim();
      limit = raw === 'unlimited' ? null : parseInt(raw, 10);
    } catch { limit = null; }
    return { count, limit };
  } catch {
    return { count: 0, limit: null };
  }
}

function getTokenUsage() {
  const sessions = [];
  try {
    // Only check sessions active in the last 30 minutes — avoids stale cron/subagent noise
    const out = execSync('openclaw sessions --active 30 2>&1', { encoding: 'utf8', timeout: 15000 });
    for (const line of out.split('\n')) {
      // Match token pattern: 123k/200k (61%)
      const tokenMatch = line.match(/(\d+)k\/(\d+)k\s+\((\d+)%\)/);
      if (!tokenMatch) continue;

      // Extract session key (second column after kind)
      const keyMatch = line.match(/^\s*\S+\s+(\S+)/);
      const key = keyMatch ? keyMatch[1] : 'unknown';

      // Skip cron and subagent sessions — they complete and die naturally.
      // Only monitor persistent sessions (main TUI, iMessage, openai-user).
      if (key.includes('cron:') || key.includes('subagent:')) continue;

      sessions.push({
        key,
        tokens: parseInt(tokenMatch[1], 10) * 1000,
        contextWindow: parseInt(tokenMatch[2], 10) * 1000,
        percent: parseInt(tokenMatch[3], 10),
      });
    }
  } catch {}
  return sessions;
}

// ─── Remediation ───────────────────────────────────────────────────────────

function restartGateway(config, state) {
  const budget = evaluateRestartBudget(config, state);

  if (!budget.allowed) {
    log('error', `Restart rate exceeded (${state.restarts.length}/${config.thresholds.maxRestartsPerWindow} in ${config.thresholds.restartWindowMinutes}m)`);
    return { success: false, reason: 'rate-limited' };
  }

  try {
    const uid = String(process.getuid?.() ?? execFileSync('id', ['-u'], { encoding: 'utf8' }).trim());
    log('warn', `Restarting gateway (attempt ${state.restarts.length + 1}/${config.thresholds.maxRestartsPerWindow})`);
    execFileSync('launchctl', ['kickstart', '-k', `gui/${uid}/${config.gateway.plistLabel}`], {
      encoding: 'utf8',
      timeout: 15000,
    });
    state.restarts.push(budget.now);

    // Wait a beat for gateway to come back
    execSync('sleep 3');
    return { success: true };
  } catch (err) {
    log('error', `Gateway restart failed: ${err.message}`);
    return { success: false, reason: err.message };
  }
}

// ─── Escalation ────────────────────────────────────────────────────────────

function sendToAgent(config, message) {
  return new Promise((resolve) => {
    const payload = {
      messages: [{ role: 'user', content: message }],
      user: 'healthcheck',
    };
    if (config.escalation.model) payload.model = config.escalation.model;
    const body = JSON.stringify(payload);
    const req = request({
      hostname: config.gateway.host,
      port: config.gateway.port,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.gateway.token}`,
        'Content-Length': Buffer.byteLength(body),
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => resolve({ ok: res.statusCode < 400, statusCode: res.statusCode }));
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout' }); });
    req.write(body);
    req.end();
  });
}

function sendDirectIMessage(contact, message) {
  if (!contact) return false;
  try {
    // Escape for AppleScript
    const escaped = message.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    execSync(
      `osascript -e 'tell application "Messages" to send "${escaped}" to participant "${contact}" of service "iMessage"'`,
      { timeout: 10000 }
    );
    return true;
  } catch {
    return false;
  }
}

async function escalate(config, state, subject, details) {
  const now = Date.now();
  const cooldown = config.escalation.cooldownMinutes * 60 * 1000;
  if (state.lastEscalation && now - state.lastEscalation < cooldown) {
    log('warn', `Escalation suppressed (cooldown) — ${subject}`);
    return;
  }

  const alert = `[oc-healthcheck] ${subject}\n\n${details}`;

  // Try agent first (via chatCompletions endpoint)
  if (config.escalation.viaAgent) {
    log('info', `Escalating via agent: ${subject}`);
    const result = await sendToAgent(config,
      `URGENT health monitor alert. Notify the operator immediately:\n\n${alert}`
    );
    if (result.ok) {
      state.lastEscalation = now;
      log('info', 'Escalation sent via agent');
      return;
    }
    log('warn', `Agent escalation failed (${result.error || result.statusCode}), trying direct iMessage`);
  }

  // Fallback: direct iMessage
  if (config.escalation.escalationContact) {
    if (sendDirectIMessage(config.escalation.escalationContact, alert)) {
      state.lastEscalation = now;
      log('info', 'Escalation sent via direct iMessage');
    } else {
      log('error', 'Direct iMessage failed');
    }
  } else {
    log('error', 'No escalation path. Agent unreachable, no escalationContact configured');
  }
}

async function warnAgentAboutTokens(config, state, sessionKey, percent) {
  // Rate limit: one warning per 10 minutes
  const now = Date.now();
  if (state.lastTokenWarning && now - state.lastTokenWarning < 10 * 60 * 1000) return;

  const msg = `[wip-healthcheck] Your session "${sessionKey}" is at ${percent}% token capacity. `
    + (percent >= 92
      ? 'CRITICAL. Finish your current task immediately and let compaction run. Alert the operator if stuck.'
      : 'Consider wrapping up soon to avoid hitting the wall.');

  const result = await sendToAgent(config, msg);
  if (result.ok) {
    state.lastTokenWarning = now;
    log('info', `Token warning sent to agent (${percent}%)`);
  } else {
    log('warn', `Token warning failed: ${result.error || result.statusCode}`);
  }
}

// ─── Memory Health ──────────────────────────────────────────────────────────

function checkMemoryHealth(config) {
  const ocHome = config.paths.openclawHome;
  const issues = [];

  // 1. Check for NULL embedding vectors
  try {
    const nullCount = execSync(
      `sqlite3 "${ocHome}/memory/context-embeddings.sqlite" "SELECT COUNT(*) FROM conversation_chunks WHERE embedding IS NULL"`,
      { encoding: 'utf8', timeout: 10000 }
    ).trim();
    const count = parseInt(nullCount, 10);
    if (count > 10) {
      issues.push({ check: 'null-vectors', severity: 'error', detail: `${count} chunks with NULL embeddings` });
    } else if (count > 0) {
      issues.push({ check: 'null-vectors', severity: 'warn', detail: `${count} chunks with NULL embeddings` });
    }
  } catch (err) {
    issues.push({ check: 'null-vectors', severity: 'error', detail: `DB query failed: ${err.message}` });
  }

  // 2. Check gateway error log for recent OpenAI key issues
  try {
    const logPath = `${ocHome}/logs/gateway.err.log`;
    if (existsSync(logPath)) {
      const recent = execSync(
        `tail -50 "${logPath}" | grep -c "no OpenAI API key" || true`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      const count = parseInt(recent, 10);
      if (count > 0) {
        issues.push({ check: 'openai-key', severity: 'error', detail: `${count} "no OpenAI API key" errors in recent gateway log` });
      }
    }
  } catch {}

  // 3. Check session exports are running (latest export should be from today)
  if (config.paths.sessionExports) {
    try {
      const exportDir = config.paths.sessionExports;
      if (existsSync(exportDir)) {
        const latest = execSync(
          `ls -t "${exportDir}" | head -1`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim();
        const today = new Date().toISOString().slice(0, 10);
        if (latest && !latest.startsWith(today)) {
          issues.push({ check: 'session-export', severity: 'warn', detail: `Latest export is ${latest}, not from today` });
        }
      }
    } catch {}
  }

  // 4. Check memory-capture-state.json exists
  try {
    const statePath = `${ocHome}/memory/memory-capture-state.json`;
    if (!existsSync(statePath)) {
      issues.push({ check: 'state-file', severity: 'error', detail: 'memory-capture-state.json missing' });
    }
  } catch {}

  // 5. Check Crystal auto-capture (look for recent errors)
  try {
    const logPath = `${ocHome}/logs/gateway.err.log`;
    if (existsSync(logPath)) {
      const recent = execSync(
        `tail -50 "${logPath}" | grep -c "memory-crystal.*failed\\|memory-crystal.*error" || true`,
        { encoding: 'utf8', timeout: 5000 }
      ).trim();
      const count = parseInt(recent, 10);
      if (count > 2) {
        issues.push({ check: 'crystal-capture', severity: 'error', detail: `${count} crystal errors in recent gateway log` });
      }
    }
  } catch {}

  return issues;
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  const state = loadState();
  const report = { ts: new Date().toISOString(), checks: {}, actions: [] };
  const reenablePreflight = process.argv.includes('--reenable-preflight');

  // Check 1: bind the launchd service PID to the configured listener.
  const identity = inspectGatewayIdentity(config);
  report.checks.identity = identity;
  const canProbe = identity.servicePid !== null && identity.ownsListener;
  const probes = canProbe
    ? await probeGatewayEndpoints(config, { includeAuthenticated: reenablePreflight })
    : {
        healthz: { ok: false, error: 'identity check failed' },
        readyz: { ok: false, error: 'identity check failed' },
        ...(reenablePreflight
          ? { authenticated: { ok: false, error: 'identity check failed' } }
          : {}),
      };
  report.checks.http = probes;

  if (reenablePreflight) {
    const allGreen = identity.servicePid !== null
      && identity.ownsListener
      && Object.values(probes).every((probe) => probe.ok);
    if (!allGreen) {
      log('error', `Re-enable preflight failed: ${JSON.stringify(report.checks)}`);
      process.exitCode = 1;
      return;
    }
    log('info', `Re-enable preflight passed: service pid ${identity.servicePid}, owned port ${identity.port}, authenticated probe 200`);
    return;
  }

  const decision = decideGatewayHealth({
    identity,
    probes,
    previousProbeFailures: state.consecutiveGatewayProbeFailures || 0,
    probeFailureThreshold: config.thresholds.gatewayProbeFailureThreshold,
  });
  report.checks.gateway = decision;
  state.consecutiveGatewayProbeFailures = decision.probeFailures;

  if (decision.action === 'observe') {
    log('warn', `Gateway probes failed (${decision.failedProbes.join(', ')}); waiting for threshold ${config.thresholds.gatewayProbeFailureThreshold}`);
    state.consecutiveFailures++;
    state.lastCheck = report.ts;
    saveState(state);
    log('info', `Check done: ${JSON.stringify(report)}`);
    return;
  }

  if (decision.action === 'configuration-error') {
    log('error', `Gateway configuration error (${decision.detail}); remediation disabled`);
    state.consecutiveGatewayProbeFailures = 0;
    state.consecutiveFailures++;
    state.lastCheck = report.ts;
    saveState(state);
    log('info', `Check done: ${JSON.stringify(report)}`);
    return;
  }

  if (decision.action === 'restart') {
    log('error', `Gateway unhealthy (${decision.reason}); attempting restart`);
    const restart = restartGateway(config, state);
    report.actions.push({ type: 'restart', trigger: decision.reason, ...restart });
    if (!restart.success) {
      await escalate(config, state,
        'Gateway identity or health check failed',
        `Gateway check failed (${decision.reason}). Restart failed (${restart.reason}). Manual intervention needed.`
      );
      state.consecutiveFailures++;
    } else {
      log('info', `Gateway restarted (${decision.reason})`);
      state.consecutiveFailures = 0;
    }
    state.lastCheck = report.ts;
    saveState(state);
    log('info', `Check done: ${JSON.stringify(report)}`);
    return;
  }

  state.consecutiveGatewayProbeFailures = 0;
  const pid = identity.servicePid;

  // ── Check 3: File descriptors ──
  const fds = getFdCount(pid);
  const fdCap = fds.limit || config.thresholds.fdSoftCap;
  const fdPct = fdCap > 0 ? Math.round((fds.count / fdCap) * 100) : 0;
  report.checks.fds = { count: fds.count, cap: fdCap, percent: fdPct };

  if (fdPct >= config.thresholds.fdWarningPct) {
    log('warn', `FD usage high: ${fds.count}/${fdCap} (${fdPct}%) — preemptive restart`);
    const restart = restartGateway(config, state);
    report.actions.push({ type: 'restart', trigger: 'fd-high', ...restart });
    if (!restart.success) {
      await escalate(config, state,
        'File descriptors critical',
        `FD count at ${fds.count}/${fdCap} (${fdPct}%). EMFILE crash imminent. Restart failed.`
      );
    }
  }

  // ── Check 4: Token usage ──
  const sessions = getTokenUsage();
  report.checks.tokens = sessions;

  for (const session of sessions) {
    if (session.percent >= config.thresholds.tokenCriticalPct) {
      log('error', `Session ${session.key} at ${session.percent}% — CRITICAL`);
      await warnAgentAboutTokens(config, state, session.key, session.percent);
      await escalate(config, state,
        `Agent at ${session.percent}% context`,
        `Session "${session.key}" at ${session.tokens.toLocaleString()}/${session.contextWindow.toLocaleString()} tokens. May become unresponsive.`
      );
      report.actions.push({ type: 'token-alert', session: session.key, percent: session.percent });
    } else if (session.percent >= config.thresholds.tokenWarningPct) {
      log('warn', `Session ${session.key} at ${session.percent}%`);
      await warnAgentAboutTokens(config, state, session.key, session.percent);
      report.actions.push({ type: 'token-warn', session: session.key, percent: session.percent });
    }
  }

  // ── Check 5: Memory system health (every 5th run = ~15 min) ──
  const checkCount = (state.checkCount || 0) + 1;
  state.checkCount = checkCount;
  const runMemoryCheck = checkCount % 5 === 0 || checkCount === 1;
  const memIssues = runMemoryCheck ? checkMemoryHealth(config) : [];
  report.checks.memory = runMemoryCheck ? memIssues : 'skipped';

  const memErrors = memIssues.filter(i => i.severity === 'error');
  if (memErrors.length > 0) {
    const details = memErrors.map(i => `- ${i.check}: ${i.detail}`).join('\n');
    log('error', `Memory system issues: ${details}`);
    await escalate(config, state,
      'Memory system errors detected',
      `${memErrors.length} memory health check(s) failed:\n${details}`
    );
    report.actions.push({ type: 'memory-alert', issues: memErrors });
  } else if (memIssues.length > 0) {
    const details = memIssues.map(i => `- ${i.check}: ${i.detail}`).join('\n');
    log('warn', `Memory warnings: ${details}`);
  }

  // ── All checks passed ──
  state.consecutiveFailures = 0;
  state.lastCheck = report.ts;
  saveState(state);

  const memSummary = memIssues.length > 0 ? ` mem-issues=${memIssues.length}` : ' mem=ok';
  const summary = `pid=${pid} healthz=${probes.healthz.ms}ms readyz=${probes.readyz.ms}ms fds=${fds.count}/${fdCap} sessions=${sessions.length}`
    + (sessions.length > 0 ? ` max-tokens=${Math.max(...sessions.map(s => s.percent))}%` : '')
    + memSummary;
  log('info', `OK — ${summary}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch(err => {
    log('error', `Healthcheck crashed: ${err.stack || err.message}`);
    process.exit(1);
  });
}
