#!/bin/bash
# Post-sync hook for obsidian-headless
# Can be called manually or via cron to trigger vault reindexing
# Calls the KB server's vault reindex endpoint

set -euo pipefail

KB_PORT="${KB_PORT:-3838}"
KB_PASSWORD="${KB_PASSWORD:-}"
COOKIE_JAR=$(mktemp)
trap "rm -f $COOKIE_JAR" EXIT

# Get auth token via cookie jar file
curl -s -c "$COOKIE_JAR" "http://localhost:${KB_PORT}/api/login" \
  -H "Content-Type: application/json" \
  -d "{\"password\":\"${KB_PASSWORD}\"}" -o /dev/null 2>/dev/null

TOKEN=$(grep kb_session "$COOKIE_JAR" 2>/dev/null | awk '{print $NF}')

if [ -z "$TOKEN" ]; then
  echo "[post-sync] Warning: Could not authenticate with KB server"
  exit 0  # Don't fail the sync
fi

# Trigger incremental reindex
RESULT=$(curl -s -X POST "http://localhost:${KB_PORT}/api/vault/reindex" \
  -H "Content-Type: application/json" \
  -b "kb_session=${TOKEN}" 2>/dev/null)

echo "[post-sync] Reindex triggered at $(date): $RESULT"
