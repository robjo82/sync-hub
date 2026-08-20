# sync-hub

Un petit démon local qui centralise, **verbatim**, l'historique de tes conversations IA locales
(Claude Code, Codex CLI, Claude Cowork, imports Claude.ai/ChatGPT) dans une base SQLite unique, et
l'expose :

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

```bash
git clone <url-de-ce-repo>
cd sync-hub
npm install
npm run build
./scripts/install_service.sh   # installe un service launchd macOS (démarre à la connexion)
```

Le dashboard est servi sur `http://127.0.0.1:4000` (local uniquement par défaut).

Pour désinstaller : `./scripts/uninstall_service.sh`.

### Variables d'environnement (toutes optionnelles)

| Variable                  | Défaut                  | Usage                                  |
| -------------------------- | ------------------------ | --------------------------------------- |
| `SYNC_HUB_PROJECTS_ROOT`   | `~/Projets`               | Racine scannée pour découvrir les projets |
| `SYNC_HUB_DATA_DIR`        | `<repo>/data`              | Emplacement de la base SQLite et des logs |
| `SYNC_HUB_IMPORTS_DIR`     | `<repo>/imports`           | Dossier des exports bulk (ChatGPT, Claude.ai) |
| `PORT`                     | `4000`                    | Port du dashboard/API                    |
| `HOST`                     | `127.0.0.1`                | Interface d'écoute (reste local par défaut) |

## Connecter le serveur MCP

```bash
# Claude Code
claude mcp add sync-hub -s user -- node <repo>/dist/server/mcp-entry.js

# Codex — dans ~/.codex/config.toml
[mcp_servers.sync-hub]
command = "node"
args = ["<repo>/dist/server/mcp-entry.js"]
```

Outils exposés : `get_project_timeline`, `get_thread`, `search_transcripts`, `link_threads`,
`unlink_thread`, `get_thread_link_updates` (continuation explicite entre plusieurs fils, avec
récupération delta-only des nouveautés).

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
- `src/core/adapters/` — un adaptateur par source (Claude Code, Codex, Cowork, exports bulk).
- `src/core/watch.ts` — watch temps réel des nouvelles sessions.
- `src/core/mcp-server.ts` — serveur MCP.
- `src/server/` — API REST + WebSocket (Fastify).
- `src/client/` — dashboard (React + Vite + Tailwind).
