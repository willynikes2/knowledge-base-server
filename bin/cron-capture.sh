#!/bin/bash
# Daily automated captures
export PATH="__HOME__/.nvm/versions/node/v22.22.1/bin:/usr/local/bin:/usr/bin:$PATH"
export OBSIDIAN_VAULT_PATH="${OBSIDIAN_VAULT_PATH:-__HOME__/obsidian-vault}"
KB_DIR="__HOME__/knowledge-base-server"

# Load .env
if [ -f "$KB_DIR/.env" ]; then
  set -a; source "$KB_DIR/.env"; set +a
fi

# 1. Sync X bookmarks
if [ -f ~/knowledgebase/sync-x-bookmarks.sh ]; then
  bash ~/knowledgebase/sync-x-bookmarks.sh 2>/dev/null
fi

# 2. Capture X bookmarks to vault
cd "$KB_DIR"
node bin/kb.js capture-x 2>/dev/null

# 3. Reindex vault (safety net)
node bin/kb.js vault reindex 2>/dev/null

echo "[cron-capture] Done at $(date)"
