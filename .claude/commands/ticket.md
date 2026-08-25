---
description: Traite une issue de bout en bout — worktree, branche, implémentation, validation, PR, revue et merge, en tenant le ticket à jour à chaque étape
argument-hint: <numéro d'issue> [--no-merge] [--no-worktree] [--draft]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, EnterWorktree, ExitWorktree, Skill
---

Traite l'issue **#$1** de bout en bout, dans un worktree isolé.

Conventions de référence : [.claude/skills/project-flow/SKILL.md](.claude/skills/project-flow/SKILL.md)
et [BRANCHING.md](BRANCHING.md).

**Options** — `--no-merge` : s'arrête après la barrière de CI, laisse la PR
ouverte · `--no-worktree` : travaille dans le dépôt courant · `--draft` : ouvre
la PR en brouillon et s'arrête là.

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

## Journal d'exécution

**À chaque phase**, avant de l'entamer et à son issue :

```bash
python scripts/milestone_run.py event --ticket $1 --phase <phase> \
       [--status <statut>] [--level DEBUG|INFO|WARN|ERROR] \
       [--pr <n>] [--branch <b>] --message "<ce qui vient de se passer>"
```

Phases, dans l'ordre où elles se déroulent : `recevabilite`, `isolation`,
`prise-en-charge`, `implementation`, `validation`, `revue`, `commits`, `pr`,
`ci`, `merge`, `cloture`, `nettoyage`.
Statuts — à ne poser que sur un vrai changement d'état : `running`, `pr_open`,
`ci_green`, `reviewed`, `merged`, `failed`, `blocked`. Sans `--status`, la ligne
est un simple détail d'avancement ; `--level DEBUG` pour ce qui n'intéresse que
le diagnostic.

Le message est ce qu'un humain doit lire pour comprendre **sans ouvrir le
transcript**. Un verdict, un chiffre, un chemin — jamais « étape terminée » :

```
npm run verify : lint ok, typecheck ok, 142 tests, 0 échec (48s)
terraform validate : variable "region" non déclarée dans modules/bootstrap/main.tf:12
revue : 2 constats bloquants (fuite inter-tenant L84), 3 non bloquants
```

Ce que cela produit : un log lisible en continu dans
`.claude/.milestone/latest.log`, un tableau de bord (`milestone_run.py watch`),
et la matière du compte rendu final.

**Sans run de jalon ouvert, la commande sort sans rien faire** — ces appels sont
donc inoffensifs quand `/ticket` est lancé seul, et indispensables quand
`/milestone` orchestre plusieurs agents dont les comptes rendus ne sont montrés
à personne. Ne pas les conditionner à quoi que ce soit.

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

## Phase 5 — Revue et correction, en une seule passe

Une revue complète, puis une correction complète. **Pas de seconde revue.**

Invoquer la skill `code-review` sur le **diff local**, avec `--fix`, avant tout
commit :

| Le diff touche | Niveau |
|---|---|
| `mod:payments`, `mod:availability`, `mod:appointments`, une migration Prisma, `infra/terraform/`, l'authentification ou le scoping tenant | `high` |
| tout le reste | `medium` |

`high` élargit la couverture au prix de constats incertains — donc de corrections
à instruire. Le réserver à ce qui casse cher.

Deux raisons de revoir **avant** de pousser plutôt qu'après :

- `--fix` corrige dans la même passe que la revue — une seule lecture du diff au
  lieu de deux ;
- les corrections se fondent dans les commits de la phase 6, au lieu d'ajouter un
  commit « corrections de revue » **et un second cycle de CI complet**.

### Ce qui se traite dans la passe

Classer les constats une fois pour toutes :

- **Bloquant** — correctness, fuite inter-tenant, régression de concurrence,
  donnée de carte exposée, secret, migration destructive. **Tous corrigés ici**,
  y compris ceux que `--fix` n'a pas su traiter seul.
- **Non bloquant** — simplification, lisibilité, performance non critique.
  Corrigé si c'est une ligne dans un fichier déjà touché ; sinon **issue de
  suivi** (phase 10), pas une rallonge de diff.

Puis rejouer les vérifications que les corrections peuvent avoir cassées : la
cible concernée si le correctif est localisé, `npm run verify` en entier sinon.

### La règle qui tient le temps de traitement

**Ne pas relancer `code-review` après avoir corrigé.** Un second passage relit
tout le diff pour, presque toujours, ne rien trouver de neuf — et il coûte une
revue *plus* un cycle de CI, puisque ses constats arrivent après le push. C'est
ce doublon qui a fait déraper le traitement de #111.

