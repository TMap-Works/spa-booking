---
description: Mène un audit de conception UI/UX — traverse les écrans et les parcours, les confronte au cahier des charges, aux ADR et au design system, et ouvre chaque écart dans le jalon « Design & UX »
argument-hint: [parcours ou module] [--dry-run] [--ecrans <liste>]
allowed-tools: Bash, Read, Glob, Grep, Agent, Skill, mcp__recette__api_demarrer, mcp__recette__api_jeu_dessai, mcp__recette__web_demarrer, mcp__recette__arreter
---

Mène un audit de conception sur **$ARGUMENTS** — un parcours (`réservation`,
`back-office`, `comptoir`, `compte-client`) ou un module. Sans argument,
proposer un périmètre plutôt que de le demander : le parcours client public
d'abord, puisque c'est la surface qui génère le revenu (CDC §1.4), puis les
écrans d'administration que le dernier jalon mergé a touchés.

Doctrine, grille et référentiel :
[.claude/skills/design-audit/SKILL.md](../skills/design-audit/SKILL.md).
**La charger avant tout.**

**Options** — `--dry-run` : mener l'audit et montrer les tickets **sans les
ouvrir** · `--ecrans "<a,b,c>"` : borner la traversée à ces écrans.

## Ce que cette commande ne fait pas

- **Elle ne corrige rien.** Elle ouvre des tickets. Les reprendre, c'est
  `/milestone "Design & UX"`, et c'est un run séparé — on ne reprend pas
  pendant qu'on juge.
- **Elle ne double pas `/qa`.** Un seuil franchi est un bug et appartient à la
  campagne de QA ; un écart à une référence écrite est une amélioration et
  appartient ici. La frontière est au §6 de la skill, et elle se vérifie en une
  commande (`design_tickets.py voisins`).
- **Elle ne juge pas le périmètre MVP.** Une fonctionnalité manquante n'est pas
  un écart de conception — en cas de doute, charger l'agent `mvp-scope-guard`.
- **Elle ne redessine rien.** Un audit rend des écarts et des directions, pas
  des maquettes. Une refonte n'est pas un ticket.

## Phase 1 — Le référentiel, puis le périmètre

Dans cet ordre, et pas l'inverse. Un audit qui regarde les écrans avant d'avoir
lu ce que le projet a écrit retrouve ce qu'il avait déjà en tête.

Lire — ou faire lire aux agents, mais alors le dire explicitement dans leur
consigne : `docs/specs/cdc-fr.txt` §1.3, §1.4 et §2.4 ; la skill `web-frontend` ;
`docs/design/` pour les écrans visés ; `apps/web/styles/tokens.css` ;
`apps/web/components/ui/`.

Puis énoncer le périmètre en trois lignes : les **écrans** à traverser, les
**parcours** à mener jusqu'au bout, et ce qui est **hors audit**. S'appuyer sur
ce qui existe réellement — `apps/web/app/` pour les écrans — et non sur ce que
le CDC prévoit.

```bash
python scripts/design_tickets.py grille          # la grille telle qu'appliquée
python scripts/design_tickets.py list --state open   # ce que les audits précédents ont laissé
```

Un écart déjà ouvert n'a pas à être rouvert : le script le reconnaîtra à son
empreinte, mais le connaître d'avance évite d'y consacrer du temps.

Fixer l'identifiant d'audit (`dAAAAMMJJ-N`), qui servira à tous les tickets.

## Phase 2 — Le terrain

```bash
docker compose up -d
```

Puis, par MCP, **avec `racine`** — un audit ne porte pas sur un ticket, il porte
sur le dépôt principal, et ces outils refusent de deviner quand des worktrees de
ticket sont ouverts :

1. `api_demarrer` — `{"racine": "<chemin du dépôt>"}`
2. `web_demarrer` — rend l'URL de base à donner au navigateur
3. `api_jeu_dessai` — **en dernier, et délibérément**. Avant de le poser, faire
   regarder à un agent le **premier écran d'un établissement neuf** : c'est ce
   que le gérant voit son premier jour, et c'est l'angle mort le plus constant
   du produit (`ds:etats`). Une fois le jeu d'essai posé, cet écran n'existe plus.

Relire la `racine` rendue une fois : c'est le contrôle le moins cher du
dispositif, et celui qui évite d'auditer le mauvais dépôt.

Si `web_demarrer` sert `apps/web/mockups/` faute d'écran réel, l'audit porte sur
les maquettes : **le dire**, et le redire dans le compte rendu.

## Phase 3 — La traversée

Lancer les agents `design-auditor` **l'un après l'autre**, un par parcours.

Ce n'est pas la conduite de `/qa`, et la différence a une cause matérielle : là
où `qa-frontend` et `qa-backend` tournent de front parce qu'ils n'emploient pas
les mêmes outils, **tous les agents d'audit se partagent le même navigateur
Playwright**. Deux lancés ensemble se volent la page au milieu d'un parcours, et
leurs captures ne montrent plus ce qu'ils décrivent. Découper le périmètre en
trois ou quatre parcours et les enchaîner coûte du temps de mur, pas de la
qualité.

Donner à chacun, sans le laisser deviner : le périmètre exact de la phase 1,
l'URL de base rendue par `web_demarrer`, les identifiants du jeu d'essai, les
largeurs à regarder, et la consigne de capture.

