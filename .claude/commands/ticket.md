---
description: Traite une issue de bout en bout — worktree, branche, implémentation, validation, PR, revue et merge, en tenant le ticket à jour à chaque étape
argument-hint: <numéro d'issue> [--no-merge] [--no-worktree] [--draft]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, EnterWorktree, ExitWorktree, Skill
---

Traite l'issue **#$1** de bout en bout, dans un worktree isolé.

Conventions de référence : [.claude/skills/project-flow/SKILL.md](.claude/skills/project-flow/SKILL.md)
et [BRANCHING.md](BRANCHING.md).

**Options** — `--no-merge` : s'arrête après la revue, laisse la PR ouverte ·
`--no-worktree` : travaille dans le dépôt courant · `--draft` : ouvre la PR en
brouillon et n'enchaîne ni la revue ni le merge.

## Ce que cette commande ne fait pas

- **Elle n'approuve pas la PR.** GitHub interdit d'approuver sa propre pull
  request : la revue est publiée en commentaire (`gh pr review --comment`), pas
  en approbation. Le merge se fait donc sans l'approbation humaine que
  BRANCHING.md prévoit. C'est un compromis assumé pour la vélocité du MVP —
  utiliser `--no-merge` pour tout changement où une relecture humaine compte
  (paiements, sécurité, migrations, infrastructure).
- **Elle ne traite pas les hotfixes.** Le worktree part de `origin/develop` ; un
  `hotfix/*` part de `main` et se termine par un back-merge manuel. Suivre
  BRANCHING.md à la main dans ce cas.

---

## Phase 0 — Recevabilité

```bash
gh issue view $1 --repo TMap-Works/spa-booking \
  --json number,title,body,labels,milestone,assignees,state,url
gh pr list --repo TMap-Works/spa-booking --search "$1 in:body" --state open
```

**S'arrêter et expliquer** — sans rien créer — si :

- l'issue est déjà fermée, ou porte le label `post-mvp` (hors périmètre, CDC §1.4) ;
- une PR ouverte la référence déjà ;
- elle est assignée à quelqu'un d'autre ;
- il manque un label `ws:*`, un label `mod:*` ou un milestone ;
- le corps ne contient aucun critère d'acceptation vérifiable.

Sur les trois derniers cas, proposer les corrections à appliquer à l'issue
plutôt que de coder à l'aveugle.

## Phase 1 — Isolation

Sauf `--no-worktree` : `EnterWorktree` avec `name` = `{type}/{$1}-{slug-du-titre}`,
où `type` découle du label `type:*` (`feature`, `bugfix`, `chore`, `docs`) —
par exemple `feature/42-moteur-disponibilite`.

Puis, **dans cet ordre**, trois corrections indispensables — chacune vérifiée
sur ce dépôt, aucune n'est théorique :

```bash
# 1. EnterWorktree ne crée PAS la branche sous le nom demandé : il produit
#    worktree-feature+42-moteur-disponibilite (préfixe ajouté, "/" → "+").
#    Ce nom est rejeté par pr-governance.yml. Renommer immédiatement.
git branch -m feature/42-moteur-disponibilite

# 2. La base dépend de origin/HEAD. S'il n'est pas défini, le worktree part de
#    origin/main — la PRODUCTION — au lieu de develop.
git fetch origin develop
git rebase origin/develop        # sans commit encore, c'est un fast-forward

# 3. node_modules n'est symboliqué que si le réglage worktree est actif.
[ -d node_modules ] || npm install
```

Confirmer avant d'aller plus loin : `git log --oneline -1` doit correspondre à
la tête d'`origin/develop`, et le nom de branche doit satisfaire
`^(feature|bugfix|hotfix|chore|docs)/[0-9]+-[a-z0-9._-]+$`.

Le numéro d'issue dans le nom de branche est **obligatoire** : c'est ce qui relie
la branche à sa carte, et `pr-governance.yml` rejette toute autre forme.

## Phase 2 — Prise en charge

```bash
gh issue edit $1 --repo TMap-Works/spa-booking --add-assignee @me
python scripts/project_status.py $1 "In progress"
gh issue comment $1 --repo TMap-Works/spa-booking --body "..."
```

Le commentaire annonce la branche et le périmètre retenu, en deux ou trois
lignes. `project_status.py` est nécessaire tant que le secret `PROJECT_TOKEN`
n'est pas posé — sans lui la carte ne bouge pas (voir [docs/github-setup.md](docs/github-setup.md)).

## Phase 3 — Implémentation

Charger les skills correspondant aux labels `mod:*` de l'issue :
`booking-engine`, `tenant-isolation`, `api-module`, `payments-stripe`,
`notifications`, `web-frontend`, `aws-infra`.

Présenter un plan court adossé aux critères d'acceptation, **puis** coder.
Traiter les critères un par un ; ne pas élargir le périmètre en chemin — une
idée qui déborde devient une issue `post-mvp`, pas une ligne de code en plus.

## Phase 4 — Validation locale

```bash
npm run verify   # lint, typecheck, build, test:unit, test:integration, test:concurrency
```

Gates supplémentaires selon ce qui a été touché :

