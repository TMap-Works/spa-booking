# Hooks du projet

Deux automatismes vivent ici : la **traçabilité des demandes** — un ticket GitHub
par demande faite à Claude Code — et le **nettoyage des worktrees**, qui efface
ce qu'un ticket terminé laisse derrière lui.

| Hook | Script | Effet |
|---|---|---|
| `UserPromptSubmit` | `request_open.py` | Crée l'issue qualifiée, enregistre le commit de départ, injecte le numéro dans le contexte de Claude |
| `Stop` | `request_close.py` | Commente les commits, le diffstat et le travail non commité, passe la carte en `Done`, clôture l'issue |
| `Stop` | `worktree_gc.py` | Supprime les worktrees et branches des tickets validés pendant le tour |
| `SessionStart` | `worktree_gc.py` | Idem, pour ce que les sessions précédentes ont laissé |
| `SessionStart` | `scripts/tracking.py sweep` | Referme les tickets qu'un tour interrompu a laissés ouverts |

Aucun de ces hooks ne contient de logique métier : `worktree_gc.py` enveloppe
[`scripts/worktree_gc.py`](../../scripts/worktree_gc.py) et les deux
`request_*.py` enveloppent [`scripts/tracking.py`](../../scripts/tracking.py).
Le hook décide *quand*, le script décide *quoi* — et le script reste appelable à
la main, donc testable sans provoquer un tour de conversation.

## Traçabilité des demandes

L'objectif est d'avoir dans GitHub l'historique complet de ce qui a été demandé,
et pas seulement de ce qui a été commité.

Le numéro étant injecté dans le contexte, Claude ajoute `Refs #N` à ses commits :
le ticket et le code se retrouvent liés dans les deux sens.

L'état de la session vit dans `.claude/.tracking/<session>.json`, non versionné.

### Un ticket est une issue comme les autres

Chaque ticket porte l'anatomie complète exigée par
[project-flow §2](../skills/project-flow/SKILL.md) : jalon du sprint en cours,
label `ws:*`, label `mod:*`, label `type:*`, priorité — et une carte sur le
GitHub Project, `In progress` à l'ouverture, `Done` à la clôture. Le label
`tracking` reste, lui, ce qui permet de les distinguer dans une vue du board.

Une issue sans jalon ni carte n'apparaît dans aucun suivi : elle ne documente
donc rien, ce qui était toute la raison d'ouvrir un ticket.

Le classement est déduit des mots-clés de la demande par
`scripts/tracking.py` — utile, mais faillible. Le numéro et le classement étant
injectés dans son contexte, Claude corrige ce qu'il sait faux :

```bash
python scripts/tracking.py classify 90 --module payments --workstream Backend
```

Les attributs déjà justes s'omettent. La commande remplace les labels de la même
famille, pose le jalon s'il manque et met la carte à jour.

### Ce qui n'ouvre pas de ticket

Un historique noyé sous des tickets « ok » ne documente rien. Sont ignorés :

- les commandes slash (`/feature-start`, `/pr-open`…) — elles portent déjà leur
  propre traçabilité via l'issue du backlog ;
- les relances triviales : `ok`, `continue`, `vas-y`, `merci`, `refais`, etc. ;
- les prompts de moins de 30 caractères.

Le travail déclenché par une relance est de toute façon capturé : il apparaît
dans le résumé du ticket ouvert par la demande initiale, tant que la session
n'a pas produit de `Stop` intermédiaire.

Ce que ce filtre écarte à tort se rattrape avec **`/ticket-new`**, qui ouvre le
ticket manquant — ou corrige le classement de celui du tour en cours. C'est le
seul chemin pour historiser une demande formulée en commande slash.

### Une demande enchaînée ne crée pas de second ticket

Un message envoyé pendant que Claude travaille est traité dans le même tour : le
hook `Stop` ne passera qu'une fois. Ouvrir un deuxième ticket le laisserait
ouvert pour toujours ; n'en ouvrir aucun perdrait la demande. Elle est donc
publiée en commentaire (« Demande complémentaire ») sur le ticket du tour, qui
les couvre toutes à la clôture.

### Un tour interrompu ne laisse pas de ticket ouvert

Une interruption (Échap) n'atteint jamais le hook `Stop` : l'état de session
survit et le ticket reste ouvert. La demande suivante s'y rattache comme une
demande enchaînée. Si la session est abandonnée là, le balayage du prochain
`SessionStart` referme le ticket, passé `SPA_TRACKING_SWEEP_HOURS` heures — délai
qui protège les sessions ouvertes en parallèle.

```bash
python scripts/tracking.py sweep --dry-run --older-than 0   # ce qu'il fermerait
```

### Limite connue

