---
description: Déroule un jalon entier — ordonne ses issues, les regroupe en vagues parallélisables, lance un agent par ticket et intègre vague après vague
argument-hint: [S1|S2|S3|S4] [--width N] [--waves N] [--plan] [--fresh] [--no-merge] [--yes]
allowed-tools: Bash, Read, Write, Edit, Glob, Grep, Agent, Skill, AskUserQuestion
---

Déroule le jalon **$1** (à défaut, le jalon ouvert dont l'échéance est la plus
proche) : ordonner, paralléliser, exécuter, intégrer — en journalisant tout.

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

## Phase 0 — Le plan et le run

Une seule commande, qu'il s'agisse d'un premier passage ou d'une reprise :

```bash
python scripts/milestone_run.py start "$1" --width <N>
```

**`start` reprend le run inachevé du jalon** au lieu d'en ouvrir un nouveau. Il
faut `--fresh` pour forcer un run neuf — et il n'y a presque jamais de raison de
le faire : rouvrir un run repartirait de zéro sur des tickets déjà en PR.

`start` **arme aussi la reprise automatique** : à partir de cet instant, une
coupure de quota, un plantage ou un redémarrage ne demandent plus rien à
personne (voir « La reprise automatique », plus bas). Pour un jalon dont **toutes**
les PR doivent être relues, ouvrir le run avec `--no-merge` — c'est ce
réglage-là qui sera rejoué à chaque reprise. Les seules PR de périmètre sensible
n'ont pas besoin de ce réglage : elles restent ouvertes d'office sous reprise
automatique.

À la reprise, `start` enchaîne tout seul sur `reconcile`, qui confronte le
journal à l'état réel du dépôt — issues closes, PR ouvertes ou mergées, branches
poussées — et le corrige. C'est indispensable, parce que **l'état journalisé
n'est pas l'état réel** : un agent tué entre son `git push` et l'ouverture de sa
PR laisse le journal sur `running` alors que le travail est là ; un autre, tué
juste après un merge, laisse un ticket en `pr_open` alors qu'il est fini. Le
dépôt fait foi, et il n'y a donc **rien à vérifier à la main** avant de relancer.

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
`SENSITIVE_PREFIXES`, `PRISMA`) ; celle-ci en est le reflet. Quand une vague en
contient, demander l'arbitrage **une fois pour la vague** (`AskUserQuestion`,
sauf `--yes`) : tout merger · laisser ces PR ouvertes pour relecture · s'arrêter.

**Sous `--yes`, la question n'est pas posée et la réponse est « laisser ces PR
ouvertes ».** C'est le seul choix tenable : une vague lancée par la reprise
automatique tourne en `claude -p`, où personne ne peut répondre, et merger par
défaut reviendrait à poser la question pour n'en jamais tenir compte.

Deux chemins appliquent cette règle, et il faut les distinguer :

- **Sous reprise automatique**, elle ne t'est pas confiée : le superviseur pose
  `SPA_UNATTENDED` dans l'environnement de chaque vague, et `pr_gate.py` refuse
  alors de merger une PR sensible — il retire même le label `merge-when-green`
  s'il était déjà posé, sans quoi auto-merge.yml la mergerait depuis un runner
  où la variable n'existe pas.
- **Sous `/milestone --yes` tapé à la main**, cette variable n'existe pas et la
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
`isolation: "worktree"` et `run_in_background: true`.

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
> - **Tu ne merges pas.** Tu t'arrêtes après la revue de la phase 8, PR ouverte.
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
- **`5` (périmètre sensible)** : ce n'est **pas** un échec. La PR est verte et
  relue, elle attend un humain. Journaliser **`skipped`** en disant quel
  périmètre l'a retenue, laisser la PR ouverte, passer à la suivante, et le
  porter au compte rendu de vague : sans cela personne ne saura qu'il y a là
  quelque chose à relire.

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
`.claude/milestone-rules.json` pour que la paire ne se reproduise pas,
journaliser, et s'arrêter.

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

- `gate` rend `1` ou `2` — un humain a demandé la pause ou l'arrêt ;
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
| Depuis un autre terminal | `tail -f .claude/.milestone/latest.log` |
| Agir sur le run | `python scripts/milestone_run.py shell` |
| Savoir quand le quota revient | `python scripts/milestone_run.py quota` |

Le tableau de bord montre l'avancement, la vague en cours ticket par ticket avec
le temps passé dans la phase courante, ce qu'il y a à reprendre, et les dernières
lignes de journal. Un ticket dont le temps de phase grimpe sans nouvelle ligne
est un agent en difficulté : c'est le signal à surveiller.

Dans le shell, `pause` arrête proprement à la fin de la vague, `skip N` écarte un
ticket, `retry N` en relance un tombé, `note N` annote, `quota` dit quand le run
repartira et `quota clear` lève l'attente sans attendre. Ces décisions sont lues
par le `gate` de la vague suivante : elles prennent effet au prochain point de
contrôle, **pas au milieu d'une vague** — un agent déjà lancé va au bout de son
ticket.

Le log est un vrai fichier daté et à niveaux (`DEBUG`, `INFO`, `WARN`, `ERROR`),
conservé par run dans `.claude/.milestone/<run>/run.log`, avec le pendant
machine en NDJSON à côté. Pour ne relire que ce qui a mal tourné :
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
  refuse, cf. phase 2). C'est le prix du « sans intervention ». Pour un jalon
  dont **toutes** les PR doivent être relues, et pas seulement les sensibles,
  ouvrir le run avec `milestone_run.py start … --no-merge` : la reprise
  s'arrêtera alors aux PR.
- **Le dossier doit être approuvé dans Claude Code.** Sinon `claude -p` ignore
  l'allowlist de `.claude/settings.json`, aucune demande de permission ne peut
  être répondue en mode `-p`, et les agents échouent en silence. Le préflight du
  superviseur le vérifie et le dit.
- **Une tâche planifiée est enregistrée** sous le nom
  `SpaBooking-Milestone-Watchdog`, dans le compte de l'utilisateur, sans droits
  d'administrateur. `--disarm` la supprime.

Garde-fous : `--max-legs`, `--max-hours`, un report d'une demi-heure quand le
préflight échoue (session `gh` expirée, dépôt injoignable), et le désarmement
complet après `--patience` étapes consécutives sans un ticket de plus — c'est le
seul cas où l'humain doit revenir, et il est dit dans le journal.

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
