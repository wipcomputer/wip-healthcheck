#!/bin/bash
# Verify daily backup ran successfully
# Called by cron at 00:30 PST. Alerts Lesa if backup is missing or failed.

set -euo pipefail

BACKUP_ROOT="$HOME/Documents/wipcomputer--mac-mini-01/staff/Parker/Claude Code - Mini/documents/backups"
DATE=$(date +%Y-%m-%d)
DEST="$BACKUP_ROOT/$DATE"
LOG="$HOME/.openclaw/logs/daily-backup.log"
GATEWAY_PORT=18789
GATEWAY_TOKEN=$(python3 -c "import json; print(json.load(open('$HOME/.openclaw/openclaw.json'))['gateway']['auth']['token'])" 2>/dev/null || echo "")

alert_lesa() {
  local msg="$1"
  if [ -z "$GATEWAY_TOKEN" ]; then
    echo "$(date -Iseconds) ALERT (no gateway token): $msg"
    return
  fi
  curl -s -X POST "http://127.0.0.1:$GATEWAY_PORT/v1/chat/completions" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $GATEWAY_TOKEN" \
    -d "{\"model\":\"anthropic/claude-opus-4-6\",\"messages\":[{\"role\":\"user\",\"content\":\"URGENT backup alert. iMessage Parker immediately: $msg\"}],\"user\":\"backup-verify\"}" \
    > /dev/null 2>&1
  echo "$(date -Iseconds) ALERTED: $msg"
}

# Check backup dir exists
if [ ! -d "$DEST" ]; then
  alert_lesa "Daily backup MISSING for $DATE. No backup directory found at $DEST."
  exit 1
fi

# Check key files exist
MISSING=""
for f in crystal.db context-embeddings.sqlite main.sqlite cc-transcripts.tar oc-sessions.tar workspace.tar openclaw.json; do
  if [ ! -f "$DEST/$f" ]; then
    MISSING="$MISSING $f"
  fi
done

if [ -n "$MISSING" ]; then
  alert_lesa "Daily backup INCOMPLETE for $DATE. Missing:$MISSING"
  exit 1
fi

# Check backup log for success
if grep -q "Backup completed successfully" "$LOG" 2>/dev/null; then
  echo "$(date -Iseconds) Backup verified OK for $DATE"
else
  alert_lesa "Daily backup may have FAILED for $DATE. No success message in log."
  exit 1
fi

echo "$(date -Iseconds) All checks passed"