Un agent qui reçoit « audite l'application » rend trente avis. Un agent qui
reçoit « le tunnel de réservation, de `/le-spa` à la confirmation, à 360 px
d'abord » rend des écarts.

Ils rendent des **constats**, pas des tickets — c'est cette commande qui
arbitre. La raison est la même que pour un run de jalon : un seul arbitre produit
un jalon lisible, deux agents qui ouvrent chacun leurs tickets produisent des
doublons et des impacts incohérents.

## Phase 4 — Le tri

Confronter chaque constat à la grille, et **écarter** sans hésiter. Un jalon de
reprise ne vaut que par ce qu'on a refusé d'y mettre.

Un constat est retenu s'il coche les cinq :

1. il se rattache à **un critère de la grille** — sinon c'est un avis ;
2. il cite une **référence** qu'un relecteur peut ouvrir — c'est la règle qui
   tient tout le dispositif (skill §2) ;
3. il porte une **recommandation** qui donne une direction ;
4. il est **visible** — les gestes et la largeur sont écrits ;
5. il porte une **capture**, deux pour un `ds:coherence`.

Puis, pour chaque écran concerné :

```bash
python scripts/design_tickets.py voisins --url "<écran>"
```

Un bug de QA déjà ouvert qui dit la même chose ferme le débat : le signaler dans
le compte rendu, ne rien ouvrir. C'est la seule garde qui empêche les deux
dispositifs de faire corriger deux fois la même chose.

Vérifier aussi les impacts : `fort` exige de pouvoir **citer la phrase** du
document contredit. Un impact gonflé fait passer une question de finition avant
un parcours cassé dans l'ordre du run.

Ce qui est écarté se dit dans le compte rendu.

## Phase 5 — Les tickets

Un appel par constat retenu. Ne **jamais** ouvrir une issue d'audit à la main :
un `gh issue create` libre perd un label, et un ticket sans `ws:*`, `mod:*` ou
`nature:*` est écarté du plan par `milestone_plan.py` **sans que rien ne le
signale**.

```bash
MSYS_NO_PATHCONV=1 python scripts/design_tickets.py open \
  --titre "…" --critere ds:parcours --module appointments \
  --workstream Frontend --impact fort --url "/le-spa/reservation" \
  --reference ".claude/skills/web-frontend/SKILL.md §3" \
  --attendu "…" --constate "…" --recommandation "…" --preuve "…" \
  --capture .claude/.recette/playwright/tunnel.png:"L'étape 3 renseignée" \
  --campagne d20260916-1
```

`MSYS_NO_PATHCONV=1` n'est pas décoratif sous Git Bash : sans lui,
`--url /le-spa/reservation` arrive au script en `C:/Program Files/Git/le-spa/…`.
Le script le rattrape, mais mieux vaut ne pas s'en remettre au rattrapage.

Avec `--dry-run`, ajouter `--dry-run` à chaque appel : les tickets s'affichent,
rien ne s'ouvre, et les URL de capture montrées sont celles qu'elles auraient.

Le script rend un JSON. Trois champs à lire :

- `doublon: true` — l'écart était déjà ouvert ; il a été commenté, pas doublé.
  **Ce n'est pas un échec** : c'est la déduplication qui fait son travail.
- `revu_de: <n>` — l'écart avait été repris et revient. Le signaler : un écart
  qui revient dit souvent que la correction précédente n'a pas été portée au bon
  endroit — un composant partagé plutôt qu'un écran.
- `project: false` — le ticket est ouvert, mais sa carte n'a pas pu être posée
  sur le board. Ce n'est pas bloquant ; le dire en fin d'audit, sans quoi ces
  écarts n'apparaîtront dans aucune vue de suivi.

Codes de sortie : `0` fait · `1` panne d'environnement (gh, git, réseau) ·
`4` appel fautif — dans ce dernier cas, c'est l'appel qu'il faut corriger, pas
l'environnement. Un `référence irrecevable` en `4` n'est pas une panne : c'est
la garde du §2 qui a fait son travail, et le constat était un avis.

## Phase 6 — Fin d'audit

```bash
python scripts/design_tickets.py report --campagne <identifiant>
```

Appeler `arreter` par MCP : les processus démarrés ne survivent pas à l'audit,
et un audit suivant réutiliserait un port occupé.

Le compte rendu final, factuel :

- le **périmètre** couvert — écrans traversés, largeurs regardées, parcours
  menés jusqu'au bout ;
- ce qui a été **ouvert**, par impact, avec le tableau de `report` ;
- ce qui a été **écarté**, et pourquoi — c'est ce qui distingue un audit d'un
  filtre silencieux ;
- ce qui relève de la **QA** et a été laissé à `/qa` ;
- ce qui n'a **pas pu être couvert** — écran absent, état inatteignable avec le
  jeu d'essai, maquette au lieu de l'application. Ne jamais conclure « audit
  terminé » sur un périmètre partiel.

Puis la suite, en une ligne : `/milestone "Design & UX"` déroule les reprises.
Ce run est de **nature projet** — les tickets ouverts ici portent
`nature:projet`, et se dérouleront en vagues comme n'importe quel ticket MVP.
