---
description: Déroule un jalon entier — ordonne ses issues, les regroupe en vagues parallélisables, lance un agent par ticket et intègre vague après vague
argument-hint: [jalon] [--width N] [--waves N] [--plan] [--fresh] [--no-merge] [--yes]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, Skill, AskUserQuestion
---

Déroule le jalon **$1** — et **sans argument, celui qu'il reste à dérouler** :
ordonner, paralléliser, exécuter, intégrer, en journalisant tout. Savoir où on
en est est le travail de la commande, pas celui de qui la tape (phase 0).

Conventions de référence : [.claude/skills/project-flow/SKILL.md](.claude/skills/project-flow/SKILL.md).
Le traitement d'un ticket isolé reste [/ticket](.claude/commands/ticket.md) —
cette commande ne le réimplémente pas, elle l'orchestre.

**Options** — `--width N` : nombre d'agents simultanés (défaut 3) ·
`--waves N` : s'arrêter après N vagues · `--plan` : produire le plan et rendre
la main · `--fresh` : ouvrir un run neuf au lieu de reprendre l'inachevé ·
`--no-merge` : tout mener jusqu'à la PR sans rien merger · `--yes` : ne pas
demander d'arbitrage sur les tickets sensibles — leurs PR sont alors **laissées
ouvertes** plutôt que mergées sans que personne les ait lues. `--resume` reste
accepté mais ne sert plus à rien : **la reprise est le comportement par
défaut**.

## Ce que cette commande ne fait pas

- **Elle ne remplace pas la relecture humaine.** Elle enchaîne des merges
  automatiques sur `develop` — posés par la CI, via le label `merge-when-green`.
  Le seul verrou dur est la CI (`pr_gate.py`, rejouée par auto-merge.yml) ; sur
  un plan GitHub Free il n'y a ni protection de branche ni approbation exigée.
  D'où l'arbitrage demandé à chaque vague qui contient un ticket sensible — et,
  quand il ne peut pas être demandé (`--yes`, reprise automatique), le refus de
  merger ces PR-là, qui restent ouvertes.
- **Elle ne rattrape pas un backlog mal tenu.** Une issue sans milestone, sans
  label de classement ou sans critère d'acceptation est écartée du plan, pas
  devinée. Le plan dit lesquelles et pourquoi.
- **Elle ne traite pas un jalon en une fois.** Chaque vague est un point d'arrêt
  net : rien n'est perdu si on s'arrête là, et la relance reprend d'elle-même.
- **Elle ne survit pas à sa propre limite de quota.** La session qui orchestre
  meurt avec la fenêtre de cinq heures ; c'est
  [milestone_supervise.py](../../scripts/milestone_supervise.py), hors de Claude
  Code, qui attend et relance (dernière section).

---

## Phase 0 — Le jalon, le plan et le run

**Sans `$1`, ne pas deviner et ne pas demander à sec.** Dresser d'abord le
tableau :

```bash
python scripts/milestone_run.py next --json
```

Il rend chaque jalon avec ses issues closes, le run qui lui est attaché et son
avancement, plus le `recommended` que le script propose — reprendre avant
ouvrir, puis l'échéance. Poser alors **une** `AskUserQuestion` avec la
proposition en première option (suffixée « (Recommandé) ») et les autres jalons
encore ouverts en face. La réponse devient `$1` pour tout le reste de la
commande.

Deux cas où l'on n'interroge personne : `recommended` est le seul jalon
proposable, ou la commande tourne sous reprise automatique (`SPA_UNATTENDED`).
On prend alors la proposition et on l'annonce.

Puis une seule commande, qu'il s'agisse d'un premier passage ou d'une reprise :

```bash
python scripts/milestone_run.py start "$1" --width <N>
```

`start` sans jalon fait ce même choix tout seul — c'est ce qui rend le script
utilisable à la main et depuis le superviseur. Passer `$1` quand il est connu
évite simplement de rejouer l'appel à GitHub.

**`start` reprend le run inachevé du jalon** au lieu d'en ouvrir un nouveau. Il
faut `--fresh` pour forcer un run neuf — et il n'y a presque jamais de raison de
le faire : rouvrir un run repartirait de zéro sur des tickets déjà en PR.

`start` **arme aussi la reprise automatique** : à partir de cet instant, une
coupure de quota, un plantage ou un redémarrage ne demandent plus rien à
personne (voir « La reprise automatique », plus bas). Pour un jalon dont **toutes**
les PR doivent être relues, ouvrir le run avec `--no-merge` — c'est ce
réglage-là qui sera rejoué à chaque reprise. Les seules PR de périmètre sensible
n'ont pas besoin de ce réglage : elles restent ouvertes d'office sous reprise
automatique, **sauf celles que `--merge-sensitive` a pré-autorisées** à
l'ouverture du run (phase 2). Ce réglage-là se rejoue lui aussi à chaque reprise.

