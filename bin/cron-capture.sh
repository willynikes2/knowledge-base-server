#!/bin/bash
# Daily automated captures
export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
export PATH="$HOME/.nvm/versions/node/$(node -v 2>/dev/null || echo v22.22.1)/bin:/usr/local/bin:/usr/bin:$PATH"
export OBSIDIAN_VAULT_PATH="${OBSIDIAN_VAULT_PATH:-$HOME/obsidian-vault}"
KB_DATA_DIR="$HOME/.knowledge-base"

# Load .env from canonical location
if [ -f "$KB_DATA_DIR/.env" ]; then
  set -a; source "$KB_DATA_DIR/.env"; set +a
fi

# 1. Sync X bookmarks
if [ -f ~/knowledgebase/sync-x-bookmarks.sh ]; then
  bash ~/knowledgebase/sync-x-bookmarks.sh 2>/dev/null
fi

# 2. Capture X bookmarks to vault
kb capture-x 2>/dev/null

# 3. Reindex vault (safety net)
kb vault reindex 2>/dev/null

# 4. Auto-classify new clippings/inbox notes
kb classify 2>/dev/null

echo "[cron-capture] Done at $(date)"
