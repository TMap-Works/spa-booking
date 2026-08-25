# Hooks du projet

Deux automatismes vivent ici : le **nettoyage des worktrees**, qui efface ce
qu'un ticket terminé laisse derrière lui, et la **veille sur les permissions**,
qui répertorie les commandes venant interrompre le travail.

| Hook | Script | Effet |
|---|---|---|
| `PreToolUse` (Bash) | `permission_watch.py` | Consigne les commandes qu'aucune règle `allow` ne couvre — celles qui vont demander une permission |
| `Stop` | `worktree_gc.py` | Supprime les worktrees et branches des tickets validés pendant le tour |
| `SessionStart` | `worktree_gc.py` | Idem, pour ce que les sessions précédentes ont laissé |

Aucun de ces hooks ne contient de logique métier : `worktree_gc.py` enveloppe
[`scripts/worktree_gc.py`](../../scripts/worktree_gc.py). Le hook décide *quand*,
le script décide *quoi* — et le script reste appelable à la main, donc testable
sans provoquer un tour de conversation.

Les deux sont **sans effet observable** dans le cas courant : ils ne suppriment
que ce qui est prouvé terminé, et n'écrivent jamais rien dans GitHub.

## Ce qui n'est plus un hook

La **traçabilité des demandes** — un ticket GitHub par demande faite à Claude
Code — a longtemps vécu ici, en `UserPromptSubmit` + `Stop`. Elle est passée aux
commandes [`/ticket-new`](../commands/ticket-new.md) et
[`/ticket-close`](../commands/ticket-close.md).

Le hook ouvrait un ticket à chaque message dépassant trente caractères, avec un
classement déduit de mots-clés : beaucoup de tickets, souvent mal rangés, et une
demande sur deux qui n'avait rien à documenter. Décider qu'une demande mérite un
ticket suppose de l'avoir lue — c'est un jugement, pas un filtre sur la longueur
du prompt.

Le script [`scripts/tracking.py`](../../scripts/tracking.py) reste le même
outil — ce sont les commandes qui l'appellent, là où les hooks l'appelaient. Doctrine et
réglages dans [project-flow §12](../skills/project-flow/SKILL.md).

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

## Veille sur les permissions

Un run de jalon (`/milestone`) fait travailler plusieurs agents en parallèle
pendant des heures. Chaque commande non autorisée interrompt le travail par une
demande d'accord — et ce sont les mêmes qui reviennent d'un ticket à l'autre :
le même `npm run verify` bloque à chaque agent.

`permission_watch.py` **ne décide rien et ne bloque rien**. Pour chaque commande
Bash, il calcule le motif d'allowlist correspondant, regarde si une règle
existante le couvre déjà, et sinon consigne l'observation dans
`.claude/.permissions/observed.ndjson` — non versionné, une ligne par
observation, ce qui rend l'écriture concurrente sûre sans verrou.

C'est [`scripts/permissions_review.py`](../../scripts/permissions_review.py)
qui, plus tard et **sur accord explicite**, transforme les motifs répétés en
règles `allow` de `.claude/settings.json` :

```bash
python scripts/permissions_review.py              # ce qui a bloqué, et combien de fois
python scripts/permissions_review.py --run <id>   # pendant ce run de jalon seulement
python scripts/permissions_review.py --apply      # après confirmation, écrit les règles
python scripts/permissions_review.py --forget     # repart de zéro
```

La séparation est délibérée : un hook qui ajouterait lui-même des permissions
élargirait silencieusement ce que Claude Code peut faire sans demander. Le hook
compte, l'humain décide.

### Ce qui n'est jamais proposé

- un motif couvert par une règle `deny` — `git push --force` reste refusé même
  observé cent fois ;
- les classes `réseau` et `destructif`, sauf drapeau `--include-*` **et** motif
  nommé un par un avec `--pattern` ;
- ce qui n'a bloqué qu'une fois : le seuil (`--threshold`, 2 par défaut) traduit
  l'idée qu'une commande vue une seule fois n'a rien prouvé.

Le motif proposé est toujours le plus étroit qui couvre les commandes observées :
`git status:*`, jamais `git:*`. Une commande composée est découpée sur `&&`,
`||`, `;` et `|`, car elle bloque dès que l'un de ses morceaux bloque.

Une règle ajoutée n'est relue qu'au démarrage : il faut relancer Claude Code,
ou rejouer les réglages via `/permissions`.

## Réglages

| Variable | Effet |
|---|---|
| `SPA_WORKTREE_GC=off` | Désactive le nettoyage automatique (le script reste appelable à la main) |
| `SPA_WORKTREE_BASE` | Base de référence du nettoyage (défaut : `origin/develop`) |
| `SPA_WORKTREE_GC_TIMEOUT` | Budget du hook en secondes (défaut : 60) |
| `SPA_PERMISSION_WATCH=off` | Désactive la veille sur les permissions |
| `SPA_PERMISSION_LOG` | Déplace le fichier d'observations |
| `SPA_PROJECT_NUMBER` | Project visé par les cartes posées par `scripts/project_status.py` |

Les réglages de la traçabilité (`SPA_TRACKING_REPO`, `SPA_TRACKING_SWEEP_HOURS`)
ne concernent plus de hook : voir
[project-flow §12](../skills/project-flow/SKILL.md).

Pour désactiver durablement sans toucher au dépôt, retirer les blocs concernés
de `.claude/settings.local.json`, ou passer par `/hooks`.

## Garanties

- **Aucun blocage.** Si `gh` est absent, non authentifié ou hors ligne, le
  nettoyage se rabat sur le seul signal local (l'ancestralité) et la veille sur
  les permissions n'a jamais eu besoin du réseau. Aucun automatisme ne doit
  empêcher le travail.
- **Aucun bruit.** Le nettoyage ne dit rien quand il n'a rien supprimé, et sort
  en quelques millisecondes — sans toucher au réseau — s'il n'existe aucun
  worktree secondaire, ce qui est le cas courant. `permission_watch.py`
  n'écrit jamais sur la sortie standard : il se contente d'observer, et une
  faute de sa part est avalée plutôt que de retarder la commande observée.
- **Encodage.** stdin et stdout sont lus et écrits en UTF-8 explicite : sous
  Windows, `sys.stdin` décode en cp1252 et corromprait tous les accents.
