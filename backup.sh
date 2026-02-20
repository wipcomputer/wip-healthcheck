#!/bin/bash
# wip-healthcheck: daily backup of OpenClaw databases + state files
# Config-driven. Reads backup.sources from config.json.
# Keeps last 7 days, rotates old ones.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONFIG="$SCRIPT_DIR/config.json"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"

# Also check for config in the standard install location
if [ ! -f "$CONFIG" ] && [ -f "$OPENCLAW_HOME/wip-healthcheck/config.json" ]; then
  CONFIG="$OPENCLAW_HOME/wip-healthcheck/config.json"
fi

# Read backup root from config, fall back to default
BACKUP_ROOT=$(python3 -c "
import json, os, sys
try:
  cfg = json.load(open('$CONFIG'))
  root = cfg.get('paths', {}).get('backupRoot', '')
  if root:
    print(root)
  else:
    print(os.path.expanduser('~/.openclaw/backups'))
except:
  print(os.path.expanduser('~/.openclaw/backups'))
" 2>/dev/null)

DATE=$(date +%Y-%m-%d)
DEST="$BACKUP_ROOT/$DATE"
mkdir -p "$DEST"

# Read backup sources from config
# Format: array of { "src": "/path", "type": "file|dir|tar", "name": "output-name" }
SOURCES=$(python3 -c "
import json, sys
try:
  cfg = json.load(open('$CONFIG'))
  sources = cfg.get('backup', {}).get('sources', [])
  for s in sources:
    print(f\"{s['type']}|{s['src']}|{s['name']}\")
except:
  pass
" 2>/dev/null)

# Default sources if none configured (core OpenClaw files)
if [ -z "$SOURCES" ]; then
  SOURCES="file|$OPENCLAW_HOME/memory-crystal/crystal.db|crystal.db
file|$OPENCLAW_HOME/memory-crystal/crystal.db-wal|crystal.db-wal
file|$OPENCLAW_HOME/memory-crystal/crystal.db-shm|crystal.db-shm
file|$OPENCLAW_HOME/memory/context-embeddings.sqlite|context-embeddings.sqlite
file|$OPENCLAW_HOME/memory/context-embeddings.sqlite-wal|context-embeddings.sqlite-wal
file|$OPENCLAW_HOME/memory/context-embeddings.sqlite-shm|context-embeddings.sqlite-shm
file|$OPENCLAW_HOME/memory/main.sqlite|main.sqlite
file|$OPENCLAW_HOME/memory/main.sqlite-wal|main.sqlite-wal
file|$OPENCLAW_HOME/memory/main.sqlite-shm|main.sqlite-shm
file|$OPENCLAW_HOME/openclaw.json|openclaw.json
tar|$OPENCLAW_HOME/agents/main/sessions|oc-sessions.tar
tar|$OPENCLAW_HOME/workspace|workspace.tar"
fi

# Process each source
while IFS='|' read -r type src name; do
  [ -z "$type" ] && continue
  case "$type" in
    file)
      if [ -f "$src" ]; then
        cp "$src" "$DEST/$name" && echo "ok $name" || echo "FAIL $name"
      else
        echo "skip $name (not found)"
      fi
      ;;
    dir)
      if [ -d "$src" ]; then
        cp -r "$src" "$DEST/$name" && echo "ok $name" || echo "FAIL $name"
      else
        echo "skip $name (not found)"
      fi
      ;;
    tar)
      if [ -d "$src" ]; then
        parent=$(dirname "$src")
        base=$(basename "$src")
        tar -cf "$DEST/$name" -C "$parent" "$base" 2>/dev/null && echo "ok $name" || echo "FAIL $name"
      else
        echo "skip $name (not found)"
      fi
      ;;
    *)
      echo "unknown type: $type for $name"
      ;;
  esac
done <<< "$SOURCES"

# State files (always back up if they exist)
for f in session-export-state.json cc-export-watermark.json cc-capture-watermark.json memory-capture-state.json; do
  if [ -f "$OPENCLAW_HOME/memory/$f" ]; then
    cp "$OPENCLAW_HOME/memory/$f" "$DEST/$f" && echo "ok $f" || true
  fi
done

# Rotation: keep last 7 days
RETENTION=$(python3 -c "
import json
try:
  cfg = json.load(open('$CONFIG'))
  print(cfg.get('backup', {}).get('retentionDays', 7))
except:
  print(7)
" 2>/dev/null)

cd "$BACKUP_ROOT"
ls -1d 20??-??-?? 2>/dev/null | sort -r | tail -n +$((RETENTION + 1)) | while read old; do
  echo "rotate $old"
  rm -rf "$old"
done

echo "Backup complete: $DEST"
du -sh "$DEST"
