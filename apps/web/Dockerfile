# syntax=docker/dockerfile:1
#
# Image d'exécution du front Next.js.
#
#     docker build -f apps/web/Dockerfile -t spa-web .
#
# **Le contexte est la racine du monorepo**, pas `apps/web` — même raison que pour
# l'API : `package-lock.json` est à la racine et décrit l'arbre complet, et c'est
# la forme qu'emploie `deploy-dev.yml`.
#
# Quatre étapes, dont **une seule finit dans l'image** :
#
#   deps     arbre npm complet (dev incluses)
#   build    `next build` → apps/web/.next
#   runtime  la sortie `standalone` de Next, et rien d'autre
#
# ------------------------------------------------------------------------------
# Prérequis côté application — `apps/web/next.config.*`
# ------------------------------------------------------------------------------
# Cette image dépend de deux réglages de `next.config`, sans lesquels l'étape
# `runtime` ne trouve rien à copier :
#
#     output: 'standalone'
#     outputFileTracingRoot: path.join(import.meta.dirname, '../../')
#
# `standalone` fait produire à Next un serveur autonome accompagné des **seules**
# dépendances que sa trace de modules atteint — c'est ce qui donne une image sans
# dépendance de build, sans avoir à deviner ce qui est utile à l'exécution.
# `outputFileTracingRoot` désigne la racine du monorepo : sans lui, Next trace
# depuis `apps/web` et laisse derrière tout ce que npm a hissé dans le
# `node_modules` racine — l'image démarre alors sur un `MODULE_NOT_FOUND`.
#
# **`apps/web` n'est pas encore initialisé** à la date de cette image : le
# workspace ne porte qu'un `package.json` sans script, et `npm run build
# --workspace @spa/web` échoue donc sur « Missing script: build ». Ce Dockerfile
# décrit la cible, et le job `docker` de `ci.yml` ne construit l'image que
# lorsqu'un `next.config.*` est présent — la construction s'active d'elle-même le
# jour où le front est posé, sans qu'il faille y repenser.
#
# `deploy-dev.yml`, lui, ne pose aucune condition : il construit les deux images
# dans la même étape. **Le premier déploiement de dev échouera donc tant que
# `apps/web` n'est pas initialisé**, et il échouera avant le `docker push` de
# l'API. Ce n'est pas rattrapable ici — sans image web, le
# `ecs update-service spa-dev-web` qui suit échouerait de toute façon. C'est
# l'issue #16 (« Déployer l'environnement dev de bout en bout ») qui doit poser
# le squelette Next.js avant d'armer les variables de dépôt AWS.

ARG NODE_IMAGE=node:20.19-bookworm-slim

# ------------------------------------------------------------------------------
# Base commune
# ------------------------------------------------------------------------------
# Même base que l'image API, et pour une raison qui vaut aussi ici : la version
# mineure est épinglée pour que le build de la CI et celui du déploiement portent
# le même Node. `bookworm-slim` plutôt qu'`alpine` évite par ailleurs les
# surprises de compilation native de `sharp`, l'optimiseur d'images de Next.
FROM ${NODE_IMAGE} AS base

