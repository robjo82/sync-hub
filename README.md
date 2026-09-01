# sync-hub

Un petit démon local (macOS uniquement — launchd, ~/Library/...) qui centralise, **verbatim**,
l'historique de tes conversations IA locales (Claude Code, Codex CLI, Claude Cowork, Antigravity,
imports Claude.ai/ChatGPT) dans une base SQLite unique, et l'expose :

- via un **dashboard web** (arbre de projets, recherche plein texte, vue chat, couverture de
  synchro, triage des sessions non rattachées) ;
- via un **serveur MCP** que Claude Code, Codex et Antigravity peuvent interroger en direct pour
  récupérer le contexte exact d'un autre outil, sans jamais résumer ni reconstruire — toujours le
  texte original.

Rien n'est jamais deviné : une session dont le dossier de travail ne correspond à aucun projet
connu part dans un bucket « Non affecté », visible et triable, plutôt que d'être rattachée par
heuristique.

## Pourquoi

Travailler avec plusieurs outils d'IA sur les mêmes projets fait perdre le contexte à chaque
changement d'outil. sync-hub ne synchronise rien *vers* les outils (il ne touche jamais au
stockage natif d'un autre outil) — il lit ce qui existe déjà localement et le rend interrogeable
par n'importe quel outil connecté en MCP.

## Installation

Prérequis : macOS, Node.js ≥ 20 (`better-sqlite3` a un prebuild pour les versions récentes — pas
besoin d'outils de compilation dans le cas courant).

```bash
git clone <url-de-ce-repo>
cd sync-hub
npm install
npm run build
./scripts/enroll.sh            # rattache la machine au hub d'équipe (voir ci-dessous)
./scripts/install_service.sh   # service launchd macOS, démarre à la connexion
```

Le dashboard est servi sur `http://127.0.0.1:4000` (local uniquement par défaut). Au premier
lancement il affiche les applications IA détectées sur la machine, l'état d'enrôlement et où
déposer les archives cloud.

Pour désinstaller : `./scripts/uninstall_service.sh`.

## Rejoindre le hub d'équipe

Chaque personne installe sync-hub sur sa propre machine. Le démon local lit ce que les outils IA
ont déjà écrit sur le disque, puis pousse vers un hub commun qui sert de sauvegarde et de point de
partage. Rien n'y est visible par les autres tant que le projet n'a pas été explicitement partagé.

1. **Se faire créer un compte** sur le hub par un administrateur (menu compte → *Gérer les
   utilisateurs*).
2. **Créer un jeton d'appareil** : se connecter au hub, menu compte → *Jetons d'appareil*, nommer
   la machine. Le jeton n'est affiché qu'une fois.
3. **Enrôler la machine** : `./scripts/enroll.sh`. Le script vérifie le jeton auprès du hub avant
   de le ranger dans le trousseau macOS — il n'est jamais écrit dans un fichier ni passé en
   argument de commande, où l'historique du shell le garderait.

Un jeton par machine : perdre un portable se règle en révoquant son jeton, sans toucher à ceux des
autres. Une machine non enrôlée fonctionne normalement en local, simplement sans sauvegarde
distante — l'installateur le signale plutôt que de laisser croire le contraire.

### Partager un projet

Depuis l'arborescence, l'icône de partage sur un projet, puis l'email du collègue. Le partage donne
la lecture ; seul le propriétaire peut partager, et il peut retirer l'accès à tout moment. Pour
quelqu'un sans compte, les liens publics par conversation restent la bonne option.

### Conversations cloud

Claude.ai et ChatGPT ne stockent rien sur la machine : leur historique n'arrive que par un export.
Demander l'archive dans les réglages de chaque outil, puis déposer le `.zip` dans l'onglet
*Synchronisation & Appareils* (ou depuis l'écran d'accueil au premier lancement).

### Variables d'environnement (toutes optionnelles)

| Variable                  | Défaut                  | Usage                                  |
| -------------------------- | ------------------------ | --------------------------------------- |
| `SYNC_HUB_PROJECTS_ROOT`   | `~/Projets`               | Racine scannée pour découvrir les projets |
| `SYNC_HUB_DATA_DIR`        | `<repo>/data`              | Emplacement de la base SQLite et des logs |
| `SYNC_HUB_IMPORTS_DIR`     | `<repo>/imports`           | Dossier des exports bulk (ChatGPT, Claude.ai) |
| `PORT`                     | `4000`                    | Port du dashboard/API                    |
| `HOST`                     | `127.0.0.1`                | Interface d'écoute (reste local par défaut) |
| `SYNC_HUB_REMOTE_URL`      | *(aucun)*                 | Hub d'équipe vers lequel pousser/tirer |
| `SYNC_HUB_REMOTE_TOKEN`    | *(trousseau)*             | Jeton d'appareil — normalement lu du trousseau par `run_daemon.sh`, pas défini à la main |
| `SYNC_HUB_DISABLE_LOCAL_INGEST` | `0`                  | `1` sur le hub : il reçoit, il ne scanne aucun fichier |
| `SYNC_HUB_AUTH_DISABLED`   | `0`                       | `1` pour désactiver l'authentification (instance mono-utilisateur) |

## Connecter le serveur MCP

```bash
# Claude Code
claude mcp add sync-hub -s user -- node <repo>/dist/server/mcp-entry.js

# Codex — dans ~/.codex/config.toml
[mcp_servers.sync-hub]
command = "node"
args = ["<repo>/dist/server/mcp-entry.js"]
```

Outils exposés :
- lecture verbatim : `get_project_timeline`, `get_thread`, `search_transcripts`
- continuité entre fils : `link_threads`, `unlink_thread`, `get_thread_link_updates` (delta-only)
- gestion de projets (mêmes actions que le dashboard) : `list_projects`, `list_threads`,
  `rename_project`, `merge_projects`, `assign_thread_to_project`, `archive_thread`,
  `archive_project`

## Importer un export Claude.ai / ChatGPT

Dépose le(s) fichier(s) d'export dans `imports/claude/` ou `imports/chatgpt/`, puis relance un scan
(bouton « Rescanner » du dashboard, ou `POST /api/sync/rescan`).

## Développement

```bash
npm run dev     # client (Vite) + serveur (tsx watch) en parallèle
npm test        # suite de tests (vitest)
npm run lint    # typecheck
```

## Architecture

- `src/core/db.ts` — schéma SQLite + accès aux données.
- `src/core/registry.ts` — résolution projet ↔ session (correspondance exacte uniquement, jamais
  de heuristique).
- `src/core/adapters/` — un adaptateur par source (Claude Code, Codex, Cowork, Antigravity, exports bulk).
- `src/core/watch.ts` — watch temps réel des nouvelles sessions.
- `src/core/mcp-server.ts` — serveur MCP.
- `src/server/` — API REST + WebSocket (Fastify).
- `src/client/` — dashboard (React + Vite + Tailwind).
