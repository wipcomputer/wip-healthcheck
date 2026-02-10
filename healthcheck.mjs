#!/usr/bin/env node
// oc-healthcheck — External health watchdog for OpenClaw
// Zero npm dependencies. Runs via LaunchAgent every 3 minutes.
// Monitors: gateway process, HTTP probe, file descriptors, token usage.
// Auto-remediates: restarts gateway, warns agent about tokens.
// Escalates to Parker via Lēsa (chatCompletions) or direct iMessage.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync } from 'node:fs';
import { request } from 'node:http';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── Config & State ────────────────────────────────────────────────────────

const CONFIG_PATH = join(__dirname, 'config.json');
const STATE_PATH = join(__dirname, 'state.json');
const LOG_DIR = join(__dirname, 'logs');

const DEFAULTS = {
  gateway: {
    host: '127.0.0.1',
    port: 18789,
    token: '',            // auto-loaded from openclaw.json if empty
    plistLabel: 'ai.openclaw.gateway',
  },
  thresholds: {
    fdWarningPct: 80,
    fdSoftCap: 10000,     // used when ulimit is unlimited
    tokenWarningPct: 80,
    tokenCriticalPct: 92,
    maxRestartsPerWindow: 3,
    restartWindowMinutes: 15,
    probeTimeoutMs: 5000,
  },
  escalation: {
    parkerContact: '',    // iMessage address — set in config.json
    viaLesa: true,        // try Lēsa first, direct iMessage as fallback
    cooldownMinutes: 15,  // min time between escalations
  },
  openclawHome: '/Users/lesa/.openclaw',
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
  if (existsSync(CONFIG_PATH)) {
    try { user = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')); } catch {}
  }
  const config = deepMerge(DEFAULTS, user);

  // Auto-load gateway token from openclaw.json if not set
  if (!config.gateway.token) {
    try {
      const oc = JSON.parse(readFileSync(join(config.openclawHome, 'openclaw.json'), 'utf8'));
      config.gateway.token = oc.gateway?.auth?.token || '';
    } catch {}
  }

  return config;
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

function getGatewayPid() {
  try {
    const out = execSync('pgrep -f openclaw-gateway', { encoding: 'utf8', timeout: 5000 });
    const pids = out.trim().split('\n').filter(Boolean).map(Number);
    return pids[0] || null;
  } catch {
    return null;
  }
}

function httpProbe(config) {
  return new Promise((resolve) => {
    const timeout = config.thresholds.probeTimeoutMs;
    const start = Date.now();
    const req = request({
      hostname: config.gateway.host,
      port: config.gateway.port,
      path: '/',
      method: 'GET',
      timeout,
    }, (res) => {
      res.resume();
      resolve({ ok: res.statusCode < 500, statusCode: res.statusCode, ms: Date.now() - start });
    });
    req.on('error', (err) => resolve({ ok: false, error: err.message, ms: Date.now() - start }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: 'timeout', ms: timeout }); });
    req.end();
  });
}

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
  const now = Date.now();
  const window = config.thresholds.restartWindowMinutes * 60 * 1000;
  state.restarts = (state.restarts || []).filter(t => now - t < window);

  if (state.restarts.length >= config.thresholds.maxRestartsPerWindow) {
    log('error', `Restart rate exceeded (${state.restarts.length}/${config.thresholds.maxRestartsPerWindow} in ${config.thresholds.restartWindowMinutes}m)`);
    return { success: false, reason: 'rate-limited' };
  }

  try {
    const uid = execSync('id -u', { encoding: 'utf8' }).trim();
    log('warn', `Restarting gateway (attempt ${state.restarts.length + 1}/${config.thresholds.maxRestartsPerWindow})`);
    execSync(`launchctl kickstart -k gui/${uid}/${config.gateway.plistLabel}`, { encoding: 'utf8', timeout: 15000 });
    state.restarts.push(now);

    // Wait a beat for gateway to come back
    execSync('sleep 3');
    return { success: true };
  } catch (err) {
    log('error', `Gateway restart failed: ${err.message}`);
    return { success: false, reason: err.message };
  }
}

// ─── Escalation ────────────────────────────────────────────────────────────

