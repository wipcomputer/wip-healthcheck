#!/bin/bash
# Install oc-healthcheck as a LaunchAgent (runs every 3 minutes)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LABEL="ai.openclaw.healthcheck"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"
NODE_PATH="$(command -v node)"
INSTALL_ROOT="${OPENCLAW_HOME:-$HOME/.openclaw}/wip-healthcheck"
RUNTIME_ROOT="$INSTALL_ROOT/runtime"
RELEASE_ID="$(date -u +%Y%m%dT%H%M%SZ)-$$"
STAGE_DIR="$RUNTIME_ROOT/.staging-$RELEASE_ID"
RELEASE_DIR="$RUNTIME_ROOT/$RELEASE_ID"
SCRIPT_PATH="$RELEASE_DIR/healthcheck.mjs"
LOG_DIR="$HOME/.ldm/logs"

mkdir -p "$LOG_DIR" "$HOME/Library/LaunchAgents" "$INSTALL_ROOT" "$RUNTIME_ROOT"
chmod 700 "$INSTALL_ROOT" "$RUNTIME_ROOT"

if [ -e "$INSTALL_ROOT/config.json" ]; then
  chmod 600 "$INSTALL_ROOT/config.json"
elif [ -f "$SCRIPT_DIR/config.json" ]; then
  install -m 600 "$SCRIPT_DIR/config.json" "$INSTALL_ROOT/config.json"
else
  echo "Missing config: create $SCRIPT_DIR/config.json before installation" >&2
  exit 1
fi

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true

mkdir -p "$STAGE_DIR"
trap 'rm -rf "$STAGE_DIR" "${PLIST_TMP:-}"' EXIT
install -m 644 "$SCRIPT_DIR/healthcheck.mjs" "$STAGE_DIR/healthcheck.mjs"
install -m 644 "$SCRIPT_DIR/gateway-health.mjs" "$STAGE_DIR/gateway-health.mjs"
mv "$STAGE_DIR" "$RELEASE_DIR"

PLIST_TMP="$(mktemp "$PLIST_DST.XXXXXX")"
cat > "$PLIST_TMP" << EOF
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
        <key>WIP_HEALTHCHECK_HOME</key>
        <string>$INSTALL_ROOT</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
</dict>
</plist>
EOF

WIP_HEALTHCHECK_HOME="$INSTALL_ROOT" "$NODE_PATH" "$SCRIPT_PATH" --reenable-preflight
mv -f "$PLIST_TMP" "$PLIST_DST"
PLIST_TMP=""
launchctl bootstrap "gui/$(id -u)" "$PLIST_DST"
trap - EXIT

echo "Installed: $LABEL"
echo "  Plist: $PLIST_DST"
echo "  Script: $SCRIPT_PATH"
echo "  Interval: every 3 minutes"
echo "  Logs: $INSTALL_ROOT/logs/"
echo ""
echo "Manual run: WIP_HEALTHCHECK_HOME=$INSTALL_ROOT node $SCRIPT_PATH"
echo "Check status: launchctl list | grep healthcheck"
echo ""
echo "IMPORTANT: Set escalationContact in config.json for direct iMessage fallback"
