---
name: recette-mcp
description: Recette fonctionnelle d'un ticket par MCP — exercer réellement les endpoints créés côté API et les pages, formulaires et boutons créés côté web, en se bornant au périmètre du ticket. À charger avant la phase 4bis de /ticket, ou dès qu'une tâche parle de recette, de sonder un endpoint, de piloter le navigateur ou de prouver qu'une page fonctionne.
---

# Recette fonctionnelle par MCP

## 1. Ce que la recette prouve, et ce qu'elle ne prouve pas

`npm run verify` répond à « est-ce que ça compile et est-ce que les tests
passent ». La recette répond à une autre question, que rien d'autre ne pose :
**est-ce que ça marche quand on s'en sert**.

L'écart entre les deux n'est pas théorique :

| Ce qui passe la CI | Ce que la recette attrape |
|---|---|
| un contrôleur absent des `controllers` de son module | 404 sur une route pourtant déclarée |
| un DTO validé par des tests contre un double en mémoire | 500 dès que le vrai Prisma reçoit le champ |
| une garde posée sur la classe et non sur la méthode | une route ouverte qu'on croyait gardée |
| un formulaire dont le bouton n'est câblé à rien | rien ne se passe au clic |
| un `useEffect` qui plante à l'hydratation | une erreur de console sur une page qui « rend » |

