#!/bin/bash
VAULT="${OBSIDIAN_VAULT_PATH:-__HOME__/obsidian-vault}"

dirs=(
  "inbox"
  "sources/web"
  "sources/youtube"
  "sources/x-bookmarks"
  "sources/email"
  "projects/example-sensor"
  "projects/example-security"
  "projects/media-ai"
  "projects/kb-system"
  "projects/example-project"
  "People"
  "companies"
  "research"
  "research/weekly"
  "ideas"
  "workflows"
  "agents/claude"
  "agents/codex"
  "agents/gemini"
  "agents/lessons"
  "decisions"
  "system/runbooks"
  "builds/sessions"
  "builds/fixes"
  "archive"
  "templates"
  "assets"
)

for dir in "${dirs[@]}"; do
  mkdir -p "$VAULT/$dir"
  echo "Created: $dir"
done

echo "Vault structure initialized at $VAULT"
