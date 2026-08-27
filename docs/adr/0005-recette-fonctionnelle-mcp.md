# ADR 0005 — Recette fonctionnelle d'un ticket par serveurs MCP

- **Statut** : Accepté
- **Date** : 2026-08-27
- **Décideurs** : équipe TMap-Works (#288)
- **Contexte CDC** : §3.1 Méthodologie (définition de « terminé »), §3.2 workstream
  QA, §4.12 CI/CD

## Contexte

La définition de « terminé » du CDC §3.1 exige un code « revu, testé (unitaire +
intégration), déployé en environnement de recette ». Les deux premiers termes ont
une barrière automatique — `npm run verify` en phase 4 de `/ticket`, la CI en
phase 8. Le troisième n'en avait aucune : rien, dans le parcours d'un ticket, ne
**se sert** de ce qui vient d'être écrit.

L'écart n'est pas théorique. Trois pannes traversent nos barrières actuelles sans
en faire rougir une seule :

- un contrôleur absent des `controllers` de son module compile, passe ses tests
  unitaires, et rend 404 en vrai ;
- un DTO validé contre un double en mémoire — c'est le cas de toutes nos suites
  d'intégration, qui substituent les dépôts — casse dès que le vrai client Prisma
  reçoit le champ ;
- un formulaire dont le bouton n'est câblé à rien rend une page parfaitement
  valide.

Deux contraintes encadrent la réponse. Le MVP tient en quatre semaines et
`/milestone` fait tourner jusqu'à trois agents en parallèle : une recette qui
rejouerait le système entier à chaque ticket coûterait plus que les tickets
eux-mêmes. Et les vagues tournent en `claude -p`, sans humain pour répondre à
une demande de permission ni à une invite interactive : ce qui n'est pas
déclaratif et automatique n'existe pas dans une vague.

## Options envisagées

### Option A — Élargir les tests d'intégration

Écrire, pour chaque ticket, une suite Jest supplémentaire qui démarre
l'application contre une vraie base plutôt que contre des doubles.

C'est la solution la plus proche de l'existant, et elle a un défaut décisif :
elle demande à l'agent d'écrire du code de test durable pour prouver un point
transitoire. Le coût de maintenance s'accumule à chaque ticket, et le résultat
répond à la question « est-ce que ça régresse » — pas à « est-ce que ça marche
maintenant ». Elle ne dit toujours rien du front.

### Option B — Un script de recette lancé en Bash

Un `scripts/recette.py` qui démarre l'API, enchaîne des appels décrits dans un
fichier et rend un verdict.

Simple, mais il faut alors **décrire** les appels avant de les faire. Or ce qu'il
y a à vérifier dépend de ce que le ticket a écrit : l'agent est le seul à le
savoir, et au moment de la recette il l'a sous les yeux. Un script figé
retomberait dans l'option A, en moins outillé. Et un script ne pilote pas un
navigateur.

### Option C — Deux serveurs MCP, et une phase qui les emploie

Un serveur `recette` qui sait démarrer l'API, poser un jeu d'essai et envoyer des
requêtes ; le serveur `playwright` officiel pour le navigateur ; et une phase de
`/ticket` qui dit à l'agent quoi prouver, sur quel périmètre, et quand ne rien
faire.

L'agent compose les appels au moment où il connaît le code. Rien n'est écrit sur
le disque, rien n'est à maintenir. Le coût est un dispositif de plus à faire
vivre, et une dépendance à un navigateur headless.

## Décision

**Option C.** Le dispositif est décrit dans
[.claude/skills/recette-mcp/SKILL.md](../../.claude/skills/recette-mcp/SKILL.md)
et déclaré dans [.mcp.json](../../.mcp.json). Quatre choix le caractérisent.

**Le périmètre est calculé, pas jugé.** L'outil `perimetre` déduit du diff les
routes et les pages touchées ; l'agent n'a pas à décider quoi recetter, et ne
peut pas déborder. C'est ce qui rend la phase compatible avec trois agents
parallèles et un jalon d'une semaine.

**La phase se saute d'elle-même** quand le diff ne porte ni API ni UI —
outillage, infrastructure, documentation, contrats partagés, migration seule.
Le saut est journalisé avec sa raison, ce qui le rend vérifiable.

**Le verdict est bloquant**, au même titre que `npm run verify` : un endpoint qui
ne répond pas arrête le ticket avant la PR. Une recette informative aurait été
une ligne de plus à ne pas lire.

**Rien ne passe par `npx`.** Les deux serveurs se lancent par `node` ou `python`,
et `@playwright/mcp` est une devDependency à version fixée. Sous Windows, `npm`
et `npx` sont des `.CMD` qu'un `spawn` sans shell ne trouve pas — vérifié sur la
machine de développement du projet — et les vagues tournent sans shell. Une
version flottante (`@latest`) changerait par ailleurs le navigateur au milieu
d'un jalon.

## Conséquences

**Ce que cela facilite.** Un ticket dont la PR porte le tableau de recette dit
autre chose qu'un ticket vert : le code a été exercé. Les trois pannes citées
plus haut deviennent visibles avant le merge, là où elles coûtent quelques
minutes plutôt qu'un aller-retour de recette. Et la surface web se prouve dès
maintenant, sur les maquettes statiques, avant même que Next existe.

**Ce que cela coûte.** Chaque ticket produit augmente de quelques minutes.
Postgres et Redis doivent tourner — ce qui était déjà vrai pour
`test:integration`. Un navigateur Playwright doit être installé une fois par
machine. Le serveur MCP est du code de plus à maintenir : 700 lignes de Python,
couvertes par `scripts/tests/test_recette_server.py`.

**Ce que cela ferme.** La recette écrit dans la base de développement locale.
Elle est cloisonnée par numéro de ticket, mais ce n'est pas un environnement
propre : personne ne doit s'appuyer sur l'état de cette base. Et `perimetre` lit
des décorateurs, pas un arbre TypeScript — une route construite dynamiquement lui
échappera, `api_openapi` restant alors le seul juge de ce qui est servi.

**Ce qui reste à la charge de l'opérateur.** Le réglage
`enableAllProjectMcpServers` doit être posé dans `.claude/settings.json` pour que
les vagues `claude -p` chargent les serveurs sans invite de confiance. Tant qu'il
ne l'est pas, la recette n'existe que dans les sessions interactives ayant
approuvé le `.mcp.json`, et les tickets d'une vague journaliseront la phase comme
sautée faute d'outils — ce qui est visible, mais silencieux.