Le compromis est explicite : **les corrections de revue ne sont pas elles-mêmes
revues**, elles sont couvertes par `npm run verify` et par la CI de la phase 8.
Sur un changement où cela ne se tolère pas — paiements, sécurité, migration,
infra — c'est `--no-merge` qu'il faut, et une relecture humaine.

**Un bloquant qui ne se corrige pas dans cette passe** — il demande une décision,
un changement de conception, ou sort de l'empreinte du ticket — arrête le
parcours : journaliser `--status blocked`, commenter l'issue avec le constat,
**ne pas merger**. Pas de seconde revue pour trancher à sa place.

Journaliser le verdict **sans `--status`** : `reviewed` ne se pose qu'en phase 8,
une fois la CI verte — le journal refuse un statut qui recule.

```bash
python scripts/milestone_run.py event --ticket $1 --phase revue \
  --message "revue medium : 2 bloquants corrigés (fuite tenant L84, montant float L112), 3 non bloquants → suivi"
```

Garder la synthèse sous la main : elle se publie sur la PR en phase 7.

## Phase 6 — Commits et push

Commits en Conventional Commits, portée = module métier concerné. Inclure
`Refs #$1` dans le corps. Découper par intention, pas en un seul commit fourre-tout.

Avant de pousser, vérifier qu'aucun secret, clé ou `.env` n'est dans le diff.

```bash
git push -u origin <branche>
```

## Phase 7 — Pull request

```bash
gh pr create --repo TMap-Works/spa-booking --base develop \
  --title "<type>(<scope>): <sujet>" --body-file -
python scripts/project_status.py $1 "In review"
```

Le corps suit [.github/pull_request_template.md](.github/pull_request_template.md)
et **doit** contenir `Closes #$1` — c'est cette ligne qui ferme l'issue au merge.
Reprendre les critères d'acceptation en cases cochées.

Publier ensuite la synthèse de la revue de la phase 5 :

```bash
gh pr review <pr> --repo TMap-Works/spa-booking --comment --body "..."
```

Ce qui a été trouvé, ce qui a été corrigé dans le même diff, ce qui part en issue
de suivi. C'est la seule trace de revue attendue : pas de commentaires inline —
ils porteraient sur des lignes déjà réécrites par la phase 5.

Avec `--draft`, ouvrir en brouillon et **s'arrêter ici** en donnant l'URL.

## Phase 8 — Intégration continue

```bash
python scripts/pr_gate.py <pr>
```

Le script attend que **tous** les workflows déclenchés par la PR aient conclu,
puis rend son verdict par un code de sortie : `0` vert · `1` en attente ou délai
dépassé · `2` check en échec · `3` PR inapte au merge · `4` erreur d'appel ·
`5` périmètre sensible, PR laissée ouverte pour relecture humaine.

Le `5` ne peut tomber que sous reprise automatique — `pr_gate.py` ne refuse un
périmètre sensible que si `SPA_UNATTENDED` est posée, ce que fait le superviseur
de jalon et personne d'autre. Lancée à la main, `/ticket` ne le voit jamais.

**Sur un `5`, s'arrêter là.** Ce n'est pas un échec : la PR est verte, elle
attend une relecture humaine. Journaliser `--status skipped` avec le périmètre en
cause, laisser la PR ouverte, ne pas enchaîner sur la phase 9 — le merge sera
refusé de la même façon — et le dire dans le compte rendu final.

Ne comptent comme verts que `SUCCESS`, `SKIPPED` et `NEUTRAL` — `SKIPPED` couvre
les workflows filtrés par chemin (`terraform.yml` hors `infra/`) et
`project-automation.yml` qui sort proprement sans `PROJECT_TOKEN`. Tout le reste
bloque, y compris `CANCELLED` et `TIMED_OUT`. Une PR **sans aucun check** bloque
également : cela veut dire qu'aucun workflow ne s'est déclenché, pas que tout va
bien.

Si la CI échoue : lire les logs (`gh run view --log-failed`), corriger, pousser,
relancer le script. **Trois échecs consécutifs → s'arrêter**, commenter la PR
avec le diagnostic et rendre la main. Une boucle de correction qui s'entête
masque un problème de fond. Corriger la CI ne rouvre **jamais** la revue : on
répare ce que le check nomme, rien d'autre.

Une fois vert, journaliser les deux statuts dans cet ordre — `advance()` ne
recule pas, et `reviewed` avalerait `ci_green` s'il était posé avant :

```bash
python scripts/milestone_run.py event --ticket $1 --phase ci --status ci_green \
  --message "pr_gate : 6 workflows conclus, 0 échec"
python scripts/milestone_run.py event --ticket $1 --phase revue --status reviewed \
  --message "revue phase 5 publiée sur la PR, 2 bloquants traités, 0 restant"
```