function sendToLesa(config, message) {
  return new Promise((resolve) => {
    const body = JSON.stringify({
      model: 'anthropic/claude-opus-4-6',
      messages: [{ role: 'user', content: message }],
      user: 'healthcheck',
    });
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

  // Try Lēsa first (she'll iMessage Parker)
  if (config.escalation.viaLesa) {
    log('info', `Escalating via Lēsa: ${subject}`);
    const result = await sendToLesa(config,
      `URGENT — health monitor alert. iMessage Parker immediately:\n\n${alert}`
    );
    if (result.ok) {
      state.lastEscalation = now;
      log('info', 'Escalation sent via Lēsa');
      return;
    }
    log('warn', `Lēsa escalation failed (${result.error || result.statusCode}), trying direct iMessage`);
  }

  // Fallback: direct iMessage
  if (config.escalation.parkerContact) {
    if (sendDirectIMessage(config.escalation.parkerContact, alert)) {
      state.lastEscalation = now;
      log('info', 'Escalation sent via direct iMessage');
    } else {
      log('error', 'Direct iMessage failed');
    }
  } else {
    log('error', 'No escalation path — Lēsa unreachable, no Parker contact configured');
  }
}

async function warnAgentAboutTokens(config, state, sessionKey, percent) {
  // Rate limit: one warning per 10 minutes
  const now = Date.now();
  if (state.lastTokenWarning && now - state.lastTokenWarning < 10 * 60 * 1000) return;

  const msg = `[oc-healthcheck] Your session "${sessionKey}" is at ${percent}% token capacity. `
    + (percent >= 92
      ? 'CRITICAL — finish your current task immediately and let compaction run. iMessage Parker if stuck.'
      : 'Consider wrapping up soon to avoid hitting the wall.');

  const result = await sendToLesa(config, msg);
  if (result.ok) {
    state.lastTokenWarning = now;
    log('info', `Token warning sent to agent (${percent}%)`);
  } else {
    log('warn', `Token warning failed: ${result.error || result.statusCode}`);
  }
}

// ─── Main ──────────────────────────────────────────────────────────────────

async function main() {
  const config = loadConfig();
  const state = loadState();
  const report = { ts: new Date().toISOString(), checks: {}, actions: [] };

  // ── Check 1: Gateway process alive ──
  const pid = getGatewayPid();
  report.checks.process = { pid };

  if (!pid) {
    log('error', 'Gateway process not found — attempting restart');
    const restart = restartGateway(config, state);
    report.actions.push({ type: 'restart', trigger: 'no-process', ...restart });
    if (!restart.success) {
      await escalate(config, state,
        'Gateway down — restart failed',
        `No gateway process found. Restart failed (${restart.reason}). Manual intervention needed.`
      );
      state.consecutiveFailures++;
    } else {
      log('info', 'Gateway restarted (was not running)');
      state.consecutiveFailures = 0;
    }
    state.lastCheck = report.ts;
    saveState(state);
    log('info', `Check done: ${JSON.stringify(report)}`);
    return;
  }

  // ── Check 2: Gateway HTTP probe ──
  const probe = await httpProbe(config);
  report.checks.http = probe;

  if (!probe.ok) {
    log('error', `HTTP probe failed: ${probe.error || `status ${probe.statusCode}`} (${probe.ms}ms)`);
    const restart = restartGateway(config, state);
    report.actions.push({ type: 'restart', trigger: 'http-probe', ...restart });
    if (!restart.success) {
      await escalate(config, state,
        'Gateway unresponsive — restart failed',
        `Gateway process alive (pid ${pid}) but HTTP probe failed: ${probe.error || probe.statusCode}. Restart failed.`
      );
      state.consecutiveFailures++;
    } else {
      log('info', 'Gateway restarted (HTTP probe failed)');
      state.consecutiveFailures = 0;
    }
    state.lastCheck = report.ts;
    saveState(state);
    log('info', `Check done: ${JSON.stringify(report)}`);
    return;
  }

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

  // ── All checks passed ──
  state.consecutiveFailures = 0;
  state.lastCheck = report.ts;
  saveState(state);

  const summary = `pid=${pid} probe=${probe.ms}ms fds=${fds.count}/${fdCap} sessions=${sessions.length}`
    + (sessions.length > 0 ? ` max-tokens=${Math.max(...sessions.map(s => s.percent))}%` : '');
  log('info', `OK — ${summary}`);
}

main().catch(err => {
  log('error', `Healthcheck crashed: ${err.stack || err.message}`);
  process.exit(1);
});
