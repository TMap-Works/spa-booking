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
| **Label nature** | `nature:projet`, `nature:outillage` |
| **Label priorité** | `P0` (bloquant), `P1` (MVP requis), `P2` (souhaitable) |

### La nature : qui traite le ticket

`nature:` ne dit pas *de quoi* parle l'issue — `mod:` et `type:` s'en chargent —
mais **qui la traite**, et c'est la seule question à laquelle un run de jalon
doit pouvoir répondre seul.

| | `nature:projet` | `nature:outillage` |
|---|---|---|
| Ce que ça couvre | le produit MVP : `apps/`, `packages/`, `infra/terraform`, les workflows de CI et de déploiement du produit, ses tests | le dispositif de collaboration : `scripts/milestone_*`, `scripts/tracking.py`, `scripts/pr_gate.py`, `.claude/` (commandes, skills, hooks, réglages), les workflows qui servent le run, le harnais qui teste tout cela |
| Qui le traite | `/milestone` — un agent par ticket, en vagues | `/milestone <jalon> --nature outillage` — **un ticket à la fois**, ou `/ticket <issue>` à la main |
| Qui l'ouvre | le planning de sprint, une revue, un bug constaté | l'arbitrage du run (`/milestone-arbitrate`, phases `skip` et 7), ou une demande explicite |

**Un run ne déroule qu'une nature à la fois**, et par défaut c'est le produit.
La raison n'est pas cosmétique : un agent de vague qui réécrit
`milestone_run.py` modifie l'orchestrateur qui l'exécute, pendant qu'il
l'exécute. Ces chantiers-là se prennent isolément, en sachant ce qu'on touche —
c'est ce que fait `/milestone <jalon> --nature outillage`, qui déroule le stock
d'outillage **en séquentiel** (largeur 1) et dans l'ordre du score d'importance,
sans jamais le mêler à une vague produit.

Un ticket écarté pour sa nature **ne retient jamais ses dépendants** : le plan le
range avec les hors-périmètre et les épiques, parce que *ce* run ne le fermera
jamais et que le tenir pour un prérequis non satisfait gèlerait le jalon à vie.
La règle vaut dans les deux sens — un ticket produit ne retient pas un ticket
d'outillage sous `--nature outillage`.
La contrepartie est explicite : si un ticket produit dépend réellement d'un
chantier d'outillage, c'est à l'humain de le faire d'abord — le plan ne le saura
pas.

Une issue **sans** label `nature:*` est écartée du plan pour classement
incomplet, comme il en va d'un `ws:*` manquant. Rien n'est deviné : la supposer
« produit » enverrait un agent réécrire l'outillage, la supposer « outillage »
ferait disparaître du sprint un vrai ticket MVP.

Une issue hors périmètre MVP reçoit `post-mvp`, **aucun milestone**, et n'est pas
travaillée. C'est le garde-fou contre le scope creep — risque à probabilité élevée
du CDC §6.

Les tickets de traçabilité ouverts par `/ticket-new` (label `tracking`) ne font
pas exception : même anatomie, même carte sur le board. Un ticket sans jalon
n'apparaît dans aucun suivi et ne documente donc rien. Ils se filtrent par leur
label quand une vue doit ne montrer que le backlog produit. Détail au §12.

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