## Phase 9 — Merge

Sauf `--no-merge` ou `--draft`. Le merge passe **toujours** par la barrière,
jamais par un `gh pr merge` en direct :

```bash
python scripts/pr_gate.py <pr> --request-merge
```

Le script vérifie la CI, pose le label `merge-when-green`, puis **attend que le
merge ait lieu**. Ce n'est pas lui qui merge : c'est
[auto-merge.yml](../../.github/workflows/auto-merge.yml), côté GitHub, qui rejoue
la même barrière avant d'agir. Poser le label ne court-circuite donc rien — une
PR rouge étiquetée reste non mergée, et le workflow réessaie à chaque fois qu'un
workflow conclut.

Ce détour existe pour une raison précise : merger depuis la session est une
action qu'un classifieur de permissions retient pour la faire valider, ce qui
arrête le ticket. Sous `/milestone`, les vagues tournent en `claude -p`, où
**aucune demande de permission ne peut être répondue** — la vague échouerait en
silence. Déléguer le merge à la CI met l'autorisation là où elle est explicite,
tracée et révocable : retirer le label, ou désactiver le workflow.

`--merge` merge encore depuis la machine appelante. Le garder pour le dépannage,
pas pour le déroulé normal.

Ni l'un ni l'autre ne relâche quoi que ce soit : la barrière refuse une PR en
brouillon, en conflit, ou qui ne cible pas `develop`, et relit l'état juste avant
d'agir — un workflow a pu démarrer entre le verdict de la phase 8 et maintenant.
Squash uniquement : c'est le seul mode autorisé sur le dépôt, et le titre de PR
devient le message de merge, d'où l'exigence Conventional Commits.

Pourquoi une barrière et non la consigne « vérifier que la CI est verte » : le
dépôt est sur un plan GitHub **Free**, sans protection de branche ni check
obligatoire. GitHub accepterait de merger une PR rouge, et son auto-merge natif
n'aurait aucun check requis à attendre. Le seul verrou est celui-ci, et un code
de sortie ne se contourne pas aussi facilement qu'une phrase.

**La seule condition que le script ne peut pas voir** est le résultat de la
phase 5 : s'il reste un constat bloquant non résolu, ne pas l'appeler du tout.

Après un merge réussi, le script vérifie que la branche **distante** a bien
disparu — le workflow la supprime — puis délègue le local à `worktree_gc.py` — qui emporte
worktree et branche locale d'un même geste, avec ses garde-fous. Si la locale
subsiste, il le dit : c'est que le worktree était sale ou portait des commits
non poussés.

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

Sortir du worktree avec `ExitWorktree`, `action: "keep"`, puis vérifier depuis
le dépôt principal que la phase 9 a bien tout emporté :

```bash
python scripts/worktree_gc.py   # sans effet si pr_gate a déjà fait le ménage
git worktree list               # plus de ligne pour ce ticket
git branch --list "*$1-*"       # doit être vide
```

Après un merge par `pr_gate.py --merge`, il ne reste normalement rien à faire :
le ramasse-miettes a déjà été appelé. Ce second appel est idempotent et sert de
contrôle — c'est lui qui rattrape les parcours interrompus, `--no-merge`, ou un
merge fait à la main sur GitHub.

`"keep"` plutôt que `"remove"` est délibéré : `ExitWorktree` ne supprime que la
branche qu'il a lui-même créée (`worktree-…`), que le renommage de la phase 1
lui a fait perdre de vue — il laisserait une branche orpheline à chaque ticket.
Le script, lui, supprime le worktree **et** sa branche, et seulement sur preuve
que le ticket est terminé : PR mergée, branche intégrée, ou issue fermée.

Si la commande s'est arrêtée avant le merge, il n'y a rien à faire : le script
conserve tout worktree dont la PR est encore ouverte, tout worktree sale et tout
commit jamais poussé. **Dire où le travail se trouve** — chemin du worktree, nom
de branche, URL de la PR, et ce qui reste à faire.

Ce nettoyage est de toute façon automatique — les hooks `SessionStart` et `Stop`
lancent le même script (voir [.claude/hooks/README.md](.claude/hooks/README.md)).
L'appeler ici ne fait que le rendre immédiat et vérifiable dans le compte rendu.

## Compte rendu final

Terminer par un état factuel : issue, branche, PR, statut CI, constats de revue
traités et laissés, merge fait ou non, statut de la carte Project. Si une étape a
été sautée ou a échoué, le dire explicitement — ne pas conclure « terminé » sur
un parcours partiel.
