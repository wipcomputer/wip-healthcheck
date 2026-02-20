#!/bin/bash
# wip-healthcheck: Verify daily backup ran successfully
# Called by cron at 00:30. Alerts agent if backup is missing or failed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
CONFIG="$SCRIPT_DIR/config.json"

# Also check for config in the standard install location
if [ ! -f "$CONFIG" ] && [ -f "$OPENCLAW_HOME/wip-healthcheck/config.json" ]; then
  CONFIG="$OPENCLAW_HOME/wip-healthcheck/config.json"
fi

# Read config values
read_config() {
  python3 -c "
import json, os
try:
  cfg = json.load(open('$CONFIG'))
  backup_root = cfg.get('paths', {}).get('backupRoot', '')
  gateway_port = cfg.get('gateway', {}).get('port', 18789)
  model = cfg.get('escalation', {}).get('model', '')
  expected = cfg.get('paths', {}).get('backupExpectedFiles', [])
  print(f'BACKUP_ROOT={backup_root}')
  print(f'GATEWAY_PORT={gateway_port}')
  print(f'MODEL={model}')
  print(f'EXPECTED_FILES={\"|\".join(expected)}')
except:
  print('BACKUP_ROOT=')
  print('GATEWAY_PORT=18789')
  print('MODEL=')
  print('EXPECTED_FILES=')
" 2>/dev/null
}

eval "$(read_config)"

# Skip if no backup root configured
if [ -z "$BACKUP_ROOT" ]; then
  echo "$(date -Iseconds) No backupRoot configured. Skipping verification."
  exit 0
fi

DATE=$(date +%Y-%m-%d)
DEST="$BACKUP_ROOT/$DATE"
LOG="$OPENCLAW_HOME/logs/daily-backup.log"

# Read gateway token
GATEWAY_TOKEN=$(python3 -c "import json; print(json.load(open('$OPENCLAW_HOME/openclaw.json'))['gateway']['auth']['token'])" 2>/dev/null || echo "")

alert_agent() {
  local msg="$1"
  if [ -z "$GATEWAY_TOKEN" ]; then
    echo "$(date -Iseconds) ALERT (no gateway token): $msg"
    return
  fi
  local body="{\"messages\":[{\"role\":\"user\",\"content\":\"URGENT backup alert. Notify the operator immediately: $msg\"}],\"user\":\"backup-verify\"}"
  if [ -n "$MODEL" ]; then
    body="{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"URGENT backup alert. Notify the operator immediately: $msg\"}],\"user\":\"backup-verify\"}"
  fi
  curl -s -X POST "http://127.0.0.1:$GATEWAY_PORT/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $GATEWAY_TOKEN" \
    -d "$body" \
    > /dev/null 2>&1
  echo "$(date -Iseconds) ALERTED: $msg"
}

# Check backup dir exists
if [ ! -d "$DEST" ]; then
  alert_agent "Daily backup MISSING for $DATE. No backup directory found at $DEST."
  exit 1
fi

# Check expected files (if configured)
if [ -n "$EXPECTED_FILES" ]; then
  MISSING=""
  IFS='|' read -ra FILES <<< "$EXPECTED_FILES"
  for f in "${FILES[@]}"; do
    if [ ! -f "$DEST/$f" ]; then
      MISSING="$MISSING $f"
    fi
  done

  if [ -n "$MISSING" ]; then
    alert_agent "Daily backup INCOMPLETE for $DATE. Missing:$MISSING"
    exit 1
  fi
fi

# Check backup log for success
if grep -q "Backup completed successfully\|Backup complete:" "$LOG" 2>/dev/null; then
  echo "$(date -Iseconds) Backup verified OK for $DATE"
else
  alert_agent "Daily backup may have FAILED for $DATE. No success message in log."
  exit 1
fi

echo "$(date -Iseconds) All checks passed"
