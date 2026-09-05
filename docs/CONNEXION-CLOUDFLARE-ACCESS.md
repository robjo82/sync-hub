# Connexion par Cloudflare Access

**C'est la voie recommandée**, et elle évite entièrement Google Cloud.

Le hub est déjà derrière un tunnel Cloudflare, et Access protège déjà `secret-broker.ekonum.fr` :
l'infrastructure d'identité existe et est payée. Access sait authentifier par **code à usage
unique envoyé par courriel**, sans aucun fournisseur d'identité à configurer — donc sans créer
de client OAuth nulle part.

## Ce qu'il y a à faire, côté Cloudflare

Vérifié le 2026-09-04 : `sync-hub.robin-joseph.fr` répond en HTTP 200 direct, il n'est donc pas
encore protégé. L'équipe Access existe : `robinjoseph.cloudflareaccess.com`.

1. **Zero Trust → Access → Applications → Add an application**, type *Self-hosted*.
2. Domaine : `sync-hub.robin-joseph.fr`.
3. Méthode de connexion : **One-time PIN**. C'est celle qui n'exige aucun fournisseur d'identité.
4. Politique : *Allow*, règle **Emails ending in** `@ekonum.fr`.
5. Relever l'**Application Audience (AUD) Tag** dans l'onglet *Overview* — ce n'est pas un secret.

> Ne pas protéger `/api/sync/push` ni `/api/sync/pull` par Access : les daemons s'y authentifient
> avec leur jeton d'appareil, pas avec un navigateur. Soit on exclut ces chemins de l'application
> Access, soit on leur ajoute une politique *Service Auth*.

## Configuration du hub

| Variable | Valeur |
|---|---|
| `SYNC_HUB_ACCESS_TEAM_DOMAIN` | `robinjoseph.cloudflareaccess.com` |
| `SYNC_HUB_ACCESS_AUD` | le tag AUD relevé à l'étape 5 |
| `SYNC_HUB_ACCESS_ALLOWED_DOMAINS` | `ekonum.fr` |

Aucune n'est un secret : le tag AUD est un identifiant public, pas une clé. C'est une différence
utile avec la voie Google, qui imposait un `client_secret` à stocker et à faire tourner.

> **`SYNC_HUB_ACCESS_ALLOWED_DOMAINS` absente désactive tout**, délibérément — comme pour Google.
> Une variable oubliée doit fermer la porte, pas l'ouvrir.

## Ce que le hub vérifie

Access injecte deux en-têtes. Un seul compte :

- `Cf-Access-Authenticated-User-Email` — pratique, **jamais utilisé seul**. C'est un en-tête en
  clair : quiconque atteint l'origine directement pourrait le poser et devenir n'importe qui.
- `Cf-Access-Jwt-Assertion` — signé. C'est lui qui est vérifié, et rien n'est lu dans les
  revendications avant que la signature ne soit validée.

Sont contrôlés : l'algorithme (RS256 seulement — un jeton `alg: none` est refusé), la signature
contre les clés publiées par Access, l'audience (le tag AUD de *cette* application), l'émetteur,
l'expiration, et le domaine de l'adresse.

Les clés de signature sont mises en cache et ne sont rechargées qu'au plus une fois par minute :
sans cela, un `kid` inconnu deviendrait un moyen de faire marteler Cloudflare à la demande.

## Comptes

Une adresse déjà connue ouvre une session. Une adresse inconnue **sur un domaine autorisé** crée
un compte `member` — ou `admin` s'il s'agit du tout premier compte. Aucun mot de passe n'est émis.

La connexion par mot de passe reste active, et la voie Google reste disponible si elle est
configurée : trois chemins qui coexistent, ce qui évite de se retrouver enfermé dehors.

## Et Google, alors ?

Le code est écrit et testé (`docs/CONNEXION-GOOGLE.md`). Il reste utile si un jour l'accès doit
se faire sans passer par le tunnel Cloudflare. Mais tant que le hub est derrière Access, cette
voie n'apporte rien de plus et coûte un client OAuth à créer, un secret à stocker et à faire
tourner.
