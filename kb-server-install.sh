#!/bin/bash
# Install KB Server as a systemd service
# Usage: sudo bash kb-server-install.sh
# Dynamically templates the service file using current user, node path, and working directory.

set -e

SERVICE_FILE="/etc/systemd/system/kb-server.service"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# Detect runtime values
KB_USER="${SUDO_USER:-$(whoami)}"
KB_HOME="$(eval echo "~$KB_USER")"
NODE_BIN="$(which node 2>/dev/null || echo "$KB_HOME/.nvm/versions/node/$(node -v 2>/dev/null || echo v22.22.1)/bin/node")"
NODE_DIR="$(dirname "$NODE_BIN")"
VAULT_PATH="${OBSIDIAN_VAULT_PATH:-$KB_HOME/obsidian-vault}"

echo "Installing KB Server systemd service..."
echo "  User:             $KB_USER"
echo "  Working directory: $SCRIPT_DIR"
echo "  Node binary:      $NODE_BIN"
echo "  Vault path:       $VAULT_PATH"
echo ""
echo "NOTE: Review the generated service file at $SERVICE_FILE and adjust if needed."
echo ""

cat > "$SERVICE_FILE" <<EOF
[Unit]
Description=Knowledge Base Server
After=network.target
Documentation=https://github.com/willynikes2/knowledge-base-server

[Service]
Type=simple
User=$KB_USER
WorkingDirectory=$KB_HOME
Environment="NODE_ENV=production"
Environment="PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin"
ExecStart=$(which kb 2>/dev/null || echo "$NODE_BIN $SCRIPT_DIR/bin/kb.js") start
Restart=on-failure
RestartSec=5
StartLimitBurst=5
StartLimitIntervalSec=60

# Logging
StandardOutput=journal
StandardError=journal
SyslogIdentifier=kb-server

# Security hardening
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=$KB_HOME/.knowledge-base $KB_HOME $VAULT_PATH $KB_HOME/knowledgebase /tmp
ProtectHome=false

[Install]
WantedBy=multi-user.target
EOF

# Reload systemd
systemctl daemon-reload

# Enable and start
systemctl enable kb-server
systemctl start kb-server

echo "KB Server service installed and started."
echo "  Status: systemctl status kb-server"
echo "  Logs:   journalctl -u kb-server -f"
echo "  Stop:   systemctl stop kb-server"
echo "  Restart: systemctl restart kb-server"
