# Imports d'historique cloud

Dépose ici les exports officiels téléchargés depuis les comptes web, pour import ponctuel dans le store canonique (distinct de la synchro live des outils locaux).

- `chatgpt/` : le ZIP reçu par mail depuis ChatGPT (Réglages → Contrôles des données → Exporter les données), ou son contenu décompressé (`conversations.json` doit être présent quelque part dans l'arborescence).
- `claude/` : le ZIP reçu depuis claude.ai (Réglages → Compte → Exporter les données).

Les fichiers déposés ici ne sont jamais modifiés par sync-hub — ce sont des exports en lecture seule, importés une fois puis marqués comme traités dans `ingest_log`.
