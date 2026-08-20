#!/usr/bin/env bash
# Stops and removes the sync-hub launchd service. Does not touch data/hub.sqlite or any project files.
set -euo pipefail

LABEL="fr.sync-hub.daemon"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"

if [ -f "$PLIST_PATH" ]; then
  launchctl unload "$PLIST_PATH" >/dev/null 2>&1 || true
  rm "$PLIST_PATH"
  echo "sync-hub désinstallé (le service ne redémarrera plus au login)."
else
  echo "Aucun service sync-hub installé (${PLIST_PATH} introuvable)."
fi