python scripts/milestone_run.py next    # où en est-on, quel jalon lancer
python scripts/milestone_plan.py S1     # ordre et vagues parallélisables du jalon
python scripts/pr_gate.py 42            # attend la CI, rend un verdict
python scripts/pr_gate.py 42 --merge    # merge en squash si tout est vert
python scripts/worktree_gc.py --dry-run # ce que le ménage supprimerait
python scripts/project_status.py 42 "In review"          # bouge la carte
python scripts/tracking.py status                        # le ticket de traçabilité ouvert
python scripts/tracking.py classify 90 --module payments --nature projet
```

**Ne pas merger avec `gh pr merge` en direct.** Le dépôt est sur un plan GitHub
Free : sans protection de branche ni check obligatoire, GitHub accepte de merger
une PR rouge. `scripts/pr_gate.py` est le seul verrou — il exige que tous les
workflows aient conclu au vert, relit l'état juste avant d'agir, puis supprime
la branche distante et locale.

## 10. Automatisation du cycle

`/ticket <issue>` enchaîne tout ce qui précède dans un worktree isolé :
recevabilité, branche conforme, prise en charge, implémentation, `npm run verify`,
revue automatique, PR, attente de la CI et merge — en tenant l'issue et la carte
Project à jour à chaque phase.

Trois points à connaître avant de s'y fier :

- **La carte ne bouge pas toute seule.** Tant que le secret `PROJECT_TOKEN` n'est
  pas posé, `project-automation.yml` ne s'exécute pas. C'est
  `scripts/project_status.py` qui pilote le champ Status, appelé explicitement
  par la commande.
- **Une seule revue, avant le push.** La skill `code-review` passe sur le diff
  local avec `--fix` : revue complète, correction complète, et c'est tout. Les
  corrections partent dans les mêmes commits et ne déclenchent donc qu'un seul
  cycle de CI. Contrepartie assumée : les corrections de revue ne sont pas
  elles-mêmes revues.
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

## 11. Traiter un jalon entier

`/milestone [jalon]` orchestre `/ticket` à l'échelle d'un sprint :
`scripts/milestone_plan.py` ordonne les issues du jalon et les regroupe en
**vagues**, puis la commande lance un agent par ticket d'une même vague et
intègre les PR séquentiellement avant de replanifier.

**Le jalon n'a pas à être nommé.** `milestone_run.py next` confronte les jalons
GitHub aux runs présents et propose celui qu'il reste à dérouler — un run
inachevé passe avant un jalon neuf, l'échéance tranche ensuite. La commande pose
alors le choix, la proposition en tête. Ce qu'il « reste à dérouler » se compte
en issues `nature:projet` : un jalon dont il ne reste que de l'outillage n'est
plus proposé, et le tableau affiche les deux chiffres côte à côte.

Trois notions portent tout le reste :

- **Le périmètre du run** est le produit : seules les issues `nature:projet`
  entrent dans un plan (§2). L'outillage se traite à la main, une session à la
  fois — c'est la seule façon de modifier le dispositif sans le faire pendant
  qu'il tourne.
- **L'ordre** est un score : priorité, `risk`, `security`, et surtout le nombre
  d'issues que l'issue débloque. Le socle passe avant l'urgent.
- **Une vague** est un groupe d'issues dont aucune ne dépend d'une autre et dont
  les **empreintes de fichiers sont disjointes**. C'est la seconde condition qui
  compte en pratique : deux branches simultanées sur le même fichier finissent en
  conflit de fusion, et le conflit coûte plus que le parallélisme ne rapporte.

Ce que le script ne peut pas déduire des labels — l'empreinte réelle d'une issue,
un prérequis qu'aucune règle générale ne donne — se fige dans
[.claude/milestone-rules.json](../../milestone-rules.json). C'est là que se
corrige un plan qui se trompe, jamais à la main dans le fil de la conversation.

Trois points à connaître :

- **Les merges sont séquentiels**, même quand le travail était parallèle, et
  chaque vague se termine par un `npm run verify` sur `develop` : la CI d'une PR
  a été validée contre un `develop` plus ancien que celui dans lequel elle
  atterrit. La disjonction des empreintes rend ce décalage acceptable ; le
  contrôle de fin de vague le vérifie.
- **Un ticket sensible** — `mod:payments`, `security`, schéma ou migration
  Prisma, `infra/terraform` — ne part jamais au merge automatique. En session,
  il déclenche un arbitrage humain ; sous reprise automatique, où personne ne
  pourrait y répondre, `pr_gate.py` refuse le merge et laisse la PR ouverte
  (code de sortie `5`). C'est la relecture que le plan Free ne peut pas imposer.
- **Une PR laissée ouverte gèle ses dépendantes** : leur branche partirait d'un
  `develop` amputé. Le plan suivant les écarte de lui-même.

### Suivre un run

Les comptes rendus des agents ne sont pas montrés à l'utilisateur : sans journal,
un run est une boîte noire de plusieurs heures. La section « Journal d'exécution »
de [/ticket](../../commands/ticket.md) fait écrire à chaque agent ce qu'il fait,
phase par phase — c'est ce qui remplit le log, et cela vaut aussi pour un
`/ticket` lancé seul, où les appels sont sans effet faute de run ouvert.

Deux vues, aucune à relancer pour se tenir au courant :

- `.claude/.milestone/latest.log` — un log daté, à niveaux (`DEBUG` `INFO` `WARN`
  `ERROR`), qui se remplit tout seul. On l'ouvre dans l'éditeur ou sous `tail -f`.
- `python scripts/milestone_run.py watch` — tableau de bord rafraîchi en continu :
  avancement, vague en cours avec le temps passé dans chaque phase, ce qu'il y a
  à reprendre, dernières lignes de journal.

```bash
python scripts/milestone_run.py watch           # la vue qu'on laisse ouverte
python scripts/milestone_run.py log --level WARN  # seulement ce qui a mal tourné
python scripts/milestone_run.py log --ticket 19   # tout ce qu'a fait ce ticket
python scripts/milestone_run.py shell           # pause, skip, retry, note
python scripts/milestone_run.py resume          # où reprendre après un arrêt
python scripts/milestone_run.py reconcile       # réaligner le journal sur le dépôt
python scripts/milestone_run.py quota           # quand le quota revient
python scripts/milestone_run.py path            # où sont log, journal et plan
```

L'état d'un ticket n'est stocké nulle part : il se **rejoue** depuis un journal
en ajout seul, doublé du log en clair. C'est ce qui permet à plusieurs agents
d'écrire en même temps sans verrou ni écrasement.

`pause`, `skip` et `retry` sont lus par l'orchestrateur au `gate` de la vague
suivante : ils prennent effet au prochain point de contrôle, **pas au milieu
d'une vague** — un agent déjà lancé va au bout de son ticket.

### Reprendre, et survivre au quota

Un run interrompu se reprend par `/milestone`, sans rien de plus : `start`
retrouve le run inachevé, et `reconcile` réaligne le journal sur l'état réel du
dépôt — issues closes, PR ouvertes ou mergées, branches poussées. Il n'y a donc
plus rien à vérifier à la main : le journal dit ce que les agents ont eu le
temps d'écrire, le dépôt dit ce qui existe, et c'est le dépôt qui fait foi.

La fenêtre de quota de cinq heures, elle, tombe au milieu d'un jalon et **tue la
session qui orchestre**. Aucune commande lancée depuis Claude Code ne peut donc
attendre son rafraîchissement. C'est le rôle de
[scripts/milestone_supervise.py](../../../scripts/milestone_supervise.py), que
`start` arme tout seul à l'ouverture du run — **il n'y a rien à lancer à la
main** :

- il appelle `claude -p "/milestone … --waves 1"` une vague à la fois, lit
  l'événement `rate_limit_event` du flux `stream-json` — qui porte `resetsAt`,
  l'instant exact du rafraîchissement —, inscrit la retenue, dort, et relance ;
- une tâche planifiée Windows le ressuscite dans les cinq minutes s'il meurt
  d'autre chose : plantage, terminal fermé, redémarrage, ou limite atteinte au
  milieu d'un `/milestone` interactif où aucun superviseur ne tournait.

Pendant l'attente, `milestone_run.py gate` rend `4` : aucun agent n'est lancé, et
le tableau de bord affiche le compte à rebours. Le dispositif se débranche seul
quand le jalon est déroulé.

```bash
python scripts/milestone_supervise.py --state    # qui veille, sur quoi
python scripts/milestone_supervise.py --disarm   # tout débrancher
```

### Les permissions qui interrompent un run

Le hook `permission_watch.py` consigne chaque commande Bash qu'aucune règle
`allow` ne couvre. En fin de run, les motifs **répétés** se transforment en
règles durables, sur accord explicite :

```bash
python scripts/permissions_review.py --run <id>   # ce qui a bloqué, et combien de fois
python scripts/permissions_review.py --apply      # après confirmation
```

Rien de tout cela n'est automatique : élargir l'allowlist réduit ce sur quoi
l'utilisateur sera consulté. Détail et garde-fous dans
[.claude/hooks/README.md](../../hooks/README.md).

`/sprint-status` observe un sprint, `/milestone` l'exécute. Les deux lisent le
même jalon ; seul le second écrit dans le dépôt.

`/ticket-new` et `/ticket-close` ne traitent rien : ils ouvrent et referment le
**ticket de traçabilité** de la demande en cours (§12). Confondre `/ticket-new`
avec `/ticket <issue>` reviendrait à documenter un échange au lieu de livrer une
fonctionnalité.

## 12. Traçabilité des demandes

L'objectif est d'avoir dans GitHub l'historique de ce qui a été **demandé** à
Claude Code, et pas seulement de ce qui a été commité.

```bash
/ticket-new     # ouvre le ticket de la demande en cours, classé et rattaché
/ticket-close   # publie le résumé des changements, passe la carte en Done, ferme
```

Les deux vont par paire. Entre les deux, les commits de la demande portent
`Refs #N` : le ticket et le code sont liés dans les deux sens. L'état du ticket
ouvert vit dans `.claude/.tracking/`, non versionné.