Ce qu'elle ne prouve pas, et qu'il ne faut pas lui demander : la couverture des
cas limites (c'est le rôle des tests unitaires), la tenue sous concurrence (c'est
`npm run test:concurrency`), la non-régression du reste du système (c'est la CI).

## 2. La règle qui borne tout le reste

**On ne recette que ce que le ticket a implémenté.**

`perimetre` déduit cette liste du diff — pas du jugement de l'agent, pas du titre
de l'issue. Trois raisons pour lesquelles cette borne n'est pas négociable :

- une vague de `/milestone` fait tourner trois agents en parallèle ; trois
  recettes complètes du système consommeraient plus que les tickets eux-mêmes ;
- ce qui n'a pas changé était déjà vert au dernier merge — le rejouer ne dit rien
  de neuf ;
- une recette qui déborde finit par échouer sur du code qui n'appartient pas au
  ticket, et c'est alors le ticket qui est bloqué pour la dette d'un autre.

## 3. Les serveurs

Déclarés dans [.mcp.json](../../../.mcp.json), lancés par `node` ou `python` —
jamais par `npx` : sous Windows, `npm` et `npx` sont des `.CMD` qu'un `spawn`
sans shell ne trouve pas, et les vagues tournent sans shell.

| Serveur | Ce qu'il pilote |
|---|---|
| `recette` | l'API locale — périmètre, démarrage, jeu d'essai, appels HTTP |
| `playwright` | un navigateur headless — navigation, instantanés, clics, formulaires |

### Le dépôt sur lequel la recette porte se dit, il ne se devine pas

**Toujours passer `ticket` — à `perimetre`, `api_demarrer`, `api_jeu_dessai` et
`web_demarrer`.** Ce n'est pas une politesse : c'est la seule chose qui dit au
serveur dans quel dépôt regarder.

Un serveur stdio est lancé depuis la racine de la session qui l'ouvre. Une vague
de `/milestone` ouvre la sienne depuis le **dépôt principal**, puis son agent
entre dans un worktree — et le serveur, déjà démarré, ne peut pas suivre. Sans
le numéro de ticket, il lisait donc le diff du dépôt principal : périmètre sans
rapport quand celui-ci était sale, et surtout faux `saut: true` quand il était
propre. Une phase réputée bloquante qui n'exerçait rien, en silence (#304).

Depuis, ces outils **refusent** de répondre quand rien ne les renseigne et que
des worktrees de ticket sont ouverts. Un refus n'est pas un échec de recette :
c'est un appel à refaire avec `ticket`.

```jsonc
{"ticket": "304"}                       // le worktree dont la branche porte 304
{"racine": "D:/chemin/vers/le/depot"}   // un dépôt sans branche de ticket
```

Le premier outil qui tranche fixe la racine pour tous les suivants — deux outils
sur deux dépôts différents rendraient ensemble un verdict qui ne veut rien dire.
`perimetre` et `rapport` rendent `racine` : **la relire une fois**, c'est le
contrôle le moins cher qu'il y ait sur tout le dispositif.

**Prérequis, une fois par machine** :

1. `docker compose up -d` — Postgres et Redis ;
2. `npm run db:migrate:deploy` — la base de développement doit porter le schéma,
   sinon le jeu d'essai n'a aucune table où écrire ;
3. un navigateur Playwright (`npx playwright install chromium` dans un terminal —
   déjà présent sur la machine de développement du projet).

**Le dépôt publie son PostgreSQL sur 5433**, et non sur le 5432 standard : un
service natif peut tenir ce dernier en même temps que le proxy Docker, sans que
rien ne le signale (#272). Si l'authentification est refusée alors que le
conteneur est sain, c'est de ce côté qu'il faut regarder — vérifier d'abord que
`DATABASE_URL` vise bien 5433, puis `netstat -ano | grep :5433` — et non du côté
du volume.

Pointer la recette ailleurs reste possible sans toucher à un fichier versionné :
un `DATABASE_URL` dans `.env.local`, ou dans l'environnement du processus, qui
l'emporte sur les fichiers `.env`.

Ces fichiers-là sont gitignorés : un worktree fraîchement créé ne les porte
jamais. Les valeurs sont donc lues dans le **dépôt principal d'abord**, puis
dans le dépôt du ticket, qui l'emporte s'il en a. Sans quoi une recette menée
dans un worktree démarrerait sans `DATABASE_URL`.

## 4. Les outils de `recette`, dans l'ordre où ils servent

### `perimetre`

Le premier appel de la phase, avant tout démarrage, et **avec le numéro de
ticket** — `{"ticket": "42"}`. Rend :

```json
{
  "racine": "…/.claude/worktrees/agent-a2d9…",
  "api": {"routes": [
    {"methode": "POST", "chemin": "/api/v1/services", "auth": ["MANAGER", "ADMIN"],
     "statut_attendu": 201, "fichier": "…/services.controller.ts", "ligne": 93}
  ]},
  "web": {"cibles": [{"url": "/salon/[slug]", "nature": "page"}]},
  "saut": false,
  "raison": "1 route(s) et 1 cible(s) web à recetter"
}
```

Ce qu'il sait faire, et qui évite de le refaire à la main :

- il lit le dépôt du **ticket** — le worktree dont la branche porte ce numéro —
  et non celui d'où le serveur a été lancé ;
- il lit les commits de la branche **et** l'arbre de travail — la recette a lieu
  avant les commits propres de la phase 6 ;
- il traverse commentaires et chaînes : `public-services.controller.ts` **cite**
  « Aucun `@Auth()` » dans sa documentation, et une lecture naïve y verrait une
  garde ;
- un service ou un dépôt modifié n'a pas d'URL : il remonte aux contrôleurs du
  module qui le **citent**, pas à tous ;
- `auth: null` désigne une route ouverte ; une liste de rôles désigne le seuil.

### `api_demarrer`

Lève l'API sur un port libre. Ce qu'il fait sans qu'on le demande, et pourquoi :

- il **recompile** si `apps/api/dist` est plus vieux que `apps/api/src` —
  recetter du code déjà remplacé rendrait un verdict sur rien ;
- il refuse de démarrer si Postgres ou Redis ne répond pas, avec le remède ;
- il **réutilise** l'instance déjà levée plutôt que d'en empiler une seconde ;
- il alloue un port libre, ce qui laisse trois agents d'une vague cohabiter.

### `api_jeu_dessai`

`{"ticket": "42"}` → un établissement `recette-42`, ses comptes
`admin@ / manager@ / staff@ / client@recette.test`, et un établissement voisin
`recette-42-voisin`. Idempotent.

Le voisin n'est pas un ornement : c'est lui qui rend la sonde d'isolation
possible. La même route, appelée avec son jeton, doit rendre **404** — jamais
403, jamais la donnée du premier (tenant-isolation §4).

### `api_openapi`

Les routes que Nest a **réellement enregistrées**. Comparer la liste de
`perimetre` à celle-ci est le contrôle le moins cher du dispositif, et celui qui
attrape la panne la plus courante.

### `api_appel`

```jsonc
// connexion, et le jeton reste dans le serveur
{"methode": "POST", "chemin": "/api/v1/auth/login",
 "corps": {"tenantSlug": "recette-42", "email": "admin@recette.test", "password": "…"},
 "enregistrer_jeton": "admin", "attendu": 200}

// puis les appels, par alias
{"methode": "POST", "chemin": "/api/v1/services", "jeton": "admin",
 "corps": {"…": "…"}, "attendu": 201}
```

`attendu` pose le verdict repris par `rapport`. Les jetons, mots de passe et
valeurs de `.env` sont masqués dans toute sortie : un jeton recopié dans un
transcript y reste, puis finit dans un journal de run et sur une PR.

### `arreter` et `rapport`

`arreter` en fin de phase, systématiquement. `rapport` rend le tableau markdown
qui se journalise et se republie sur la PR.

## 5. Le scénario type d'une route

Cinq appels, pas quinze. L'exemple porte sur `POST /api/v1/services`,
`auth: ["MANAGER", "ADMIN"]` :

| # | Appel | Attendu | Ce que ça prouve |
|---|---|---|---|
| 1 | `api_openapi` filtre `services` | le chemin est listé | le contrôleur est enregistré |
| 2 | `POST` avec le jeton `manager` | 201 + corps conforme au DTO | le cas passant |
| 3 | `POST` avec un corps invalide | 400 `{code, message, details}` | la validation, et la forme d'erreur |
| 4 | `POST` avec le jeton `voisin` puis `GET` de la ressource | 404 | la frontière du tenant |
| 5 | `POST` sans jeton, puis avec `client` | 401, puis 403 | la garde et le seuil de rôle |

Sur une route de lecture, le 4 devient : créer la donnée chez le principal, la
lire avec le jeton du voisin, obtenir 404.

## 6. Le scénario type d'une page

Playwright travaille sur un **instantané d'accessibilité**, pas sur des
sélecteurs CSS : `browser_snapshot` rend l'arbre, chaque élément avec sa
référence, et les outils d'interaction prennent cette référence.

1. `browser_navigate` sur l'URL rendue par `web_demarrer` ;
2. `browser_snapshot` — les éléments annoncés par le ticket sont là ;
3. `browser_console_messages` — aucune erreur. Le `404` de `favicon.ico` sur un
   serveur statique n'en est pas une : c'est le seul bruit connu ;
4. `browser_fill_form` sur le cas passant, puis soumission : l'effet attendu a lieu ;
5. un champ invalide : le message apparaît **sur le champ** (web-frontend §4) ;
6. chaque bouton touché : il fait ce qu'il annonce, et un bouton de soumission se
   désactive au premier clic (web-frontend §3) ;
7. `browser_take_screenshot` de ce qui mérite d'être vu sur la PR — **sans
   `filename`** : le nom passé est résolu depuis le répertoire courant, et la
   capture atterrit à la racine du dépôt. Sans lui, elle va dans
   `.claude/.recette/playwright/`, qui est ignoré par git.

Tant qu'`apps/web` n'a pas de script `dev`, `web_demarrer` sert les maquettes
statiques de `apps/web/mockups/` — elles se recettent exactement de la même
façon, et c'est ce qui rend le dispositif utile avant même que Next existe.

## 7. Ce qui n'est pas un échec de recette

| Symptôme | Cause | Remède |
|---|---|---|
| `PostgreSQL injoignable` | dépendances éteintes | `docker compose up -d` |
| `Client Prisma indisponible` | schéma généré en retard | `npm run db:generate` |
| l'API ne répond pas sur `/health` | lire `journal` rendu par l'outil : la cause y est | selon le journal |
| Playwright ne trouve pas de navigateur | binaire jamais installé | `npx playwright install chromium` |
| les outils MCP n'existent pas dans la session | serveurs non chargés | redémarrer la session ; vérifier `/mcp` |

Appliquer le remède, relancer, poursuivre. Ces cas se journalisent en
`--level DEBUG`, **sans** `--status` — ce n'est pas le ticket qui échoue.

Un vrai échec de recette, lui, est bloquant : `--status blocked`, l'appel exact
et ce qu'il a rendu dans le message, aucune PR ouverte.

## 8. Les limites connues du dispositif

À savoir avant de s'y fier plus qu'il ne le mérite :

- `perimetre` lit les décorateurs Nest, pas un arbre TypeScript. Une route
  construite dynamiquement, ou un chemin composé par une constante, lui échappe —
  `api_openapi` reste alors le juge de ce qui est servi.
- Les segments dynamiques sortent **tels quels** : `/api/v1/services/:id` côté
  API, `/salon/[slug]` côté web. Ils ne se naviguent pas ainsi — y substituer
  l'identifiant ou le slug rendu par `api_jeu_dessai` (ou par l'appel de création
  qui précède) avant tout `api_appel` ou `browser_navigate`.
- La base de recette est la base de développement locale. Le jeu d'essai est
  cloisonné par ticket, mais rien n'empêche une recette d'y laisser des lignes :
  c'est une base jetable, pas un environnement propre.
- Playwright rend un instantané d'accessibilité : ce qui n'est pas exposé à
  l'arbre d'accessibilité — un canvas, une animation pure — ne s'y voit pas.
- La recette ne juge rien à la place de l'agent : elle rend des statuts et des
  corps. C'est la lecture qui fait le verdict.
