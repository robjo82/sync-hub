#!/usr/bin/env bash
# Installs sync-hub as a macOS launchd background service (starts at login, restarts on crash).
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="fr.sync-hub.daemon"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
DATA_DIR="$PROJECT_DIR/data"
LOG_DIR="$DATA_DIR/logs"

# Hub distant vers lequel pousser. Le jeton, lui, ne passe pas par ici : run_daemon.sh le lit
# dans le trousseau au démarrage (entrée « sync-hub-remote-token »). Sans jeton, la synchro
# distante reste simplement inactive.
REMOTE_URL="${SYNC_HUB_REMOTE_URL:-https://sync-hub.robin-joseph.fr}"

NODE_BIN="$(command -v node || echo /opt/homebrew/bin/node)"
if [ ! -x "$NODE_BIN" ]; then
  echo "node introuvable (essayé: \$PATH puis /opt/homebrew/bin/node). Installe Node.js d'abord." >&2
  exit 1
fi

if [ ! -f "$PROJECT_DIR/dist/server/index.js" ] || [ ! -d "$PROJECT_DIR/dist/client" ]; then
  echo "Build absent — construction (npm install && npm run build)…"
  (cd "$PROJECT_DIR" && npm install && npm run build)
fi

mkdir -p "$LOG_DIR"

cat > "$PLIST_PATH" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${PROJECT_DIR}/scripts/run_daemon.sh</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${PROJECT_DIR}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>SYNC_HUB_DATA_DIR</key>
    <string>${DATA_DIR}</string>
    <key>SYNC_HUB_REMOTE_URL</key>
    <string>${REMOTE_URL}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/service.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/service_err.log</string>
</dict>
</plist>
PLIST

launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
launchctl load "$PLIST_PATH"

echo "sync-hub installé comme service (${LABEL})."
echo "Dashboard : http://127.0.0.1:4000"
echo "Logs      : ${LOG_DIR}/service.log (et service_err.log)"
echo "Arrêter   : launchctl unload ${PLIST_PATH}"
echo "Désinstaller complètement : scripts/uninstall_service.sh"
