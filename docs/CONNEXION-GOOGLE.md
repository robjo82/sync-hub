# Connexion Google

Tout le code est en place. Il reste **une étape console**, impossible en ligne de commande :
`gcloud` n'expose aucune commande de création de client OAuth web (vérifié : ni `iap oauth-brands`,
ni `iap oauth-clients`, ni `iam oauth-clients` en alpha ou beta).

## 1. Créer le client OAuth (console Cloud, ~3 minutes)

1. <https://console.cloud.google.com/apis/credentials>, projet au choix.
2. **Écran de consentement OAuth** → type **Interne** si l'organisation Google Workspace `ekonum.fr`
   est disponible. C'est le réglage le plus sûr : seuls les comptes de l'organisation peuvent même
   tenter de se connecter.
3. **Créer des identifiants** → **ID client OAuth** → type **Application Web**.
4. URI de redirection autorisée, exactement :

   ```
   https://sync-hub.robin-joseph.fr/api/auth/google/callback
   ```

   Pour tester en local, ajouter aussi `http://127.0.0.1:4000/api/auth/google/callback`.

5. Noter l'**ID client**. Le **secret** ne doit pas transiter par une conversation.

## 2. Déposer le secret

```bash
security add-generic-password -a "$USER" -s "sync-hub-google-client-secret" -w
```

La saisie est masquée et confirmée : rien n'atterrit dans l'historique du shell.

## 3. Configurer

Quatre variables. **Les quatre sont obligatoires** : s'il en manque une, la connexion Google reste
désactivée et le bouton ne s'affiche pas.

| Variable | Valeur |
|---|---|
| `SYNC_HUB_GOOGLE_CLIENT_ID` | l'ID client |
| `SYNC_HUB_GOOGLE_CLIENT_SECRET` | le secret |
| `SYNC_HUB_GOOGLE_REDIRECT_URI` | `https://sync-hub.robin-joseph.fr/api/auth/google/callback` |
| `SYNC_HUB_GOOGLE_ALLOWED_DOMAINS` | `ekonum.fr` (séparés par des virgules si plusieurs) |

> **`SYNC_HUB_GOOGLE_ALLOWED_DOMAINS` absente désactive tout le flux**, délibérément. Sans
> restriction de domaine, « se connecter avec Google » signifie « n'importe quel compte Google au
> monde », ce qui sur un magasin de conversations clients n'est pas un écran de connexion mais une
> porte ouverte. Oublier la variable devait donc fermer la porte, pas l'ouvrir.

Sur le hub : ces variables vont dans le stack Portainer. En local : dans le `plist` du service, ou
exportées avant `run_daemon.sh`.

## Ce que le serveur vérifie au retour de Google

- **`state`** émis par nous, consommé une seule fois — un callback rejoué n'est pas une connexion.
- **`aud`** égal à notre ID client : TLS prouve que le jeton vient de Google, pas qu'il a été émis
  pour *cette* application.
- **`iss`** parmi les deux formes publiées par Google.
- **`exp`** non dépassée.
- **`email_verified`** vraie — une adresse non vérifiée est du texte saisi par le titulaire.
- **Domaine** : celui de l'adresse *et* la revendication `hd` doivent concorder et figurer dans la
  liste. `hd` seule ne suffit pas (un compte personnel n'en a pas), l'adresse seule non plus.

La signature du `id_token` n'est pas revérifiée localement : il est récupéré par le serveur
directement auprès du point de terminaison de Google en TLS, le seul cas où Google documente que
ce n'est pas nécessaire.

## Comptes

Une adresse déjà connue ouvre simplement une session. Une adresse inconnue **sur un domaine
autorisé** crée un compte `member` (ou `admin` s'il s'agit du tout premier compte de l'instance).
Aucun mot de passe n'est émis pour ces comptes.

La connexion par mot de passe reste active en parallèle — si Google tombe, on n'est pas enfermé
dehors.