| Si le diff contient | Alors |
|---|---|
| un endpoint nouveau ou modifié | un test d'isolation inter-tenant existe et passe |
| `mod:availability` / `mod:appointments` | `npm run test:concurrency` couvre le cas ajouté |
| une migration Prisma | relue : additive, réversible, `tenant_id` non nullable, index préfixé `tenant_id` |
| `mod:payments` | aucune donnée de carte côté serveur, webhook vérifié sur le corps brut, traitement idempotent |
| le parcours critique | `npm run test:e2e` |
| `infra/terraform/` | `terraform fmt -check` et `terraform validate` |

**Ne pas passer à la suite tant que tout n'est pas vert.** Rapporter fidèlement
les échecs — sortie incluse — plutôt que de contourner un test qui gêne.

## Phase 5 — Commits et push

Commits en Conventional Commits, portée = module métier concerné. Inclure
`Refs #$1` dans le corps. Découper par intention, pas en un seul commit fourre-tout.

Avant de pousser, vérifier qu'aucun secret, clé ou `.env` n'est dans le diff.

```bash
git push -u origin <branche>
```

## Phase 6 — Pull request

```bash
gh pr create --repo TMap-Works/spa-booking --base develop \
  --title "<type>(<scope>): <sujet>" --body-file -
python scripts/project_status.py $1 "In review"
```

Le corps suit [.github/pull_request_template.md](.github/pull_request_template.md)
et **doit** contenir `Closes #$1` — c'est cette ligne qui ferme l'issue au merge.
Reprendre les critères d'acceptation en cases cochées.

Avec `--draft`, ouvrir en brouillon et **s'arrêter ici** en donnant l'URL.

## Phase 7 — Intégration continue

```bash
gh pr checks <pr> --repo TMap-Works/spa-booking --watch --fail-fast
```

Si la CI échoue : lire les logs (`gh run view --log-failed`), corriger, pousser,
attendre à nouveau. **Trois échecs consécutifs → s'arrêter**, commenter la PR
avec le diagnostic et rendre la main. Une boucle de correction qui s'entête
masque un problème de fond.

## Phase 8 — Revue automatique

Invoquer la skill `code-review` en visant la PR, niveau `high`, avec `--comment`
pour publier les constats en commentaires inline.

Puis publier une synthèse de revue :

```bash
gh pr review <pr> --repo TMap-Works/spa-booking --comment --body "..."
```

Classer les constats :

- **Bloquant** — correctness, fuite inter-tenant, régression de concurrence,
  donnée de carte exposée, secret, migration destructive.
- **Non bloquant** — simplification, lisibilité, performance non critique.

Traiter les bloquants et reboucler sur les phases 4 à 7. **Au-delà de deux
itérations, s'arrêter** : commenter la PR et l'issue, laisser la PR ouverte.

S'il reste un constat bloquant non résolu, **ne pas merger**, quelles que soient
les options passées.

## Phase 9 — Merge

Sauf `--no-merge` ou `--draft`. Trois conditions, toutes obligatoires :

1. CI verte sur le dernier commit ;
2. aucun constat bloquant en suspens ;
3. la PR cible bien `develop`.

```bash
gh pr merge <pr> --repo TMap-Works/spa-booking --squash --delete-branch
```

Squash uniquement : c'est le seul mode autorisé sur le dépôt. Le titre de PR
devient le message de merge, d'où l'exigence Conventional Commits.

## Phase 10 — Clôture du ticket

`Closes #$1` ferme l'issue automatiquement. Vérifier, et compléter :

```bash
gh issue view $1 --repo TMap-Works/spa-booking --json state,closedAt
python scripts/project_status.py $1 "Done"
gh issue comment $1 --repo TMap-Works/spa-booking --body "..."
```

Le commentaire de clôture récapitule : ce qui a été livré, la PR, le commit de
merge, les critères d'acceptation satisfaits, et **ce qui ne l'est pas** s'il
reste quelque chose. Si l'issue n'est pas fermée d'elle-même, c'est que le
`Closes` manquait : le signaler et fermer à la main.

Ouvrir une issue de suivi pour tout constat non bloquant laissé de côté, avec le
label adéquat et une référence à la PR.

## Phase 11 — Nettoyage

Si le merge a eu lieu : `ExitWorktree` avec `action: "remove"`, puis supprimer la
branche locale restée derrière.

```bash
git branch -D feature/42-moteur-disponibilite   # depuis le dépôt principal
git branch --list "*$1-*"                        # doit être vide
```

Ce ménage explicite est nécessaire : `ExitWorktree` ne supprime que la branche
qu'il a lui-même créée (`worktree-…`), et le renommage de la phase 1 la lui a
fait perdre de vue. Sans cela, une branche orpheline reste à chaque ticket.

Si la commande s'est arrêtée avant le merge : `action: "keep"`, et **dire où le
travail se trouve** — chemin du worktree, nom de branche, URL de la PR, et ce
qui reste à faire.

## Compte rendu final

Terminer par un état factuel : issue, branche, PR, statut CI, constats de revue
traités et laissés, merge fait ou non, statut de la carte Project. Si une étape a
été sautée ou a échoué, le dire explicitement — ne pas conclure « terminé » sur
un parcours partiel.