À la reprise, `start` enchaîne tout seul sur `reconcile`, qui confronte le
journal à l'état réel du dépôt — issues closes, PR ouvertes ou mergées, branches
poussées, **worktrees vivants** — et le corrige. C'est indispensable, parce que
**l'état journalisé n'est pas l'état réel** : un agent tué entre son `git push`
et l'ouverture de sa PR laisse le journal sur `running` alors que le travail est
là ; un autre, tué juste après un merge, laisse un ticket en `pr_open` alors
qu'il est fini. Le dépôt fait foi, et il n'y a donc **rien à vérifier à la
main** avant de relancer.

**Ne jamais supprimer un worktree pour « faire le ménage » avant une reprise.**
Une branche à zéro commit n'est pas une branche abandonnée : la phase 1 de
`ticket.md` impose un `git rebase origin/develop` avant tout commit, si bien que
*toute* branche y passe et y reste le temps que l'agent installe ses
dépendances, lise le CDC et compose son plan. Deux signaux disent qu'un agent la
tient encore, et l'un suffit :

- `git worktree list` la donne **`locked`** — un worktree verrouillé est un
  worktree occupé ;
- son worktree contient des fichiers non commités.

`reconcile` connaît maintenant ces signaux et classe un tel ticket `running`, pas
`pending`. Le contredire à la main — supprimer le worktree, relancer le ticket —
détruit un travail qui n'a simplement pas encore été poussé, et lance un second
agent sur l'empreinte du premier. C'est ce qui s'est produit en #130.

Le ménage a son moment et son outil : `worktree_gc.py`, en fin de vague
(phase 4), qui conserve d'office tout worktree sale ou porteur de commits non
poussés.

Ce que la commande imprime alors — vague de reprise, tickets déjà engagés,
tickets à lancer — est le point de départ : reprendre en phase 1 sur cette
vague-là. Pour l'inspecter séparément :

```bash
python scripts/milestone_run.py resume     # où reprendre, après réconciliation
python scripts/milestone_run.py status
```

Le plan lui-même se calcule à part quand on veut seulement le lire :

```bash
python scripts/milestone_plan.py "$1" --width <N>     # l'ordre et les vagues
```

Le plan répond à deux questions :

- **l'ordre** — score d'importance : priorité, `risk`, `security`, et surtout le
  nombre d'issues que l'issue débloque. Ce qui ouvre la voie passe avant ce qui
  est seulement urgent ;
- **le parallélisme** — deux issues ne partagent une vague que si aucune ne
  dépend de l'autre *et* si leurs empreintes de fichiers sont disjointes. Deux
  branches qui écrivent le même fichier finissent en conflit de fusion, et le
  conflit coûte plus cher que le parallélisme ne rapporte.

## Phase 1 — Revue du plan

Le script déduit ; il ne sait pas lire une issue. **Lire les issues de la
première vague et des deux suivantes**, et confronter :

| Vérifier | Symptôme d'une erreur de plan |
|---|---|
| l'empreinte annoncée | une issue qui touchera manifestement d'autres fichiers que ceux listés |
| les prérequis | deux issues d'une même vague dont l'une consomme visiblement le travail de l'autre |
| les sérialisations | deux issues séparées alors qu'elles vivent dans des répertoires distincts |
| les issues écartées | un classement incomplet qu'il suffit de corriger pour rendre l'issue traitable |

Toute correction s'écrit dans
[.claude/milestone-rules.json](.claude/milestone-rules.json) — `resources` pour
une empreinte, `depends` + `why` pour un prérequis — **puis on relance le
script**. Corriger le plan à la main dans sa tête ne sert qu'une fois ; corriger
le fichier sert à chaque passage et se relit en revue.

Découper une ressource trop grosse est le principal levier de vitesse :
`infra/terraform` sérialise sept issues, `infra/terraform/modules/network` n'en
sérialise qu'une. Mais ne l'affiner que si c'est vrai — un parallélisme obtenu
par une empreinte optimiste se paie en conflits.

Avec `--plan`, présenter le plan revu et **s'arrêter ici**.

## Phase 2 — Accord

Avant la première vague, présenter : le nombre de vagues, la largeur, les issues
de la vague 1, ce qui sera mergé automatiquement, et **comment suivre le run**
(section « Suivre et piloter un run en cours », chemin du log compris).
Demander l'accord.

