#!/bin/bash
# Uninstall oc-healthcheck LaunchAgent
set -euo pipefail

LABEL="ai.openclaw.healthcheck"
PLIST_DST="$HOME/Library/LaunchAgents/$LABEL.plist"

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null && echo "Unloaded $LABEL" || echo "Was not loaded"
rm -f "$PLIST_DST" && echo "Removed $PLIST_DST" || echo "Plist not found"
echo "Done. Logs preserved in $(dirname "$0")/logs/"
