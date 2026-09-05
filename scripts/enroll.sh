#!/usr/bin/env bash
# Rattache cette machine à un hub sync-hub.
#
# Le jeton est fabriqué ici et ne quitte jamais ce poste. Seule son empreinte est affichée, et
# une empreinte n'autorise rien : elle peut être collée dans un message, un ticket ou un courriel
# sans précaution. C'est le contraire de l'ancienne procédure, où le hub fabriquait le jeton et
# où il fallait le faire voyager jusqu'ici — utilisable, en chemin, par quiconque le voyait.
set -euo pipefail

KEYCHAIN_SERVICE="sync-hub-remote-token"
DEFAULT_HUB="https://sync-hub.robin-joseph.fr"

echo "Rattachement de cette machine à un hub sync-hub."
echo

read -r -p "URL du hub [${DEFAULT_HUB}] : " HUB
HUB="${HUB:-$DEFAULT_HUB}"
HUB="${HUB%/}"

# Un jeton déjà en place se réutilise : le refabriquer invaliderait un rattachement qui marche.
if EXISTING=$(security find-generic-password -s "$KEYCHAIN_SERVICE" -w 2>/dev/null); then
  echo
  echo "Cette machine a déjà un jeton."
  read -r -p "En refabriquer un (l'ancien cessera de fonctionner) ? [o/N] : " REPONSE
  if [ "${REPONSE:-n}" != "o" ]; then
    TOKEN="$EXISTING"
  fi
fi

if [ -z "${TOKEN:-}" ]; then
  # 32 octets d'aléa, comme les jetons émis par le hub.
  TOKEN=$(head -c 32 /dev/urandom | xxd -p | tr -d '\n')
  security add-generic-password -a "${USER}" -s "$KEYCHAIN_SERVICE" -w "$TOKEN" -U
fi

# La même empreinte que celle stockée par le hub : SHA-256 en hexadécimal.
FINGERPRINT=$(printf '%s' "$TOKEN" | shasum -a 256 | cut -d' ' -f1)

# Le jeton n'est jamais réaffiché à partir d'ici.
unset EXISTING

cat <<TEXTE

Jeton fabriqué et rangé dans le trousseau. Il n'a pas quitté cette machine.

Empreinte de cet appareil :

    ${FINGERPRINT}

Ce n'est pas un secret. Transmets-la à la personne qui administre le hub, ou
approuve-la toi-même si tu as un compte :

    1. ouvre ${HUB} et connecte-toi
    2. menu du compte, en haut à droite → « Mon compte »
    3. section « Appareils » → « Approuver un appareil »
    4. colle l'empreinte et nomme la machine

La synchronisation démarre dès l'approbation. Rien d'autre à faire ici.
TEXTE

# Enregistre l'URL du hub pour le service, qui la relit au démarrage.
DATA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/data"
mkdir -p "$DATA_DIR"
printf '{\n  "remoteUrl": "%s"\n}\n' "$HUB" > "$DATA_DIR/remote.json"

echo
echo "Hub enregistré : ${HUB}"
echo "Relance le service pour qu'il prenne effet : launchctl kickstart -k gui/\$(id -u)/fr.sync-hub.daemon"
