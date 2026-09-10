---
description: Mène une campagne de QA sur l'application — traverse le produit, le confronte aux grilles frontend et backend, et ouvre chaque anomalie dans le jalon « Bug & correction »
argument-hint: [parcours ou module] [--front] [--back] [--dry-run]
allowed-tools: Bash, Read, Glob, Grep, Agent, Skill, mcp__recette__api_demarrer, mcp__recette__api_jeu_dessai, mcp__recette__web_demarrer, mcp__recette__arreter
---

Mène une campagne de QA sur **$ARGUMENTS** — un parcours (`réservation`,
`back-office`, `comptoir`, `notifications`) ou un module. Sans argument,
proposer un périmètre plutôt que de le demander : le parcours critique
« réserver → confirmer → encaisser » d'abord, puis ce que le dernier jalon
mergé a touché.

Doctrine et grilles de critères :
[.claude/skills/qa/SKILL.md](../skills/qa/SKILL.md). **La charger avant tout.**

**Options** — `--front` : volet frontend seul · `--back` : volet backend seul ·
`--dry-run` : mener la campagne et montrer les tickets **sans les ouvrir**.

## Ce que cette commande ne fait pas

- **Elle ne corrige rien.** Elle ouvre des tickets. Les corriger, c'est
  `/milestone "Bug & correction"`, et c'est un run séparé — on ne corrige pas
  pendant qu'on mesure.
- **Elle ne remplace pas la recette de `/ticket`.** La recette prouve que le
  code d'un ticket répond ; la campagne dit ce que vaut le produit. Une campagne
  ne dispense d'aucune phase 4bis.
- **Elle ne juge pas le périmètre MVP.** Une fonctionnalité manquante n'est pas
  un bug — en cas de doute, charger l'agent `mvp-scope-guard`.

## Phase 1 — Le périmètre, écrit avant de commencer

Un périmètre non écrit est un périmètre qui dérive : une campagne « complète »
finit par traverser le produit entier et n'ouvre rien d'exploitable.

Énoncer, en trois lignes : les **pages** à traverser, les **routes** à sonder,
et ce qui est **hors campagne**. S'appuyer sur ce qui existe réellement —
`apps/web/app/` pour les pages, `api_openapi` pour les routes — et non sur ce
que le CDC prévoit.

Fixer l'identifiant de campagne, qui servira à tous les tickets :

```bash
python scripts/qa_bugs.py list --state open        # ce que les campagnes précédentes ont laissé
```

Une anomalie déjà ouverte n'a pas à être rouverte : le script la reconnaîtra à
son empreinte, mais la connaître d'avance évite d'y consacrer du temps.

## Phase 2 — Le terrain

```bash
docker compose up -d
```

Puis, par MCP, **avec `racine`** — une campagne ne porte pas sur un ticket, elle
porte sur le dépôt principal, et ces outils refusent de deviner quand des
worktrees de ticket sont ouverts :

1. `api_demarrer` — `{"racine": "<chemin du dépôt>"}`
2. `api_jeu_dessai` — le même ; il pose l'établissement, les quatre rôles et le
   **voisin**, sans lequel aucun critère `be:securite` ne s'exerce
3. `web_demarrer` — rend l'URL de base à donner au navigateur

