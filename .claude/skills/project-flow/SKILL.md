---
name: project-flow
description: Flux de travail GitHub du projet — issues, labels, milestones de sprint, GitHub Project v2, branches, commits conventionnels, pull requests et automatisations. À charger dès qu'une tâche implique de créer une issue, démarrer une fonctionnalité, ouvrir une PR, faire le point sur un sprint ou modifier .github/.
---

# Flux de travail GitHub

Dépôt : `TMap-Works/spa-booking`. Project : **Spa & Salon Booking — MVP**
(project org n°2). Modèle de branching identique aux autres dépôts TMap-Works.

## 1. Le cycle complet

```
issue  →  branche  →  commits  →  PR vers develop  →  revue  →  merge
  │                                                              │
  └──────────── la carte du Project suit automatiquement ────────┘
```

**Rien ne se code sans issue.** L'issue est ce qui rattache le travail au sprint,
au workstream et au module — donc au suivi d'avancement du MVP.

## 2. Anatomie d'une issue

Chaque issue porte, sans exception :

| Attribut | Valeurs |
|---|---|
| **Milestone** | `S1 — Fondations`, `S2 — Réservation`, `S3 — Back-office & paiements`, `S4 — Notifications, reporting & lancement` |
| **Label workstream** | `ws:devops`, `ws:backend`, `ws:frontend`, `ws:design`, `ws:qa` |
| **Label module** | `mod:identity`, `mod:catalog`, `mod:availability`, `mod:appointments`, `mod:crm`, `mod:payments`, `mod:notifications`, `mod:reporting`, `mod:infra` |
| **Label type** | `type:epic`, `type:feature`, `type:bug`, `type:chore`, `type:docs`, `type:spike` |
| **Label priorité** | `P0` (bloquant), `P1` (MVP requis), `P2` (souhaitable) |

Une issue hors périmètre MVP reçoit `post-mvp`, **aucun milestone**, et n'est pas
travaillée. C'est le garde-fou contre le scope creep — risque à probabilité élevée
du CDC §6.

Les tickets de traçabilité ouverts par les hooks Claude Code (label `tracking`)
ne font pas exception : même anatomie, même carte sur le board. Un ticket sans
jalon n'apparaît dans aucun suivi et ne documente donc rien. Ils se filtrent par
leur label quand une vue doit ne montrer que le backlog produit. Détail dans
[.claude/hooks/README.md](../../hooks/README.md).

Le corps d'une issue de fonctionnalité contient des **critères d'acceptation
vérifiables**. « L'API renvoie 409 si le créneau est pris » est vérifiable ;
« la réservation marche bien » ne l'est pas.

## 3. Branches

`{type}/{numéro-issue}-{description-courte}` — le numéro d'issue est ce qui permet
aux automatisations de relier la branche à sa carte.

```
feature/42-moteur-disponibilite
bugfix/57-fuseau-horaire-rappel
hotfix/61-webhook-stripe-signature
```

- `feature/*` et `bugfix/*` partent de `develop` et y retournent.
- `hotfix/*` part de `main`, retourne dans `main`, puis **back-merge manuel** vers
  `staging` et `develop`. Oublier le back-merge fait réapparaître le bug au
  déploiement suivant.
- Durée de vie visée : **5 jours ouvrés maximum**. Sur un MVP de 4 semaines, une
  branche qui vit plus longtemps est une branche qui va diverger douloureusement.

## 4. Commits

Conventional Commits, validés par commitlint en CI. Types autorisés :
`feat fix docs ci chore security perf hotfix test refactor`.

```
feat(availability): calcul des créneaux avec buffers avant/après
fix(notifications): ne pas envoyer le rappel d'un RDV annulé
security(payments): vérifier la signature des webhooks sur le corps brut
```

La portée (`scope`) est le nom du module métier ou `infra`, `web`, `ci`.
Sujet ≤ 100 caractères, à l'impératif, sans point final.

## 5. Pull requests

- Cible **`develop`** par défaut. Une PR vers `main` qui ne vient ni de `staging`
  ni d'un `hotfix/*` est une erreur.
- Le titre suit lui aussi Conventional Commits — il devient le message de merge.
- Le corps contient **`Closes #42`**. C'est cette ligne qui ferme l'issue au merge
  et déplace la carte du Project en `Done`.
- Une PR = une issue. Une PR qui ferme trois issues est une PR trop grosse à
  relire sérieusement.
- Approbations : **1** pour `develop` et `staging`, **2** pour `main`.
- La CI doit être verte : lint, types, tests, commitlint, scan de sécurité.

## 6. Le GitHub Project

Champs personnalisés du board :