Sont **sensibles**, au sens de [/ticket](.claude/commands/ticket.md) : les labels
`mod:payments` et `security` — portés par l'**issue**, jamais par la PR —, un
schéma ou une migration Prisma, `infra/terraform`, et `apps/api/src/modules/payments`.
La liste qui fait foi est celle de `scripts/pr_gate.py` (`SENSITIVE_LABELS`,
`SENSITIVE_PREFIXES`, `PRISMA`) ; celle-ci en est le reflet.

### Ce que le run a déjà autorisé

Ce n'est pas une question ouverte : la réponse a pu être donnée à l'armement, et
elle se lit avant de la reposer.

```bash
python scripts/milestone_supervise.py --state
```

La ligne `périmètres armés` dit lequel des trois cas s'applique, et **il faut
l'annoncer dans la présentation de la phase 2**, avant la première vague :

| `périmètres armés` | Ce que fait la vague |
|---|---|
| `pré-autorisés : infra/terraform, prisma` | ces périmètres se mergent comme le reste ; les autres restent ouverts |
| `aucun pré-autorisé` | toute PR sensible reste ouverte pour relecture |
| `sans objet — armé en --no-merge` | rien n'est mergé, sensible ou non |

Le réglage se pose à l'ouverture du run et **pas ailleurs** — c'est ce qui en
fait un geste humain daté plutôt qu'une déduction :

```bash
python scripts/milestone_run.py start "$1" --width 3 --merge-sensitive infra/terraform,prisma
```

Nommer les périmètres un par un plutôt que tout ouvrir d'un coup est le réglage
attendu : le socle Terraform peut avancer seul pendant que `mod:payments` reste
sous relecture humaine.

### L'arbitrage qui reste

Pour ce que le run n'a **pas** pré-autorisé, et seulement pour cela : quand une
vague en contient, demander l'arbitrage **une fois pour la vague**
(`AskUserQuestion`, sauf `--yes`) : tout merger · laisser ces PR ouvertes pour
relecture · s'arrêter.

**Sous `--yes`, la question n'est pas posée et la réponse est « laisser ces PR
ouvertes ».** C'est le seul choix tenable : une vague lancée par la reprise
automatique tourne en `claude -p`, où personne ne peut répondre, et merger par
défaut reviendrait à poser la question pour n'en jamais tenir compte.

Deux chemins appliquent cette règle, et il faut les distinguer :

- **Sous reprise automatique**, elle ne t'est pas confiée : le superviseur pose
  `SPA_UNATTENDED` dans l'environnement de chaque vague — « personne ne peut
  répondre » — et, à côté, `SPA_MERGE_SENSITIVE` — « voici ce qui a déjà été
  répondu ». `pr_gate.py` refuse alors les PR sensibles **hors** de cette liste,
  et laisse passer celles qui y sont. Ne pas trier toi-même : passe-lui toutes
  les PR vertes, le code de sortie 5 désigne celles qui restent ouvertes.
- **Sous `/milestone --yes` tapé à la main**, ces variables n'existent pas et la
  barrière ne refusera rien : c'est alors à toi de tenir la règle. Ne passe pas
  ces PR à `pr_gate.py --request-merge`, laisse-les ouvertes, et dis-le dans le
  compte rendu de vague.

Laisser une PR ouverte a une conséquence à dire tout de suite : **les issues qui
en dépendent ne pourront pas démarrer**, puisque leur branche partirait d'un
`develop` amputé. Le plan suivant les écartera d'elles-mêmes (« PR déjà
ouverte ») ; la vague suivante sera donc plus courte.

## Phase 3 — La vague

Avant de lancer quoi que ce soit, demander l'autorisation au run :

```bash
python scripts/milestone_run.py gate
```

