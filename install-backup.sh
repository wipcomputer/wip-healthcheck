#!/bin/bash
# wip-healthcheck: Install daily backup LaunchAgent + verify cron
# Generates plist dynamically. No hardcoded paths.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_PATH="$(which node)"
OC_DIR="${OPENCLAW_HOME:-$HOME/.openclaw}"
LABEL="com.wipcomputer.daily-backup"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOG_DIR="$OC_DIR/logs"
SCRIPTS_DIR="$OC_DIR/scripts"

# Copy scripts to ~/.openclaw/scripts/
mkdir -p "$SCRIPTS_DIR" "$LOG_DIR"
cp "$SCRIPT_DIR/backup-wrapper.mjs" "$SCRIPTS_DIR/backup-wrapper.mjs"
cp "$SCRIPT_DIR/backup.sh" "$SCRIPTS_DIR/backup.sh"
cp "$SCRIPT_DIR/verify-backup.sh" "$SCRIPTS_DIR/verify-backup.sh"
chmod +x "$SCRIPTS_DIR/backup.sh" "$SCRIPTS_DIR/verify-backup.sh"
echo "Copied scripts to $SCRIPTS_DIR/"

# Copy config if it exists and destination doesn't
CONFIG_DIR="$OC_DIR/wip-healthcheck"
if [ -f "$SCRIPT_DIR/config.json" ] && [ ! -f "$CONFIG_DIR/config.json" ]; then
  mkdir -p "$CONFIG_DIR"
  cp "$SCRIPT_DIR/config.json" "$CONFIG_DIR/config.json"
  echo "Copied config.json to $CONFIG_DIR/"
fi

# Unload if already loaded
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

# Generate plist (dynamic, no hardcoded paths)
cat > "$PLIST_DST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>$LABEL</string>
    <key>ProgramArguments</key>
    <array>
        <string>$NODE_PATH</string>
        <string>$SCRIPTS_DIR/backup-wrapper.mjs</string>
    </array>
    <key>StartCalendarInterval</key>
    <dict>
        <key>Hour</key>
        <integer>0</integer>
        <key>Minute</key>
        <integer>0</integer>
    </dict>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/daily-backup-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/daily-backup-stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>HOME</key>
        <string>$HOME</string>
        <key>OPENCLAW_HOME</key>
        <string>$OC_DIR</string>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
EOF

# Load it
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
echo "Installed LaunchAgent: $LABEL (midnight daily)"

# Install verify cron (00:30)
CRON_LINE="30 0 * * * $NODE_PATH -e \"import(\\\"child_process\\\").then(c=>c.execSync(\\\"/bin/bash $SCRIPTS_DIR/verify-backup.sh\\\",{stdio:\\\"inherit\\\"}))\" >> $LOG_DIR/backup-verify.log 2>&1"
(crontab -l 2>/dev/null | grep -v "verify-backup"; echo "# Verify daily backup ran - 00:30"; echo "$CRON_LINE") | crontab -
echo "Installed cron: backup verify at 00:30"

echo ""
echo "Done. To test:"
echo "  Backup:  launchctl kickstart gui/\$(id -u)/$LABEL"
echo "  Verify:  bash $SCRIPTS_DIR/verify-backup.sh"