Un ticket est ouvert par **demande substantielle**, pas par tâche métier. Ces
tickets documentent l'historique de collaboration ; ils ne remplacent pas les
issues du backlog MVP, qui restent la référence pour le suivi d'avancement.

## Nettoyage des worktrees

`/ticket` isole chaque issue dans un worktree sous `.claude/worktrees/`. Sans
ménage, il en reste un par ticket traité, plus la branche locale correspondante.
Le ramasse-miettes supprime les deux, une fois le ticket **prouvé terminé**.

### Ce qui déclenche une suppression

| Signal | Vérifié par |
|---|---|
| Une PR dont la branche est la tête a été mergée | `gh pr list --state all` |
| La branche est déjà ancêtre d'`origin/develop` | `git merge-base --is-ancestor` |
| L'issue portée par le nom de branche est fermée | `gh issue view` |

### Ce qui l'empêche

Les garde-fous priment toujours sur les signaux ci-dessus :

- le worktree **courant** n'est jamais supprimé — la session peut travailler
  dedans au moment où le hook se déclenche ;
- `develop`, `staging`, `main` et les HEAD détachées ne sont jamais touchées ;
- une **PR encore ouverte** conserve le worktree, même si l'issue est fermée ;
- un worktree **sale** ou porteur de **commits jamais poussés** est conservé, la
  raison affichée — `--force` passe outre, jamais le hook.

Une branche seule, dont le répertoire de worktree a disparu, est jugée plus
strictement : faute de worktree à inspecter, il faut une PR mergée, ou une
branche intégrée **et** une issue fermée. Dans les deux cas le contenu est dans
`origin/develop` et rien ne peut être perdu. Seules les branches au format du
projet (`feature/42-slug`, et le `worktree-feature+42-slug` brut
d'`EnterWorktree`) sont concernées : une branche personnelle est ignorée.

### En ligne de commande

```bash
python scripts/worktree_gc.py             # nettoie ce qui est validé
python scripts/worktree_gc.py --dry-run   # montre les décisions, ne supprime rien
python scripts/worktree_gc.py --force     # ignore les garde-fous, pas les verdicts
python scripts/worktree_gc.py --no-branches   # worktrees seulement
```

`--force` lève les garde-fous, **pas** les verdicts : un ticket encore en cours
reste intact quoi qu'il arrive.

Le script est aussi appelé par [`scripts/pr_gate.py`](../../scripts/pr_gate.py)
juste après un merge réussi : la barrière supprime la branche distante, puis lui
délègue le worktree et la branche locale plutôt que de dupliquer ses garde-fous.

## Réglages

| Variable | Effet |
|---|---|
| `SPA_TRACKING=off` | Désactive complètement la traçabilité |
| `SPA_TRACKING_MIN_CHARS` | Seuil de longueur (défaut : 30) |
| `SPA_TRACKING_REPO` | Dépôt cible (défaut : `TMap-Works/spa-booking`) |
| `SPA_TRACKING_SWEEP_HOURS` | Âge à partir duquel un ticket resté ouvert est balayé (défaut : 6) |
| `SPA_PROJECT_NUMBER` | Project visé par les cartes (défaut : `2`) |
| `SPA_WORKTREE_GC=off` | Désactive le nettoyage automatique (le script reste appelable à la main) |
| `SPA_WORKTREE_BASE` | Base de référence du nettoyage (défaut : `origin/develop`) |
| `SPA_WORKTREE_GC_TIMEOUT` | Budget du hook en secondes (défaut : 60) |

Pour désactiver durablement sans toucher au dépôt, retirer les blocs concernés
de `.claude/settings.local.json`, ou passer par `/hooks`.

## Garanties

- **Aucun blocage.** Si `gh` est absent, non authentifié ou hors ligne, les hooks
  de traçabilité sortent silencieusement et le nettoyage se rabat sur le seul
  signal local (l'ancestralité). Aucun automatisme ne doit empêcher le travail.
- **Aucun bruit.** Le nettoyage ne dit rien quand il n'a rien supprimé, et sort
  en quelques millisecondes — sans toucher au réseau — s'il n'existe aucun
  worktree secondaire, ce qui est le cas courant.
- **Rattachement systématique.** Un ticket sans jalon ni carte serait invisible :
  la carte est posée par `scripts/project_status.py` au moment de l'ouverture,
  sans attendre `project-automation.yml` — ce workflow reste inerte tant que le
  secret `PROJECT_TOKEN` n'est pas posé. Si la carte échoue malgré tout, le
  ticket est créé quand même et le hook le signale.
- **Encodage.** stdin et stdout sont lus et écrits en UTF-8 explicite : sous
  Windows, `sys.stdin` décode en cp1252 et corromprait tous les accents.
