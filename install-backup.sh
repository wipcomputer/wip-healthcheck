#!/bin/bash
# Install daily backup LaunchAgent + verify cron
# Run this on a fresh machine to restore the backup system
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_PATH="$(which node)"
OC_DIR="$HOME/.openclaw"
LABEL="com.wipcomputer.daily-backup"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

# Copy scripts to ~/.openclaw/scripts/
mkdir -p "$OC_DIR/scripts" "$OC_DIR/logs"
cp "$SCRIPT_DIR/daily-backup-wrapper.mjs" "$OC_DIR/scripts/daily-backup-wrapper.mjs"
cp "$SCRIPT_DIR/verify-backup.sh" "$OC_DIR/scripts/verify-backup.sh"
chmod +x "$OC_DIR/scripts/verify-backup.sh"
echo "Copied scripts to $OC_DIR/scripts/"

# Install LaunchAgent (backup at midnight)
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
cp "$SCRIPT_DIR/com.wipcomputer.daily-backup.plist" "$PLIST_DST"
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
echo "Installed LaunchAgent: $LABEL (midnight daily)"

# Install verify cron (00:30)
CRON_LINE='30 0 * * * /opt/homebrew/bin/node -e "import(\"child_process\").then(c=>c.execSync(\"/bin/bash /Users/lesa/.openclaw/scripts/verify-backup.sh\",{stdio:\"inherit\"}))" >> /Users/lesa/.openclaw/logs/backup-verify.log 2>&1'
(crontab -l 2>/dev/null | grep -v "verify-backup"; echo "# Verify daily backup ran - 00:30 PST"; echo "$CRON_LINE") | crontab -
echo "Installed cron: backup verify at 00:30 PST"

echo ""
echo "Done. To test:"
echo "  Backup:  launchctl kickstart gui/\$(id -u)/$LABEL"
echo "  Verify:  bash $OC_DIR/scripts/verify-backup.sh"
