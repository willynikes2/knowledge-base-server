#!/bin/bash
export PATH="__HOME__/.nvm/versions/node/v22.22.1/bin:/usr/local/bin:/usr/bin:$PATH"
KB_DIR="__HOME__/knowledge-base-server"
if [ -f "$KB_DIR/.env" ]; then set -a; source "$KB_DIR/.env"; set +a; fi
cd "$KB_DIR"
node bin/weekly-synthesis.js