**L'ouverture est une décision, pas un automatisme.** C'était un hook
`UserPromptSubmit` jusqu'à l'abandon du procédé : un ticket par message de plus
de trente caractères, classé aux mots-clés, produisait un board bruyant et faux.
Juger qu'une demande mérite d'être historisée suppose de l'avoir lue. Ce qui
n'en vaut pas la peine — une relance, une question, une correction de détail —
n'ouvre plus rien.

**Un ticket est une issue comme les autres** : anatomie complète du §2, carte
`In progress` à l'ouverture, `Done` à la clôture. Le label `tracking` est ce qui
permet de les exclure d'une vue du backlog produit. Il porte aussi une
`nature:` — le label `tracking` le sort du plan de toute façon, mais c'est ce
qui permet de dire,
en fin de sprint, si les demandes ont porté sur le produit ou sur l'outillage.

**Deux demandes du même travail, un seul ticket.** La seconde se rattache en
commentaire (`tracking.py note`) plutôt que d'ouvrir un ticket qui resterait
ouvert, ou fermerait sur un résumé vide.

**Un ticket oublié se rattrape.** `python scripts/tracking.py sweep --dry-run`
montre ce qui traîne ; le seuil `--older-than` épargne les travaux en cours,
sessions parallèles comprises.

| Variable | Effet |
|---|---|
| `SPA_TRACKING_REPO` | Dépôt cible (défaut : `TMap-Works/spa-booking`) |
| `SPA_TRACKING_SWEEP_HOURS` | Âge par défaut du balayage, en heures (défaut : 6) |

**Limite connue.** Un ticket documente une **demande**, pas une tâche métier :
ces tickets historisent la collaboration, ils ne remplacent pas les issues du
backlog MVP, qui restent la référence du suivi d'avancement.
