# ADR 0004 — Reprise automatique d'un jalon et survie à la fenêtre de quota

- **Statut** : Accepté
- **Date** : 2026-08-24
- **Contexte CDC** : §3.1 Méthodologie, §3.4 Jalons clés, §4.12 CI/CD et
  Infrastructure-as-Code

## Contexte

Un sprint dure une semaine et `/milestone` déroule ses issues par vagues
d'agents parallèles — plusieurs heures d'affilée pour un jalon. Trois choses
interrompent ce déroulé, et aucune n'est exceptionnelle :

- la fenêtre de quota Claude Code se referme au milieu du jalon ;
- le processus meurt — plantage, terminal fermé, redémarrage de la machine ;
- la coupure survient pendant un `/milestone` lancé à la main, donc sans aucun
  superviseur pour l'encaisser.

Le coût d'une interruption n'est pas le délai machine mais le délai humain : un
quota qui revient à trois heures du matin est un jalon qui redémarre à neuf
heures. Sur quatre sprints d'une semaine (CDC §3.1), cette latence-là mange le
calendrier.

Deux contraintes encadrent la réponse. La reprise doit repartir d'un état vrai :
un agent tué entre son `git push` et l'ouverture de sa PR laisse le journal en
retard sur le dépôt, et reprendre depuis le journal seul referait le travail
déjà fait. Et un dispositif qui relance des agents tout seul doit porter une
autorisation lisible et révocable, faute de quoi c'est un processus qui tourne
indéfiniment sur la machine de quelqu'un.

## Options envisagées

### Option A — Sonder périodiquement le quota

Interroger l'API à intervalle régulier, ou estimer la fin de la fenêtre à partir
de l'heure du premier refus, et réessayer quand le calcul dit que c'est bon.

Simple, mais chaque sondage est une requête qui peut être refusée à son tour, et
l'estimation est fausse par construction : la fenêtre de cinq heures ne démarre
pas au premier refus mais à la première requête de la fenêtre, instant que le
client ne connaît pas. Une estimation trop courte brûle des appels refusés en
série ; trop longue, elle laisse la machine inactive alors que les jetons sont
revenus. Or Claude Code annonce déjà l'instant exact du rafraîchissement :
sonder revient à ignorer une information qu'on reçoit gratuitement.

### Option B — Attendre à l'intérieur de la session Claude Code

Laisser l'agent constater la limite et dormir jusqu'à sa levée, sans processus
extérieur.

C'est l'option qui ne demande aucune infrastructure, et c'est précisément celle
qui ne peut pas marcher : la session qui attend est celle que la coupure a
touchée. Elle ne survit ni à un plantage, ni à la fermeture du terminal, ni à un
redémarrage — et une session qui dort cinq heures conserve tout son contexte
pour ne rien en faire, alors qu'un appel neuf repart d'un contexte vide, ce qui
est préférable après une coupure.

### Option C — Un démon permanent, indépendant de tout run

Un service installé une fois, qui veille en permanence et relance ce qu'il
trouve à faire.

Il survit à tout, mais il n'a plus de fin : rien ne dit quand il doit s'arrêter,
et le désarmer devient un geste d'administration à part, qu'on oublie. Un
dispositif capable de merger sur `develop` sans intervention ne doit pas
dépendre de la mémoire de celui qui l'a installé. Son extinction doit être la
conséquence mécanique de la fin du travail, pas une action séparée.

### Option D — Deux boucles adossées au run

Un superviseur hors session qui lit l'événement de quota au fil du flux, et une
tâche planifiée qui le ressuscite ; l'un et l'autre autorisés par l'existence
d'un run ouvert, et par rien d'autre.

Plus de pièces que les précédentes, et une dépendance au planificateur du
système d'exploitation. En échange, c'est la seule combinaison qui couvre les
trois interruptions à la fois.

## Décision

Option D. Le dispositif est armé par `milestone_run.py start` — donc par
`/milestone` — et tient en quatre règles.

**L'échéance vient du serveur.** Le superviseur lance chaque vague par
`claude -p … --output-format stream-json` et lit ce flux. Claude Code y émet un
événement `rate_limit_event` portant `status`, `rateLimitType` et `resetsAt` :
l'instant exact où les jetons reviennent. Sur `rejected`, la retenue est
inscrite dans le run, le superviseur dort jusqu'à cette seconde-là — plus une
marge — puis relance. Ni sondage, ni estimation. Quand, et seulement quand, le
flux s'interrompt avant l'événement structuré, un filet de repli reconnaît le
refus dans le texte et retient la fenêtre pleine de cinq heures : se réveiller
trop tôt coûterait un appel refusé de plus, et la même attente derrière.