- **Status** : `Backlog` → `Ready` → `In progress` → `In review` → `Done`
- **Sprint** : `S1` … `S4`
- **Workstream** : DevOps, Backend, Frontend, Design, QA
- **Module** : les 8 modules métier + Infra
- **Priority** : P0 / P1 / P2
- **Estimate** : jours-homme (les fourchettes du CDC §3.5)

Ce qui est automatique (workflow `project-automation.yml` + workflows intégrés) :

| Événement | Effet sur la carte |
|---|---|
| Issue créée | Ajoutée au Project, Status = `Backlog` |
| Issue assignée | Status = `In progress` |
| PR ouverte liée à l'issue | Status = `In review` |
| PR mergée / issue fermée | Status = `Done` |

Ce qui reste manuel : passer de `Backlog` à `Ready` (arbitrage de préparation),
renseigner `Estimate`, et affecter le `Sprint` lors du planning hebdomadaire.

## 7. Cadence (CDC §3.1)

Sprints d'**une semaine**, quatre au total. Chaque semaine : planning le lundi,
point quotidien, revue et rétrospective le vendredi, démo de l'incrément.

Jalons — un jalon manqué se traite au moment où il est manqué, pas en fin de projet :

| Jalon | Fin de | Critère |
|---|---|---|
| M1 Fondations | S1 | Infra déployée, CI/CD opérationnel, auth et catalogue fonctionnels |
| M2 Réservation client | S2 | Un client réserve, reporte, annule, consulte son historique |
| M3 Back-office & paiements | S3 | Agenda, staff, fiches clients, encaissement et POS de base |
| M4 Go-Live | S4 | Périmètre MVP livré, recette validée, durci, en production |

## 8. Definition of Done (CDC §3.1)

Une issue n'est `Done` que si **tout** est vrai :

- [ ] Code revu et approuvé
- [ ] Tests unitaires **et** d'intégration passants
- [ ] Test d'isolation inter-tenant pour tout endpoint nouveau
- [ ] Déployé et vérifié en recette (`staging`)
- [ ] Documenté — README du module, ADR si une décision structurante a été prise
- [ ] Critères d'acceptation de l'issue cochés un par un

## 9. Commandes utiles

```bash
gh issue list --milestone "S2 — Réservation" --label "ws:backend"
gh issue create --template feature.yml
gh pr create --base develop --fill
gh project item-list 2 --owner TMap-Works

python scripts/pr_gate.py 42            # attend la CI, rend un verdict
python scripts/pr_gate.py 42 --merge    # merge en squash si tout est vert
python scripts/worktree_gc.py --dry-run # ce que le ménage supprimerait
python scripts/project_status.py 42 "In review"          # bouge la carte
python scripts/tracking.py classify 90 --module payments # corrige un ticket
```

**Ne pas merger avec `gh pr merge` en direct.** Le dépôt est sur un plan GitHub
Free : sans protection de branche ni check obligatoire, GitHub accepte de merger
une PR rouge. `scripts/pr_gate.py` est le seul verrou — il exige que tous les
workflows aient conclu au vert, relit l'état juste avant d'agir, puis supprime
la branche distante et locale.

## 10. Automatisation du cycle

`/ticket <issue>` enchaîne tout ce qui précède dans un worktree isolé :
recevabilité, branche conforme, prise en charge, implémentation, `npm run verify`,
PR, attente de la CI, revue automatique et merge — en tenant l'issue et la carte
Project à jour à chaque phase.

Trois points à connaître avant de s'y fier :

- **La carte ne bouge pas toute seule.** Tant que le secret `PROJECT_TOKEN` n'est
  pas posé, `project-automation.yml` ne s'exécute pas. C'est
  `scripts/project_status.py` qui pilote le champ Status, appelé explicitement
  par la commande.
- **Le merge se fait sans approbation, mais jamais sans CI verte.** GitHub
  interdit d'approuver sa propre PR : la revue est publiée en commentaire. La CI,
  elle, est un verrou dur — `scripts/pr_gate.py` refuse de merger tant qu'un
  workflow n'a pas conclu au vert. Sur un changement sensible, préférer quand
  même `--no-merge` ou le parcours pas à pas : c'est la relecture *humaine* qui
  manque, pas la vérification automatique.
- **Le worktree exige `origin/HEAD` bien positionné**, sinon il part de `main`.
  Voir [docs/github-setup.md](../../../docs/github-setup.md).

Pour garder la main étape par étape, utiliser `/feature-start`, `/pr-open` et
`/sprint-status`, qui appliquent les mêmes conventions sans enchaîner.

`/ticket-new` ne traite rien : il ouvre le **ticket de traçabilité** de la
demande en cours, ou corrige le classement de celui que le hook a déjà ouvert.
Le confondre avec `/ticket <issue>` reviendrait à documenter un échange au lieu
de livrer une fonctionnalité.
