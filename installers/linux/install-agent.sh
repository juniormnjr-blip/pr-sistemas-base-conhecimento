#!/usr/bin/env bash
set -euo pipefail

ENDPOINT="${ENDPOINT:-https://pr-sistemas-base-conhecimento.onrender.com/api/unit-versions/ingest}"
TOKEN="${TOKEN:-}"
SOURCE_PATH="${SOURCE_PATH:-}"
INSTALL_DIR="${INSTALL_DIR:-/opt/pr-sistemas-unit-versions-agent}"
SERVICE_NAME="${SERVICE_NAME:-pr-sistemas-unit-versions-agent}"
POLL_INTERVAL_MS="${POLL_INTERVAL_MS:-30000}"
RETRY_INTERVAL_MS="${RETRY_INTERVAL_MS:-10000}"
WATCH="${WATCH:-true}"
ONCE="${ONCE:-false}"
COMMAND="${COMMAND:-}"
COMMAND_CWD="${COMMAND_CWD:-}"

if [[ -z "$TOKEN" ]]; then
  echo "[unit-versions-installer] TOKEN nao informado" >&2
  exit 1
fi

if [[ -z "$SOURCE_PATH" && -z "$COMMAND" ]]; then
  echo "[unit-versions-installer] defina SOURCE_PATH ou COMMAND" >&2
  exit 1
fi

mkdir -p "$INSTALL_DIR"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

cp "$REPO_ROOT/agent/unit-versions-agent.mjs" "$INSTALL_DIR/unit-versions-agent.mjs"
cp "$REPO_ROOT/agent/unit-versions-agent.config.example.json" "$INSTALL_DIR/unit-versions-agent.config.example.json"

cat > "$INSTALL_DIR/unit-versions-agent.config.json" <<EOF
{
  "endpoint": "$ENDPOINT",
  "token": "$TOKEN",
  "sourcePath": "$SOURCE_PATH",
  "command": "$COMMAND",
  "commandCwd": "$COMMAND_CWD",
  "pollIntervalMs": $POLL_INTERVAL_MS,
  "retryIntervalMs": $RETRY_INTERVAL_MS,
  "watch": $WATCH,
  "once": $ONCE
}
EOF

NODE_PATH="$(command -v node || true)"
if [[ -z "$NODE_PATH" ]]; then
  echo "[unit-versions-installer] Node.js nao encontrado no PATH" >&2
  exit 1
fi

SERVICE_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
sudo tee "$SERVICE_FILE" > /dev/null <<EOF
[Unit]
Description=PR Sistemas Unit Versions Agent
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$INSTALL_DIR
ExecStart=$NODE_PATH $INSTALL_DIR/unit-versions-agent.mjs --config $INSTALL_DIR/unit-versions-agent.config.json
Restart=always
RestartSec=10
User=root

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

echo "[unit-versions-installer] agente instalado em $INSTALL_DIR"
echo "[unit-versions-installer] servico systemd: $SERVICE_NAME"