# `ca-certificates` sert aux appels sortants TLS des Server Components vers l'API.
RUN apt-get update \
    && apt-get install --yes --no-install-recommends ca-certificates \
    && rm --recursive --force /var/lib/apt/lists/*

WORKDIR /app

# ------------------------------------------------------------------------------
# Étape 1 — dépendances complètes
# ------------------------------------------------------------------------------
FROM base AS deps

# `npm ci` refuse d'installer un arbre dont un membre déclaré par `workspaces`
# manque : tous les `package.json` sont copiés, y compris ceux qui ne servent pas
# à cette image. Seuls, et avant les sources, pour que la couche d'installation
# soit réutilisée tant que les dépendances ne bougent pas.
COPY package.json package-lock.json ./
COPY apps/api/package.json apps/api/
COPY apps/web/package.json apps/web/
COPY packages/shared/package.json packages/shared/

# Le schéma Prisma appartient à l'API et n'a rien à faire dans un build de front
# — il est pourtant nécessaire ici : `npm ci` installe **tout** l'arbre du
# monorepo, donc exécute le `postinstall` de `@spa/api`, qui lance
# `prisma generate` et lit ce schéma. Sans lui, l'installation échoue.
#
# Le copier coûte quelques kilo-octets dans une étape qui ne part pas en
# production ; l'alternative — `npm ci --ignore-scripts` — ferait taire du même
# geste tous les scripts d'installation à venir des dépendances du front, y
# compris ceux dont il aurait besoin, et le silence ne se remarquerait qu'en
# production.
COPY apps/api/prisma apps/api/prisma

# `NODE_ENV` reste indéfini : posé à `production`, npm omettrait les
# devDependencies, dont Next lui-même et TypeScript.
RUN --mount=type=cache,target=/root/.npm npm ci

# ------------------------------------------------------------------------------
# Étape 2 — compilation
# ------------------------------------------------------------------------------
FROM deps AS build

# `apps/web/tsconfig.json` étend `../../tsconfig.base.json`, et le front consomme
# les contrats d'API de `packages/shared` : les deux font partie des sources.
COPY tsconfig.base.json ./
COPY packages/shared packages/shared
COPY apps/web apps/web

# Les variables `NEXT_PUBLIC_*` sont figées **dans le bundle** au moment du build,
# pas lues au démarrage : une valeur passée à l'exécution n'a plus aucun effet sur
# le JavaScript servi au navigateur, et une valeur passée ici y finit en clair.
#
# Aucune n'est déclarée pour l'instant, et ce n'est pas un oubli : `apps/web` n'a
# pas encore de configuration, donc pas encore de variable publique à figer. Le
# jour où il en faudra une, elle se déclare **ici** — un `ARG NEXT_PUBLIC_…` suivi
# du `ENV` correspondant avant le `RUN`, et le `--build-arg` associé dans
# `deploy-*.yml`. Un `--build-arg` sans `ARG` correspondant est ignoré sans bruit
# par Docker : la valeur n'atteindrait pas le bundle et le front partirait en
# production avec un `undefined`.
#
# Rien de sensible ne passe par là : ce qui est secret n'est pas `NEXT_PUBLIC_*`,
# et se lit côté serveur à l'exécution.
ENV NEXT_TELEMETRY_DISABLED=1
RUN npm run build --workspace @spa/web

# `public/` est copié tel quel par l'étape suivante, or Next ne l'exige pas et un
# `COPY` d'un répertoire absent fait échouer la construction. Le créer ici rend
# l'image indépendante de ce choix côté application.
RUN mkdir --parents apps/web/public

# ------------------------------------------------------------------------------
# Étape 3 — image d'exécution
# ------------------------------------------------------------------------------
FROM base AS runtime

ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

# `HOSTNAME` à `0.0.0.0` et non au défaut `localhost` : le serveur autonome de
# Next n'écouterait sinon que sur la boucle locale du conteneur, et le health
# check de l'ALB n'atteindrait jamais la tâche.
ENV PORT=3000
ENV HOSTNAME=0.0.0.0
EXPOSE 3000

# L'image `node` fournit un utilisateur non privilégié `node` (uid 1000). Les
# fichiers lui appartiennent, mais `/app` reste la propriété de root : le front ne
# doit rien écrire dans son propre arbre, et le lui interdire transforme une
# écriture inattendue en erreur visible plutôt qu'en dérive silencieuse.
#
# Trois copies, et trois seulement — c'est la découpe que produit `standalone` :
#   1. le serveur et les dépendances tracées,
#   2. les actifs de `.next/static`, que la trace ne couvre pas,
#   3. `public/`, servi tel quel.
COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/apps/web/.next/static ./apps/web/.next/static
COPY --from=build --chown=node:node /app/apps/web/public ./apps/web/public

USER node

# `node` directement, sans `npm start` : npm resterait processus parent et
# recevrait le SIGTERM d'ECS à la place du serveur. Node en PID 1 le reçoit,
# ferme ses connexions et rend la main sans attendre le délai de grâce.
#
# Le chemin porte `apps/web/` parce que `outputFileTracingRoot` est la racine du
# monorepo : la sortie `standalone` en reproduit l'arborescence.
CMD ["node", "apps/web/server.js"]