Relire la `racine` rendue une fois : c'est le contrôle le moins cher du
dispositif, et celui qui évite de mesurer le mauvais dépôt (#304).

Si `web_demarrer` sert `apps/web/mockups/` faute de script `dev`, la campagne
porte sur les maquettes : **le dire**, et le redire dans le compte rendu. Un
constat de maquette n'a pas la même valeur qu'un constat d'application.

## Phase 3 — La traversée, à deux agents en parallèle

Lancer `qa-frontend` et `qa-backend` **dans le même message**, pour qu'ils
tournent de front : ils n'ont ni les mêmes outils, ni les mêmes seuils, et rien
ne les fait dépendre l'un de l'autre. `--front` ou `--back` n'en lance qu'un.

Donner à chacun, sans le laisser deviner : le périmètre exact de la phase 1,
l'URL de base rendue par `web_demarrer` ou le port de `api_demarrer`, les
identifiants du jeu d'essai, et la consigne de capture.

Ils rendent des **constats**, pas des tickets — c'est cette commande qui
arbitre. La raison est la même que pour un run de jalon : un seul arbitre
produit un jalon lisible, deux agents qui ouvrent chacun leurs tickets
produisent des doublons et des gravités incohérentes.

## Phase 4 — Le tri

Confronter chaque constat à la grille, et **écarter** sans hésiter. Un jalon de
correction ne vaut que par ce qu'on a refusé d'y mettre.

Un constat est retenu s'il coche les quatre :

1. il se rattache à **un critère de la grille** — sinon c'est une opinion ;
2. il nomme le **seuil franchi**, pas une impression ;
3. il est **reproductible** — les gestes sont écrits ;
4. il porte une **capture**, ou la raison motivée de son absence.

Vérifier aussi les gravités : une fuite inter-tenant est **toujours**
`bloquant`. Une gravité gonflée fait passer un ticket cosmétique avant une fuite
de données dans l'ordre du run.

Ce qui est écarté se dit dans le compte rendu — c'est ce qui distingue une
campagne d'un filtre silencieux.

## Phase 5 — Les tickets

Un appel par constat retenu. Ne **jamais** ouvrir une issue de QA à la main :
un `gh issue create` libre perd un label, et un ticket sans `ws:*`, `mod:*` ou
`nature:*` est écarté du plan par `milestone_plan.py` **sans que rien ne le
signale**.

```bash
python scripts/qa_bugs.py open \
  --titre "…" --critere fe:responsive --module appointments \
  --workstream Frontend --gravite majeur --url "/reserver/creneaux" \
  --attendu "…" --constate "…" --preuve "…" --mesure "…" --reproduire "…" \
  --capture .claude/.recette/playwright/creneaux-360.png:"La colonne du samedi coupée" \
  --campagne <identifiant>
```

Avec `--dry-run`, ajouter `--dry-run` à chaque appel : les tickets s'affichent,
rien ne s'ouvre, et les URL de capture montrées sont celles qu'elles auraient.

Le script rend un JSON. Trois champs à lire :

- `doublon: true` — le défaut était déjà ouvert ; il a été commenté, pas doublé.
  **Ce n'est pas un échec** : c'est la déduplication qui fait son travail.
- `regression_de: <n>` — le défaut avait été corrigé et revient. Le signaler
  dans le compte rendu : une régression dit quelque chose qu'un bug neuf ne dit
  pas.
- `project: false` — le ticket est bien ouvert, mais sa carte n'a pas pu être
  posée sur le board. Ce n'est pas bloquant ; le dire en fin de campagne, sans
  quoi ces anomalies n'apparaîtront dans aucune vue de suivi.

Codes de sortie : `0` fait · `1` panne d'environnement (gh, git, réseau) ·
`4` appel fautif — dans ce dernier cas, c'est l'appel qu'il faut corriger, pas
l'environnement.

## Phase 6 — Fin de campagne

```bash
python scripts/qa_bugs.py report --campagne <identifiant>
```

Appeler `arreter` par MCP : les processus démarrés ne survivent pas à la
campagne, et une campagne suivante réutiliserait un port occupé.

Le compte rendu final, factuel :

- le **périmètre** couvert — pages traversées, largeurs testées, routes sondées,
  nombre d'appels ;
- ce qui a été **ouvert**, par gravité, avec le tableau de `report` ;
- ce qui a été **écarté**, et pourquoi ;
- ce qui n'a **pas pu être couvert** — page absente, dépendance éteinte,
  maquette au lieu de l'application. Ne jamais conclure « campagne terminée »
  sur un périmètre partiel : c'est la seule façon de savoir ce que la campagne
  ne dit pas.

Puis la suite, en une ligne : `/milestone "Bug & correction"` déroule les
corrections. Ce run est de **nature projet** — les tickets ouverts ici portent
`nature:projet`, et se dérouleront en vagues comme n'importe quel ticket MVP.
