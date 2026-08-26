# syntax=docker/dockerfile:1
#
# Image d'exécution de l'API NestJS.
#
#     docker build -f apps/api/Dockerfile -t spa-api .
#
# **Le contexte est la racine du monorepo**, pas `apps/api`. C'est imposé par npm
# workspaces : `package-lock.json` est à la racine et décrit l'arbre complet.
# Construire depuis `apps/api` obligerait à réinstaller sans lockfile, donc à
# résoudre des versions différentes de celles que la CI a testées. C'est aussi la
# forme qu'emploient déjà les workflows de déploiement (`deploy-dev.yml`).
#
# Quatre étapes, dont **deux seulement finissent dans l'image** :
#
#   deps       arbre npm complet (dev incluses) + client Prisma engendré
#   build      compilation TypeScript → apps/api/dist
#   prod-deps  arbre npm de production, installé à part et jamais compilé
#   runtime    base + prod-deps + dist — ni compilateur, ni tests, ni sources
#
# `prod-deps` est installé depuis le même lockfile plutôt que dérivé de `deps`
# par `npm prune` : le pruning laisse derrière lui les répertoires que npm ne
# considère pas comme des paquets — au premier rang desquels `node_modules/.prisma`,
# ce qui donnerait une image contenant un client Prisma engendré par des
# dépendances de build absentes. Une installation neuve rend l'arbre final
# déterministe et lisible dans le lockfile.

ARG NODE_IMAGE=node:20.19-bookworm-slim

# ------------------------------------------------------------------------------
# Base commune
# ------------------------------------------------------------------------------
# `bookworm-slim` et non `alpine` : le moteur de requêtes Prisma est un binaire
# natif, et sa cible par défaut sur cette base est `debian-openssl-3.0.x`. Une
# base musl exigerait de déclarer `binaryTargets` dans `prisma/schema.prisma`,
# c'est-à-dire de faire dépendre le schéma de données du choix d'image.
#
# La version mineure de Node est épinglée : `node:20` suit la branche et pourrait
# livrer une mineure non testée entre le build de la CI et celui du déploiement.
FROM ${NODE_IMAGE} AS base

