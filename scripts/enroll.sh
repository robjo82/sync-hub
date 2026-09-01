#!/usr/bin/env bash
# Enrôle cette machine auprès d'un hub sync-hub : demande l'URL et le jeton d'appareil, vérifie
# qu'ils fonctionnent réellement, puis range le jeton dans le trousseau macOS.
#
# Le jeton n'est jamais écrit dans un fichier ni passé en argument de commande (il finirait dans
# l'historique du shell) : il est saisi masqué et va directement dans le trousseau, d'où
# run_daemon.sh le relit au démarrage du service.
set -euo pipefail

KEYCHAIN_SERVICE="sync-hub-remote-token"
DEFAULT_HUB="https://sync-hub.robin-joseph.fr"

echo "Enrôlement de cette machine auprès d'un hub sync-hub."
echo

read -r -p "URL du hub [${DEFAULT_HUB}] : " HUB
HUB="${HUB:-$DEFAULT_HUB}"
HUB="${HUB%/}"

echo
echo "Il te faut un jeton d'appareil. Pour l'obtenir :"
echo "  1. ouvre ${HUB} et connecte-toi"
echo "  2. menu en haut à droite → « Jetons d'appareil »"
echo "  3. donne un nom à cette machine (ex. « MacBook de Marie ») et crée le jeton"
echo "  4. copie-le : il n'est affiché qu'une seule fois"
echo
read -r -s -p "Colle le jeton ici (rien ne s'affiche) : " TOKEN
echo
echo

if [ -z "$TOKEN" ]; then
  echo "Aucun jeton saisi — abandon." >&2
  exit 1
fi

echo "Vérification auprès du hub…"
# On teste avec un lot vide : si le jeton est bon le hub répond 200 sans rien modifier.
STATUS="$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 \
  -X POST "${HUB}/api/sync/push" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H 'Content-Type: application/json' \
  -d '{"projects":[],"threads":[],"messages":[]}' || echo 000)"

case "$STATUS" in
  200)
    echo "✓ Jeton accepté par ${HUB}"
    ;;
  401)
    echo "✗ Jeton refusé (401). Vérifie que tu l'as copié en entier, et qu'il n'a pas été révoqué." >&2
    exit 1
    ;;
  000)
    echo "✗ Hub injoignable à ${HUB}. Vérifie l'URL et ta connexion." >&2
    exit 1
    ;;
  *)
    echo "✗ Réponse inattendue du hub (HTTP ${STATUS})." >&2
    exit 1
    ;;
esac

security add-generic-password -a "$USER" -s "$KEYCHAIN_SERVICE" -w "$TOKEN" -U
echo "✓ Jeton rangé dans le trousseau (entrée « ${KEYCHAIN_SERVICE} »)"

echo
echo "Dernière étape : installer le service, qui lira ce jeton au démarrage."
echo "  SYNC_HUB_REMOTE_URL=${HUB} ./scripts/install_service.sh"
