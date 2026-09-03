# Chantiers — demandés le 2026-09-03

**Faits :** 1, 2, 3, 4, 5, 6, 7, 8, 12 · **Restant :** 9, 10, 11, 13, 14

## Vérifications
1. **Catégories de projet** — ne remontent pas du local vers le distant ? À vérifier.
2. **Coûts dans le MCP** — l'info remonte-t-elle ? Objectif : dépense par projet / par tâche.
3. **Renommer un fil via le MCP** — possible aujourd'hui au-delà des projets et catégories ?

## Corrections
4. **Initiales du compte** — « RJ » déborde du rond.
5. **Chargement à l'ouverture** — plusieurs secondes en annonçant « aucun appareil connecté »,
   alors que tout arrive dès que l'arbre s'affiche. Message faux pendant le chargement.
6. **Échappement dans les fils** — `&#x20;`, antislashes parasites, entités HTML.
7. **Replier un prompt** — cliquer sur son en-tête quand il est ouvert doit le refermer.
8. **Cartes « réflexions »** — trop mises en avant ; doivent être plus discrètes que l'échange réel.
9. **Nom des fils** — si le premier message connu est technique, il est utilisé tel quel.
10. **Trop d'actions sur les projets** — à repenser.

## Fonctionnalités
11. **Connexion Google** — code côté sync-hub ; création du client OAuth = étape manuelle de Robin.
12. **Commande d'insertion du jeton Claude** — à fournir toute faite.
13. **Durée de frappe et durée de réflexion** — estimées à N frappes/minute (base basse,
    paramétrable sur le compte), tracées par date voire heure, au niveau fil / projet /
    catégorie / compte, et sur le tableau de bord.
    Finalité : facturation du temps au client, puis automatisation.
14. **Tutoriel dans le module Connaissances** — complet : retrouver les prompts d'un sujet,
    classer par projet, organiser en catégories.

---

## État au 2026-09-03

### Traités
- **1. Catégories** — `upsertProject` n'écrivait ni `category` ni `sort_order` : 44 projets sans
  catégorie sur le hub contre 21/14/3 en local. Corrigé, avec COALESCE pour qu'un rescan
  n'efface pas un classement manuel.
- **2. Coûts dans le MCP** — vérifié : **non exposés**. Aucun outil MCP ne renvoie de coût.
- **3. Renommer un fil via le MCP** — n'existait pas (`assign`/`archive`/`delete`/`unlink`
  seulement). Ajouté : `manage_thread` action `rename`, index de recherche mis à jour.
- **4. Initiales** — 2 initiales de 14px dans un rond de 20px. Rond passé à 32px.
- **5. « Aucun appareil connecté »** — la checklist lisait « pas encore répondu » comme
  « pas enrôlé ». Elle ne s'affiche plus avant la réponse.
- **6. Échappement** — entités et échappements markdown résolus à l'affichage, jamais dans le
  code ni dans le texte stocké. 7 tests sur des cas réels.
- **7. Repli d'un prompt** — bande « Replier » en haut ; pas toute la carte, sinon la sélection
  de texte casse.
- **8. Réflexions** — filet discret à gauche au lieu d'une carte accentuée.
- **12. Commande jeton** — forme sans écriture dans l'historique du shell.

### Restant
- **9. Nom des fils** — le renommage manuel existe maintenant ; reste à améliorer la dérivation
  automatique (ignorer un premier message technique).
- **10. Trop d'actions sur les projets.**
- **11. Connexion Google** — `gcloud` authentifié, 3 projets visibles. La création du client
  OAuth reste console-only.
- **13. Durée de frappe et de réflexion** — chantier à part entière (modèle de données,
  agrégation, réglage du rythme de frappe sur le compte, restitution).
- **14. Tutoriel Connaissances.**