# `openssl` est une dépendance d'exécution du moteur Prisma ; `ca-certificates`
# sert aux appels sortants TLS (Stripe, SES). Les deux sont dans la base et non
# dans la seule étape de build : `runtime` en a besoin à l'exécution.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends openssl ca-certificates \
    && rm --recursive --force /var/lib/apt/lists/*

WORKDIR /app

# ------------------------------------------------------------------------------
# Étape 1 — dépendances complètes
# ------------------------------------------------------------------------------
FROM base AS deps

# `npm ci` a besoin de tous les `package.json` déclarés par `workspaces`, y
# compris ceux des workspaces qui ne servent pas à cette image : il refuse
# d'installer un arbre dont un membre manque. Ils sont copiés seuls, avant les
# sources, pour que la couche d'installation soit réutilisée tant que les
# dépendances ne bougent pas.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

# Le `postinstall` de `@spa/api` lance `prisma generate`, qui lit le schéma :
# sans lui, l'installation échoue. Le schéma est donc copié avant `npm ci` — et
# il change bien plus rarement que les sources.
COPY apps/api/prisma apps/api/prisma

# `NODE_ENV` reste indéfini ici : posé à `production`, npm omettrait les
# devDependencies, dont TypeScript et le CLI Prisma dont l'étape suivante vit.
RUN --mount=type=cache,target=/root/.npm npm ci

# ------------------------------------------------------------------------------
# Étape 2 — compilation
# ------------------------------------------------------------------------------
FROM deps AS build

# `apps/api/tsconfig.json` étend `../../tsconfig.base.json` : la configuration
# TypeScript commune vit à la racine du monorepo et fait partie des sources.
#
# `packages/shared` est copié par anticipation : l'API ne l'importe encore nulle
# part (issue #26). **Le jour où elle l'importera, cette image ne suffira plus** —
# `@spa/shared` expose `src/index.ts` en `main`, c'est-à-dire du TypeScript que
# `node` ne sait pas charger, et l'étape `runtime` ne copie que le `package.json`
# du workspace. Il faudra alors que `packages/shared` se compile et publie un
# `dist`, et que ce `dist` soit copié ici. Le sujet appartient à #26 ; ce
# commentaire est là pour qu'il ne se découvre pas en production.
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/api apps/api

# `tsconfig.build.json` exclut `test/`, `__tests__/` et `*.spec.ts` : `dist` ne
# contient que du code d'exécution.
RUN npm run build --workspace @spa/api

# ------------------------------------------------------------------------------
# Étape 3 — dépendances de production
# ------------------------------------------------------------------------------
FROM base AS prod-deps

COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

# Le schéma est copié ici aussi, et pour deux raisons : le `postinstall` de
# `@spa/api` le lit, et la tâche de migration `spa-{env}-migrate` — qui réutilise
# cette image — en a besoin à l'exécution. Il traverse donc jusqu'à `runtime`
# avec le reste de `/app`.
COPY apps/api/prisma apps/api/prisma

# **Les scripts d'installation s'exécutent ici, délibérément.** La tentation est
# de poser `--ignore-scripts` dans l'étape dont le contenu part en production ;
# c'est un piège, et il est silencieux :
#
#   * le `postinstall` de `@prisma/engines` **télécharge** les moteurs natifs —
#     ils ne sont pas dans le paquet publié, dont le champ `files` ne liste que
#     `dist`, `download` et `scripts`. Sans eux, le CLI Prisma conservé pour
#     `spa-{env}-migrate` n'a pas de schema engine et `prisma migrate deploy`
#     échoue — au déploiement, pas à la construction ;
#   * le `postinstall` de `@spa/api` appelle `prisma generate`, ce qu'il peut
#     faire ici : le CLI Prisma est présent (voir le retrait de TypeScript
#     ci-dessous) et le schéma vient d'être copié. Le client engendré l'est donc
#     par l'arbre qui l'exécutera, ce qui vaut mieux que de le reprendre d'une
#     étape aux dépendances différentes.
#
# Ce ne sont pas des scripts arbitraires en plus : ce sont ceux des paquets qui
# tournent de toute façon en production.
ENV NODE_ENV=production
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev

# `--omit=dev` ne suffit pas : `@prisma/client` déclare `typescript` et `prisma`
# en `peerOptional`, et npm installe les pairs optionnels. TypeScript revient
# donc dans l'arbre de production — 23 Mo de compilateur qu'aucune ligne de
# `dist/` n'appelle — alors même qu'il est déjà une devDependency omise.
# `npm why typescript` le montre dans l'image, si le doute revient.
#
# Il est retiré explicitement plutôt que par `--omit=peer` : ce dernier
# emporterait aussi le CLI Prisma, qui lui est **nécessaire** — la tâche de
# migration `spa-{env}-migrate` réutilise cette image pour lancer
# `prisma migrate deploy` (cf. deploy-dev.yml), avec le schéma copié plus bas.
# Cette dépendance-là est un choix, pas une fuite.
RUN rm --recursive --force \
    node_modules/typescript \
    node_modules/.bin/tsc \
    node_modules/.bin/tsserver

# ------------------------------------------------------------------------------
# Étape 4 — image d'exécution
# ------------------------------------------------------------------------------
FROM base AS runtime

ENV NODE_ENV=production

# Le port d'écoute par défaut de l'API (`PORT`, cf. src/config/env.schema.ts).
# `EXPOSE` est documentaire : c'est la définition de tâche ECS qui publie le port.
ENV PORT=3001
EXPOSE 3001

# L'image `node` fournit un utilisateur non privilégié `node` (uid 1000). Les
# fichiers lui appartiennent, mais le répertoire de travail reste la propriété de
# root : l'application n'a aucune raison d'écrire dans son propre arbre, et le
# lui interdire transforme une écriture inattendue en erreur visible plutôt qu'en
# modification silencieuse du conteneur.
# `prod-deps` porte déjà tout ce qui n'est pas compilé : l'arbre npm de
# production, les moteurs Prisma téléchargés par le `postinstall`, le client
# engendré dans `apps/api/node_modules/.prisma`, et le schéma que la tâche
# `spa-{env}-migrate` relit à chaque migration. Une seule copie suffit.
COPY --from=prod-deps --chown=node:node /app/ /app/

# Ne reste que le produit de la compilation.
COPY --from=build --chown=node:node /app/apps/api/dist /app/apps/api/dist

USER node

# `node` directement, sans `npm start` : npm resterait comme processus parent, et
# c'est lui qui recevrait le SIGTERM d'ECS au lieu de l'application. Node en PID 1
# reçoit le signal, ferme ses connexions et rend la main sans attendre le délai de
# grâce.
CMD ["node", "apps/api/dist/main.js"]
