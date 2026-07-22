###### WIP Computer
# wip-healthcheck

External health watchdog for OpenClaw and LDM OS. Monitors gateway health, token usage, file descriptors, and memory systems. Includes a daily backup system with verification.

Zero npm dependencies. Runs via macOS LaunchAgent.

## What It Does

Runs every 3 minutes and checks:

1. **Gateway identity** ... does the configured launchd service PID own the configured listener?
2. **HTTP probes** ... do `/healthz` and `/readyz` return 200 within the configured timeout?
3. **File descriptors** ... is the gateway approaching EMFILE limits?
4. **Token usage** ... are any sessions near context window capacity?
5. **Memory health** (every 5th run) ... NULL embedding vectors, API key errors, session export freshness, Crystal capture errors

When something fails:
- **Auto-restart:** Restarts the gateway via `launchctl` (rate-limited)
- **Agent alert:** Sends a message to your agent via the chatCompletions endpoint
- **iMessage fallback:** Direct iMessage to operator if the agent is unreachable

## Install

```bash
git clone https://github.com/wipcomputer/wip-healthcheck.git
cd wip-healthcheck
cp config.example.json config.json
# Edit config.json with your values
bash install.sh
```

This installs a LaunchAgent that runs the healthcheck every 3 minutes.

### Backup system (optional)

```bash
bash install-backup.sh
```

This installs:
- A LaunchAgent that runs daily backups at midnight
- A cron job that verifies the backup at 00:30

## Configuration

Copy `config.example.json` to `config.json` and edit:

```json
{
  "gateway": {
    "host": "127.0.0.1",
    "port": 18789,
    "token": "",
    "plistLabel": "ai.openclaw.gateway",
    "processPattern": "openclaw-gateway"
  },
  "thresholds": {
    "gatewayProbeFailureThreshold": 2,
    "probeTimeoutMs": 5000
  },
  "escalation": {
    "escalationContact": "you@icloud.com",
    "model": "",
    "viaAgent": true,
    "cooldownMinutes": 15
  },
  "paths": {
    "openclawHome": "",
    "sessionExports": "",
    "backupRoot": "",
    "backupExpectedFiles": ["crystal.db", "context-embeddings.sqlite"]
  },
  "backup": {
    "retentionDays": 7,
    "sources": []
  }
}
```

### Key fields

| Field | What | Default |
|-------|------|---------|
| `gateway.token` | Gateway auth token. Auto-read from `openclaw.json` if empty. | `""` |
| `gateway.port` | Listener port used for launchd PID ownership and HTTP probes. | `18789` |
| `gateway.plistLabel` | launchd service label whose active PID must own the listener. | `ai.openclaw.gateway` |
| `gateway.processPattern` | Optional command-line diagnostic. It never authorizes a restart. | `openclaw-gateway` |
| `thresholds.gatewayProbeFailureThreshold` | Consecutive endpoint failures required before restart. | `2` |
| `thresholds.probeTimeoutMs` | Timeout applied independently to each endpoint probe. | `5000` |
| `escalation.escalationContact` | iMessage address for direct fallback alerts. | `""` |
| `escalation.model` | Model string for agent messages. Empty uses gateway default. | `""` |
| `escalation.viaAgent` | Try agent (chatCompletions) before iMessage. | `true` |
| `paths.openclawHome` | OpenClaw home dir. | `$OPENCLAW_HOME` or `~/.openclaw` |
| `paths.sessionExports` | Session export directory to monitor. Empty skips the check. | `""` |
| `paths.backupRoot` | Where daily backups go. Empty skips backup verification. | `""` |
| `paths.backupExpectedFiles` | Files that must exist in each backup. | core DBs |
| `backup.sources` | Array of `{src, type, name}` for custom backup sources. | core OpenClaw files |
| `backup.retentionDays` | Days of backups to keep. | `7` |

### Backup sources format

Add custom backup sources to `backup.sources`:

```json
{
  "backup": {
    "sources": [
      { "type": "file", "src": "/path/to/file.db", "name": "file.db" },
      { "type": "tar",  "src": "/path/to/directory", "name": "archive.tar" },
      { "type": "dir",  "src": "/path/to/dir", "name": "dir-copy" }
    ]
  }
}
```

Types: `file` (copy), `tar` (archive directory), `dir` (recursive copy).

If `sources` is empty, the backup script backs up core OpenClaw files automatically (crystal.db, context-embeddings.sqlite, main.sqlite, workspace, sessions, config).

## Manual run

```bash
node healthcheck.mjs       # run one check
bash backup.sh              # run one backup
bash verify-backup.sh       # verify today's backup
```

Before enabling the watchdog after a gateway token change, run `node healthcheck.mjs --reenable-preflight` and require a zero exit plus an authenticated `/v1/models` HTTP 200. This mode never restarts the gateway. A 401 means the watchdog still has stale credentials and must remain disabled. A renamed executable or unexpected argv is diagnostic context only and does not make a healthy launchd-owned gateway restart.

## Uninstall

```bash
bash uninstall.sh           # removes healthcheck LaunchAgent
# To remove backup: launchctl bootout gui/$(id -u)/com.wipcomputer.daily-backup
```

## Files

```
healthcheck.mjs         Main watchdog script
gateway-health.mjs      Service identity, listener ownership, and endpoint probes
backup.sh               Daily backup script (config-driven)
backup-wrapper.mjs      Node wrapper for backup LaunchAgent
verify-backup.sh        Backup verification (cron)
config.json             Your config (not committed)
config.example.json     Config template
install.sh              Install healthcheck LaunchAgent
install-backup.sh       Install backup LaunchAgent + verify cron
uninstall.sh            Remove healthcheck LaunchAgent
```

## Requirements

- Node.js (18+)
- macOS (uses LaunchAgent, iMessage, lsof)
- OpenClaw gateway running

## License

MIT

Built by Parker Todd Brooks, with Claude Code and Lēsa (OpenClaw).