**Deux boucles, parce qu'aucune ne suffit seule.** La boucle courte — le
superviseur — ne protège que du quota ; elle ne survit ni au plantage ni au
redémarrage, et elle n'existe pas quand la limite tombe au milieu d'un
`/milestone` lancé à la main. La boucle longue — une tâche planifiée qui se
réveille toutes les cinq minutes — pose trois questions dans cet ordre : un
superviseur bat-il encore ? l'autorisation tient-elle ? reste-t-il du travail ?
Si non, oui, oui, elle relance un superviseur détaché. La vitalité se lit sur un
battement daté et non sur un PID, qu'un système recycle et qu'un processus
bloqué garderait. Ensemble : la coupure de quota est encaissée à la seconde
près, et tout ce qui pourrait tuer la boucle courte est rattrapé en cinq
minutes.

**L'autorisation est le run lui-même.** Tant qu'un run est ouvert, la relance
automatique a le droit de s'exécuter ; dès qu'il n'y en a plus, elle n'a plus
rien à faire et se supprime. C'est la seule autorisation du dispositif, elle est
vérifiée à chaque réveil, et son marqueur est le run — le fichier `current`
pointant sur un dossier de run existant — et non le terminal qui l'a ouvert : un
run doit survivre à la fermeture d'une fenêtre et à un redémarrage, sans quoi la
reprise après quota ne servirait à rien.

**L'état se rejoue, puis se réconcilie.** L'état d'un ticket n'est stocké nulle
part. `journal.ndjson` est en ajout seul — chaque agent y écrit ses propres
lignes, ce qui rend l'écriture concurrente sûre sans verrou — et l'état se
rejoue depuis ces lignes. Avant chaque reprise, `reconcile` confronte cet état
au dépôt réel — issues closes, PR ouvertes ou mergées, branches poussées — et
corrige le journal. **Le dépôt fait foi**, jamais le journal.

### Les quatre situations qui retirent l'autorisation

`authorised()` rend un couple (autorisé, motif du refus) et refuse dans trois
cas : aucune intention armée, aucun run ouvert — `current` absent, ou pointant
sur un dossier effacé — et intention périmée. La quatrième situation est lue au
même réveil, juste après, dans le code de sortie de `milestone_run.py gate`.
Les quatre, et ce que chacune déclenche :

| Situation | Détectée par | Effet au réveil suivant |
|---|---|---|
| Jalon déroulé — plus rien à traiter | `gate` rend `3` (aucun run actif) | Tâche planifiée supprimée **et** intention effacée |
| `stop` ou `pause` demandé dans le run | `gate` rend `2` ou `1` | Tâche planifiée supprimée, intention conservée |
| Run effacé — `current` absent ou orphelin | `authorised()` | Désarmement complet |
| Intention vieille de plus de quatorze jours | `authorised()`, champ `expires` | Désarmement complet |

Les deux dernières sont des garde-fous de dernier recours : le désarmement
normal vient de la fin du jalon. Une panne qui n'est pas le quota — session `gh`
expirée, dépôt inaccessible — ne désarme rien : elle repousse le prochain réveil
d'une demi-heure, parce qu'elle peut se réparer seule et qu'une relance toutes
les cinq minutes n'y changerait rien.

## Conséquences

**Facilite.** Un jalon lancé le soir est déroulé au matin, quota compris : la
reprise se fait à la seconde où les jetons reviennent, pas à l'heure où
quelqu'un s'en aperçoit. Le dispositif n'ayant aucun état propre, le superviseur
peut être tué à tout moment sans rien perdre. Le journal en ajout seul autorise
plusieurs agents à écrire en parallèle sans verrou, et
`milestone_supervise.py --state` dit en une commande qui veille, sur quoi, et
jusqu'à quand le quota est fermé.

**Coûte.** Le dispositif s'appuie sur le planificateur de tâches Windows : la
boucle longue est aujourd'hui liée à cette plateforme et devra être réécrite
pour une autre — `cron`, `systemd`, `launchd`. Il dépend aussi de la forme de
l'événement `rate_limit_event` du flux `stream-json` de Claude Code, un contrat
non versionné susceptible de changer sans préavis ; le repli textuel limite les
dégâts mais rendrait l'attente moins précise. Enfin, un dossier de travail non
approuvé fait échouer les agents en silence en mode `-p`, aucune demande de
permission ne pouvant y être répondue : cela se vérifie avant d'armer.

**Ferme, et c'est le point à peser.** Dans son mode par défaut, le dispositif
**merge sur `develop` sans relecture humaine**. Il ne relit pas le code : il
enchaîne les vagues, et toute PR verte est mergée. C'est le prix explicite du
« sans intervention », et une entorse assumée à la Definition of Done du CDC
§3.1, qui exige que le code soit revu. La revue automatique de `/ticket` n'est
pas une approbation : GitHub interdit d'approuver sa propre pull request, les
constats sont donc publiés en commentaire. Le contournement existe et il est
unique : **armer avec `--no-merge`**, ce qui laisse les PR ouvertes et n'en
merge aucune. C'est ce qu'il faut faire pour tout jalon qui touche
`mod:payments`, un sujet de sécurité, une migration Prisma ou
`infra/terraform/` — les PR sont alors relues au réveil. Sans `--no-merge`, la
commande demande confirmation avant d'armer, et refuse de partir s'il n'y a pas
de terminal pour la donner.