`0` continuer · `1` pause demandée — finir la vague en cours et s'arrêter ·
`2` arrêt demandé — ne lancer aucun agent · `3` plus rien à faire · `4` quota
épuisé — **ne lancer aucun agent** : il mourrait au milieu de son ticket et
laisserait une branche sans PR. Dire à quelle heure le quota revient (le `gate`
l'imprime) et s'arrêter là ; c'est le superviseur qui relancera. Le `gate`
imprime aussi les décisions prises à la main pendant le run : tickets écartés
(`skip`), tickets à relancer (`retry`). **Les appliquer avant de composer la
vague.**

Puis un agent par issue, **tous lancés dans un seul message** — c'est ce qui les
fait travailler en même temps plutôt qu'à la queue leu leu. Jamais plus que la
largeur du plan. `Agent` avec `subagent_type: "general-purpose"`,
`isolation: "worktree"` et **`run_in_background: false`**.

### `run_in_background: false`, et ce n'est pas négociable

Une vague tourne dans `claude -p`, et **`claude -p` sort dès que le modèle cesse
d'écrire**. Un agent lancé en arrière-plan meurt donc avec le processus qui l'a
lancé, au milieu de son ticket, sans PR et sans rien pousser.

C'est ce qui s'est produit dans la nuit du 25 août : trois étapes de suite,
15 minutes chacune, 20,80 $, **zéro ticket abouti**. Les trois tickets lancés
étaient tous figés en phase `prise-en-charge` — la deuxième sur onze. Un ticket
complet demande 25 à 40 minutes ; l'orchestrateur, lui, avait fini son tour en
quinze.

`run_in_background: false` fait exactement ce qu'il faut ici : les agents d'un
même message travaillent toujours **en parallèle**, mais l'appel ne rend la main
qu'une fois **tous** les comptes rendus reçus. Le tour ne peut donc pas se
terminer sous eux, et `claude -p` ne peut pas sortir.

**Ne termine pas ton tour tant qu'un agent de la vague n'a pas rendu son compte
rendu.** Ni pour annoncer que la vague est lancée, ni pour rendre un état
d'avancement : tout ce qui est écrit avant le retour des agents les tue. Une
vague dure des dizaines de minutes — c'est normal, et c'est le seul mode où un
ticket va à son terme.

Chaque prompt est autonome — l'agent démarre sans rien savoir de cette
conversation :

> Traite l'issue **#N** du dépôt `TMap-Works/spa-booking` de bout en bout.
>
> Invoque la skill `ticket` avec les arguments `N --no-worktree --no-merge`.
> Si elle n'est pas disponible, lis `.claude/commands/ticket.md` et applique-la
> à la lettre — **y compris sa section « Journal d'exécution », qui n'est pas
> optionnelle ici** : ton compte rendu final n'est montré à personne, ces lignes
> de journal sont la seule trace visible de ce que tu fais.
>
> Deux écarts à la commande, et deux seulement :
>
> - **Tu es déjà dans un worktree isolé** : n'appelle pas `EnterWorktree`, ne
>   sors pas du répertoire courant. Vérifie et corrige toi-même les trois points
>   de la phase 1 : nom de branche `{type}/N-{slug}` conforme à
>   `^(feature|bugfix|chore|docs)/[0-9]+-[a-z0-9._-]+$` (`git branch -m`), base
>   sur `origin/develop` (`git fetch origin develop && git rebase origin/develop`
>   avant tout commit), `node_modules` présent.
> - **Tu ne merges pas.** Tu t'arrêtes après la barrière de CI de la phase 8, PR
>   ouverte. La revue a eu lieu en phase 5, avant le push : **ne la relance pas**
>   après avoir corrigé la CI.
>
> **Reprise, le cas échéant.** Si le `gate` a annoncé « À REPRENDRE » pour ce
> ticket, un worktree porte déjà du travail : appelle `EnterWorktree` avec
> `path: <le chemin annoncé>` **avant toute autre chose**, et poursuis ce qui
> s'y trouve. Ne l'efface pas, ne le prends pas pour un vestige, n'ouvre pas de
> worktree neuf — ce sont des commits et des fichiers déjà gagnés. Commence par
> `git status` et `git log --oneline origin/develop..HEAD` pour voir où le
> précédent s'est arrêté, puis reprends à la phase de `ticket.md` qui suit.
>
> **Ton empreinte est `<ressources>`**, c'est-à-dire `<chemins>`. D'autres agents
> travaillent en parallèle sur d'autres tickets, à partir du même `develop`. Si
> le travail t'oblige à modifier un fichier hors de cette empreinte : **ne le
> modifie pas**, journalise `--status blocked` avec le chemin en cause, termine
> ce qui reste et signale-le.
>
> Termine par un compte rendu factuel : numéro et URL de la PR, nom de branche,
> verdict de `pr_gate.py`, constats de revue traités et laissés, fichiers touchés
> hors empreinte, et ce qui n'a pas été fait.

Pendant la vague, ne rien merger et ne rien modifier dans le dépôt principal :
les agents rebasent sur `origin/develop`, le faire bouger sous eux les mettrait
en conflit.

Un agent qui échoue n'arrête pas la vague. On journalise, on continue, on rend
compte.

## Phase 4 — Intégration

Les merges sont **séquentiels**, jamais concurrents. Deux merges simultanés sur
`develop` se voient l'un l'autre en conflit ou, pire, passent tous les deux sur
un état que ni l'un ni l'autre n'a testé.

Pour chaque PR de la vague, par ordre de score décroissant :

```bash
python scripts/pr_gate.py <pr> --request-merge
# et seulement si le code de sortie est 0 :
python scripts/milestone_run.py event --ticket <n> --phase merge --status merged \
       --actor orchestrateur --message "mergée en squash"
```

**Ne journaliser `merged` que sur un code 0.** Avec `--request-merge`, le code 1
— délai dépassé, label posé, merge pas encore fait — est un résultat courant :
écrire « mergée » pour une PR encore ouverte fait reprendre le run sur un état
faux.

`--request-merge` pose le label `merge-when-green` et **attend** que
[auto-merge.yml](../../.github/workflows/auto-merge.yml) ait mergé. L'attente est
ce qui préserve la séquence : la PR suivante doit partir d'un `develop` qui porte
déjà la précédente. Ne pas la remplacer par `--no-await` dans cette boucle.

C'est le seul mode qui fonctionne ici. Une vague tourne en `claude -p`, où aucune
demande de permission ne peut être répondue : un merge lancé depuis l'agent, si
un classifieur le retenait, ferait échouer la vague **en silence**.

- **`1` (en attente)** : le délai est passé sans merge. Le label reste posé et le
  workflow réessaiera, mais **ne pas enchaîner la PR suivante** — chercher
  d'abord ce qui bloque, sans quoi la séquence est rompue.
- **`3` (inapte)** après un merge précédent : la base a divergé. Renvoyer un
  agent court sur cette seule branche — `git fetch origin develop && git rebase
  origin/develop`, résoudre, `git push --force-with-lease`, puis rappeler le
  gate. Deux échecs de rebase → laisser la PR ouverte, journaliser `blocked`.
- **`2` (échec)** : journaliser `failed` avec la raison, la PR reste ouverte, on
  passe à la suivante. Le ticket repartira au plan suivant sous « PR déjà
  ouverte ».
- **`5` (périmètre sensible non pré-autorisé)** : ce n'est **pas** un échec. La
  PR est verte et relue, elle attend un humain. Journaliser **`skipped`** en
  disant quel périmètre l'a retenue, laisser la PR ouverte, passer à la
  suivante, et le porter au compte rendu de vague : sans cela personne ne saura
  qu'il y a là quelque chose à relire.

  Ne pas trier ces PR toi-même : passe-les toutes à la barrière. Elle sait ce
  que le run a pré-autorisé, tu ne le sais qu'en la relisant.

  `skipped` et pas autre chose, pour trois raisons mécaniques : c'est un statut
  **terminal**, donc la vague peut s'achever au lieu de rester ouverte
  indéfiniment ; il **compte comme un avancement**, donc le détecteur
  d'enlisement ne conclura pas à tort que le jalon piétine et ne désarmera pas
  la reprise automatique ; et il est journalisé en `WARN`, pas en `ERROR`, donc
  la PR ne se lit pas comme un échec. `reviewed` gèlerait la vague — il n'est ni
  terminal ni fatal, et `wave_state()` l'attendrait pour toujours ; `blocked` la
  ferait passer pour tombée.

Le gate relit l'état juste avant d'agir, mais **il ne peut pas savoir que la CI
d'une PR a été validée contre un `develop` plus ancien**. C'est la disjonction
des empreintes qui rend ce décalage acceptable — et le contrôle qui suit qui le
vérifie :

```bash
git -C <dépôt principal> fetch origin develop && git -C <dépôt principal> pull
npm run verify
```

Rouge après une vague verte = une interaction entre deux tickets que le plan
croyait indépendants. **Ne pas enchaîner** : ouvrir une issue `type:bug` `P0`
rattachée au jalon, dire quelles empreintes se sont recouvertes, corriger
`.claude/milestone-rules.json` pour que la paire ne se reproduise pas, puis
journaliser **au niveau du run** — sans `--ticket`, et en nommant la barrière :

```bash
python scripts/milestone_run.py event --phase validation --status blocked \
       --actor orchestrateur \
       --message "npm run verify rouge sur develop apres la vague N : <ce qui casse>"
```

C'est cette ligne, et elle seule, qui porte le constat à l'arbitre : personne ne
peut le déduire d'un fichier, puisque `develop` compile toujours du point de vue
de git. Sans elle, un `develop` cassé dort jusqu'au matin. Puis s'arrêter.

Puis le ménage, une fois pour toute la vague :

```bash
python scripts/worktree_gc.py
```

## Phase 5 — Vague suivante

**Recalculer le plan** à chaque vague, ne jamais dérouler celui de la phase 0 :
les issues fermées en sortent, les PR restées ouvertes écartent leurs
dépendantes, et l'arbitrage humain a pu changer la donne.

```bash
python scripts/milestone_run.py replan
```

Reprendre en phase 3 jusqu'à épuisement du jalon, ou jusqu'à l'une de ces
**conditions d'arrêt** :

- `gate` rend `1` ou `2` — un humain a demandé la pause ou l'arrêt, ou la pause
  sur erreur (`onerror pause`) retient le run sur un ticket tombé : le dire, et
  nommer les tickets à traiter (`retry N` / `skip N`) ;
- `gate` rend `4` — quota épuisé : s'arrêter net, sans lancer la vague ;
- `--waves N` atteint ;
- `npm run verify` rouge sur `develop` (phase 4) ;
- deux vagues consécutives dont plus de la moitié des tickets a échoué — c'est
  un problème de fond, pas une série de malchances ;
- plus aucune issue traitable alors qu'il en reste d'ouvertes : le plan dit
  pourquoi, c'est un problème de backlog, à régler avec l'humain.

À l'arrêt, journaliser et **dire où reprendre** : `/milestone` suffit, la
reprise est automatique. Si l'arrêt vient du quota (`gate` `4`), donner l'heure
du rafraîchissement et rappeler que
`python scripts/milestone_supervise.py` reprendrait tout seul à cette
heure-là.

## Phase 6 — Les permissions qui ont bloqué

Un run fait travailler des agents pendant des heures ; chaque commande non
autorisée les interrompt, et ce sont les mêmes qui reviennent d'un ticket à
l'autre. Le hook `permission_watch.py` les a consignées :

```bash
python scripts/permissions_review.py --run <id>
```

Présenter les motifs **répétés** — c'est le seuil qui fait foi, une commande vue
une fois n'a rien prouvé — avec leur classe de risque et un exemple réel, puis
demander l'accord. Sur accord :

```bash
python scripts/permissions_review.py --apply
```

Ne jamais appeler `--apply --yes` de sa propre initiative : élargir l'allowlist
réduit ce sur quoi l'utilisateur sera consulté au prochain run, et c'est
précisément la décision qui lui revient. Les motifs `réseau` et `destructif`
exigent en plus d'être nommés un par un — ne pas insister s'ils sont refusés.

## Suivre et piloter un run en cours

**À donner à l'utilisateur dès la phase 2**, avant de lancer le premier agent :
c'est sa seule prise sur un run long, puisque les comptes rendus des agents ne
lui sont pas montrés.

Rien de tout cela n'est à relancer pour se tenir au courant :

| Pour | Quoi |
|---|---|
| Voir défiler le détail | ouvrir `.claude/.milestone/latest.log` dans l'éditeur — il se remplit tout seul |
| Un tableau de bord | `python scripts/milestone_run.py watch` — se rafraîchit toutes les 2 s |
| Entrer dans un traitement | `python scripts/milestone_run.py ticket N` — phases, durées, journal, worktree ; `--follow` pour le suivre en continu |
| Suivre un seul ticket | `tail -f .claude/.milestone/<run>/tickets/N.log` — chaque traitement a son propre log |
| Depuis un autre terminal | `tail -f .claude/.milestone/latest.log` |
| Agir sur le run | `python scripts/milestone_run.py shell` |
| Savoir quand le quota revient | `python scripts/milestone_run.py quota` |

Le tableau de bord montre l'avancement, la vague en cours ticket par ticket avec
le temps passé dans la phase courante, ce qu'il y a à reprendre, et les dernières
lignes de journal. Un signal `pause` ou `stop` s'y affiche en bannière — qui l'a
posé, quand, et ce que le run va faire de la vague en cours. Les tickets en
échec ont leur section propre, en rouge, avec la phase où ils sont tombés. Un
ticket dont le temps de phase grimpe sans nouvelle ligne est un agent en
difficulté : `ticket N --follow` est la loupe à poser dessus.

Dans le shell, `pause` arrête proprement à la fin de la vague, `skip N` écarte un
ticket, `retry N` en relance un tombé, `ticket N` entre dans son traitement,
`note N` annote, `quota` dit quand le run repartira et `quota clear` lève
l'attente sans attendre. Ces décisions sont lues par le `gate` de la vague
suivante : elles prennent effet au prochain point de contrôle, **pas au milieu
d'une vague** — un agent déjà lancé va au bout de son ticket.

**`onerror pause`** (dans le shell ou en commande directe) arme la pause sur
erreur : dès qu'un ticket finit `failed` ou `blocked`, le `gate` suivant rend
`1` et le run se retient — l'erreur se traite d'abord (`retry N` ou `skip N`),
la vague suivante attend. Sans elle, comportement historique : un échec reste
visible mais n'arrête rien avant les garde-fous de la phase 5. `onerror
continue` désarme.

Le log est un vrai fichier daté et à niveaux (`DEBUG`, `INFO`, `WARN`, `ERROR`),
conservé par run dans `.claude/.milestone/<run>/run.log`, avec le pendant
machine en NDJSON à côté — et un log par ticket dans
`.claude/.milestone/<run>/tickets/N.log`, alimenté en temps réel par les mêmes
événements. Pour ne relire que ce qui a mal tourné :
`python scripts/milestone_run.py log --level WARN`.

## La reprise automatique — rien à relancer, jamais

Un jalon dure plus longtemps que la fenêtre de quota de cinq heures. Quand elle
se referme, **la session qui orchestre meurt** : elle ne peut ni attendre, ni se
rappeler elle-même. C'est pourquoi `milestone_run.py start` — donc la phase 0 de
cette commande — arme
[scripts/milestone_supervise.py](../../scripts/milestone_supervise.py) au moment
où le run s'ouvre. **Il n'y a rien à lancer à la main, ni maintenant ni après une
coupure.**

Deux boucles, parce qu'une seule ne suffit pas :

- **Le superviseur** appelle `claude -p "/milestone … --waves 1"` — une vague par
  appel, chaque vague étant un point d'arrêt net — et lit le flux `stream-json`
  de cet appel. Claude Code y émet un événement `rate_limit_event` portant
  `status`, `rateLimitType` et `resetsAt` : **l'instant exact où les jetons
  reviennent**. Sur `rejected`, il inscrit la retenue, dort jusqu'à cette
  seconde-là, et relance. Pas de sondage, pas d'estimation.
- **Le chien de garde** est une tâche planifiée Windows qui se réveille toutes
  les cinq minutes. Le superviseur ne survit ni à un plantage, ni à un terminal
  fermé, ni à un redémarrage — et il n'existe pas quand la limite tombe au
  milieu d'un `/milestone` lancé à la main. La tâche pose trois questions :
  reste-t-il du travail ? un superviseur bat-il encore ? le quota est-il revenu ?
  Si oui, non, oui — elle relance un superviseur détaché.

Pendant l'attente, `gate` rend `4`, aucun agent n'est lancé, et le tableau de
bord affiche le compte à rebours.

**La règle d'autorisation, à ne pas contourner :** tant qu'un run est ouvert, la
relance automatique a le droit de s'exécuter ; dès qu'il n'y en a plus, elle se
supprime. Le marqueur est le run — `.claude/.milestone/current` pointant sur un
dossier existant —, pas le terminal qui l'a ouvert : un run doit survivre à la
fermeture d'une fenêtre et à un redémarrage, sinon la reprise après quota ne
servirait à rien. Quatre choses retirent l'autorisation, et chacune fait que la
tâche planifiée se supprime au réveil suivant : jalon déroulé, `stop` ou `pause`
demandé dans le run, run effacé, intention vieille de plus de quinze jours.

Pour regarder ou débrancher :

```bash
python scripts/milestone_supervise.py --state     # qui veille, sur quoi
python scripts/milestone_supervise.py --disarm    # tout débrancher
```

Trois points à dire à l'utilisateur en phase 2, avant la première vague :

- **La reprise automatique merge sur `develop` sans relecture** — sauf sur les
  périmètres sensibles, dont les PR restent ouvertes d'office (la barrière les
  refuse, cf. phase 2). C'est le prix du « sans intervention ». Deux réglages
  déplacent cette frontière, et tous deux se posent **à l'ouverture du run**,
  jamais après :
  - `--merge-sensitive infra/terraform,prisma` ouvre nommément quelques
    périmètres sensibles, en laissant les autres sous relecture. C'est le
    réglage qui débloque un jalon d'infrastructure sans ouvrir `mod:payments` ;
  - `--no-merge` ferme tout, sensible ou non : la reprise s'arrêtera aux PR.
- **Le dossier doit être approuvé dans Claude Code.** Sinon `claude -p` ignore
  l'allowlist de `.claude/settings.json`, aucune demande de permission ne peut
  être répondue en mode `-p`, et les agents échouent en silence. Le préflight du
  superviseur le vérifie et le dit.
- **Une tâche planifiée est enregistrée** sous le nom
  `SpaBooking-Milestone-Watchdog`, dans le compte de l'utilisateur, sans droits
  d'administrateur. `--disarm` la supprime.

Garde-fous : `--max-legs`, `--max-hours`, un report d'une demi-heure quand le
préflight échoue (session `gh` expirée, dépôt injoignable), et le désarmement
complet après `--patience` étapes consécutives sans un ticket de plus — le seul
cas où l'humain doit revenir, et il est dit dans le journal.

## L'arbitre — ce qui décide quand tu n'es pas là

La reprise automatique sait faire **repartir** un run. Elle ne savait pas
**décider**. Au premier ticket tombé, à la première PR verte laissée ouverte, à
la première étape coupée au temps, le superviseur s'effaçait et attendait
quelqu'un : un jalon lancé le soir s'arrêtait sur la première question posée.

À chacun de ces points d'arrêt, le superviseur appelle désormais
[/milestone-arbitrate](milestone-arbitrate.md) sur **Claude Opus 5**. L'arbitre
lit le dossier du run — journal, log de chaque ticket, flux de la dernière étape
avec ses erreurs d'outil et ses refus de permission, PR du jalon et verdict de la
barrière, état de `develop`, worktrees vivants — puis tranche, en se fondant sur
le CDC, les ADR et les skills du dépôt.

**Ce qu'il traite :** ticket `failed` ou `blocked`, fichier hors empreinte, gate
retenu par la pause sur erreur, étapes stériles, patience épuisée, étape morte
debout, rebase en conflit, CI rouge, PR verte non mergée, périmètre sensible,
`verify` rouge sur `develop`.

**Ce qu'il ne fait jamais :** poser une question — personne ne peut y répondre —,
arrêter le jalon parce que c'est difficile, ou lever une pause posée à la main.
Son dernier cran d'escalade est **d'écarter un ticket** avec une issue de suivi
détaillée, pour que les vingt autres continuent.

Trois bornes le tiennent :

- **il n'est appelé que s'il y a matière** — `milestone_arbiter.py should` regarde
  d'abord ce qui est gratuit, et une étape saine ne coûte aucun tour d'Opus 5 ;
- **l'escalade est mécanique** — relancer, puis corriger, puis écarter ; deux
  arbitrages par ticket, et la même cause rencontrée deux fois saute un cran ;
- **le budget du run est compté** — douze arbitrages, après quoi le dispositif
  s'arrête et le dit : ce n'est plus un ticket qui résiste, c'est le jalon.

Chaque décision est journalisée avec l'acteur `arbitre` : elle se lit dans
`milestone_run.py watch`, `log` et `ticket N`, comme le reste. `status` et le
tableau de bord affichent le compte et la dernière décision.

En cas de merge d'un périmètre sensible, l'arbitre publie sa revue sur la PR
**avant** de merger, et n'ouvre que ce périmètre-là, pour cet appel-là. C'est une
relecture par un modèle, pas par quelqu'un : pour un jalon où cela ne se tolère
pas, c'est `--no-merge` qu'il faut à l'ouverture du run.

Réglages, sur `milestone_supervise.py` : `--no-arbiter` (comportement d'avant),
`--arbiter-model`, `--arbiter-budget`, `--arbiter-timeout`, et `--stall-minutes`
— au-delà duquel un journal muet fait couper l'étape et porter l'affaire à
l'arbitrage, sans attendre `--leg-timeout`.

**`--leg-timeout` (120 min par défaut)** borne l'attente d'une étape. Depuis que
l'orchestrateur attend ses agents, une étape n'a plus de fin naturelle : un seul
agent coincé — invite de permission sans personne pour y répondre, commande qui
ne rend jamais la main — retiendrait le superviseur indéfiniment, et la veille,
le voyant battre, ne le relancerait pas. Le run serait mort en paraissant vivant.
La coupure ne juge pas le travail, elle borne l'attente : les worktrees sont
conservés et l'étape suivante reprend les tickets là où ils en sont.

## Compte rendu final

Un état factuel, jalon par vague :

- issues traitées, mergées, en PR ouverte, échouées — avec leurs numéros ;
- reste à faire sur le jalon, et le nombre de vagues qu'il représente ;
- au vu de l'échéance, le critère de franchissement du jalon (project-flow §7)
  est-il atteignable — **oui ou non**, pas une nuance ;
- corrections apportées à `.claude/milestone-rules.json`, et pourquoi ;
- ce qui attend une décision humaine ;
- le chemin du journal et la commande pour reprendre.

Ne pas conclure « jalon traité » sur un parcours partiel. Le CDC §6 identifie le
glissement du calendrier comme le risque n°1 : un plan qui s'annonce plus avancé
qu'il ne l'est est exactement la façon dont ce risque se réalise.
