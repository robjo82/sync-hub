#!/usr/bin/env bash
# Lanceur du daemon sync-hub.
#
# Sa seule raison d'être : garder le jeton de synchro hors du plist. Un plist est un fichier
# texte, il part dans les sauvegardes et se recopie sans qu'on y pense ; le trousseau est
# chiffré au repos et déverrouillé à l'ouverture de session, donc le daemon démarre seul.
#
# Sans jeton (ou sans URL), le daemon tourne normalement en local : la synchro distante est
# optionnelle et ne s'active que si les deux variables sont présentes.
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
KEYCHAIN_SERVICE="sync-hub-remote-token"

if [ -z "${SYNC_HUB_REMOTE_TOKEN:-}" ]; then
  # || true : un trousseau sans cette entrée n'est pas une erreur, juste une synchro inactive.
  TOKEN="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null || true)"
  if [ -n "$TOKEN" ]; then
    export SYNC_HUB_REMOTE_TOKEN="$TOKEN"
  fi
fi

exec node "$PROJECT_DIR/dist/server/index.js"
