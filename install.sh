#!/bin/bash
# Install oc-healthcheck as a LaunchAgent (runs every 3 minutes)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="ai.openclaw.healthcheck"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_PATH="$(which node)"
SCRIPT_PATH="$SCRIPT_DIR/healthcheck.mjs"
LOG_DIR="/tmp/openclaw"

# Ensure log dir exists
mkdir -p "$LOG_DIR"

# Unload if already loaded
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

# Generate plist
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
        <string>$SCRIPT_PATH</string>
    </array>
    <key>StartInterval</key>
    <integer>180</integer>
    <key>StandardOutPath</key>
    <string>$LOG_DIR/healthcheck-stdout.log</string>
    <key>StandardErrorPath</key>
    <string>$LOG_DIR/healthcheck-stderr.log</string>
    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
EOF

# Load it
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"

echo "Installed: $LABEL"
echo "  Plist: $PLIST_DST"
echo "  Script: $SCRIPT_PATH"
echo "  Interval: every 3 minutes"
echo "  Logs: $SCRIPT_DIR/logs/"
echo ""
echo "Manual run: node $SCRIPT_PATH"
echo "Check status: launchctl list | grep healthcheck"
echo ""
echo "IMPORTANT: Set escalationContact in config.json for direct iMessage fallback"
