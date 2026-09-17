# ADR 0012 — L'opérateur plateforme est une identité hors établissement, dans son propre espace d'authentification

- **Statut** : Accepté
- **Date** : 2026-09-17
- **Décideurs** : PO (arbitrage du 16/09/2026, tracé dans #804), équipe TMap-Works (#806)
- **Contexte CDC** : §1.2 proposition de valeur, §1.4 périmètre figé, §2.1
  isolation multi-tenant, §2.3 module Identité & accès, §2.4 le Tenant comme
  entité racine

## Contexte

Le produit est un SaaS vendu à des salons. Pour vendre, l'éditeur doit pouvoir
**ouvrir un établissement** pour chaque nouveau client, puis remettre au gérant
son accès et le lien de réservation de ses clientes.

Or rien, dans le code livré jusqu'ici, ne crée d'établissement. Une recherche de
`tenant.create` ou de `createTenant` dans `apps/api/src` ne rend rien : les
établissements de `spa_dev` viennent tous du seed et des jeux d'essai de
recette. `POST /v1/users` invite un compte **dans un établissement qui existe
déjà** ; rien ne crée le premier administrateur d'un établissement neuf. Le
produit sait tout faire d'un salon, sauf en ouvrir un.

Le PO a tranché le 16/09/2026 : **pas d'inscription en libre-service**. Un salon
s'ouvre depuis une console réservée à l'éditeur. Cette décision-là n'est pas
l'objet de cet ADR — elle est un arbitrage produit, consigné dans #806. Ce que
cet ADR doit trancher est ce qu'elle implique du modèle de données et de
l'authentification :

- **qui** est l'éditeur, pour le système d'identité ;
- **comment** il s'authentifie, sachant que chaque identité connue du produit
  porte aujourd'hui un `tenantId` signé dans son jeton ;
- et surtout : comment une table d'opérateur peut exister **sans `tenant_id`**
  alors que CLAUDE.md pose « toute table métier porte `tenant_id` » en contrainte
  non négociable n° 2.

La dernière question est celle qui rend l'ADR obligatoire plutôt que souhaitable.
`tenant-isolation` §1 n'admet d'exception à la colonne discriminante que
« à documenter en ADR si on en ajoute », et `tenant-scope.extension.ts` refuse à
l'exécution tout modèle qui n'est ni scopé ni déclaré légitime. L'exception ne
peut donc pas se glisser ; elle doit être écrite.

## Options envisagées

### Option A — L'éditeur est un rôle de plus, dans un établissement « plateforme »

On crée un établissement technique — `slug = 'plateforme'` —, on y pose un compte
de rôle `PLATFORM_ADMIN`, et la console est une route de plus gardée par
`@Auth('PLATFORM_ADMIN')`. Rien ne change au schéma : pas de table neuve, pas
d'exception à la colonne `tenant_id`, pas de second espace d'authentification.

C'est l'option qui coûte le moins à écrire, et c'est celle qui coûte le plus
cher à tenir. Trois raisons, dans l'ordre de gravité :

1. **La hiérarchie de rôles cesse d'être emboîtée.** `USER_ROLES` est une
   échelle — `CLIENT` < `STAFF` < `MANAGER` < `ADMIN` — et `hasAtLeastRole`
   suppose l'emboîtement partout. Un cinquième rang au-dessus d'`ADMIN` rendrait
   l'opérateur mécaniquement capable de tout ce qu'un `ADMIN` peut faire —
   y compris dans **son** établissement technique, ce qui n'a aucun sens — et
   ferait de `@AuthAtLeast('MANAGER')` une porte ouverte à l'éditeur sur des
   routes écrites pour le comptoir. Le jour où l'on voudrait un opérateur qui
   ouvre des salons **sans** pouvoir lire l'agenda d'un salon, le rang serait
   faux et il faudrait la matrice de permissions que `roles.ts` renvoie
   explicitement à un ADR.
2. **Le jeton porterait un `tenantId` qui ne désigne rien.** `JwtAuthGuard` pose
   la revendication dans le contexte de requête, ce qui **arme** le scoping
   Prisma pour toute la suite. Un opérateur authentifié arriverait donc dans les
   contrôleurs avec la portée de l'établissement technique : ses lectures y
   seraient filtrées sur un salon vide, et la seule façon d'ouvrir un vrai salon
   serait de contourner la portée depuis une route authentifiée — c'est-à-dire
   d'installer une échappatoire au scoping **derrière** un jeton d'établissement.
   C'est exactement la classe de défaut que l'extension existe pour rendre
   impossible.
3. **Une compromission de salon deviendrait une compromission de plateforme.**
   Les deux identités partageraient la table `users`, la même unicité
   `(tenant_id, email)`, la même route `/auth/login`, le même secret de
   signature et la même chaîne de rafraîchissement. Un défaut sur la connexion
   d'un salon — un oracle d'énumération, une fuite de jeton, une élévation de
   rôle — porterait d'un coup sur la console qui ouvre tous les salons.

### Option B — Une table dédiée, sans `tenant_id`, et un espace d'authentification distinct

L'opérateur est une identité **d'une autre nature** : `platform_operators`, hors
de `users`, sans `tenant_id`, avec sa propre route de connexion, son propre type
de jeton signé par une clé propre, et une MFA exigée.

Le coût est réel et il est de trois ordres : une exception à la règle de la
colonne discriminante, un second chemin d'authentification à maintenir, et des
tables que le client Prisma **scopé** ne sait pas lire — donc des dérogations
nommées au scoping.

Ce que l'option achète en échange est la propriété qui compte : les deux espaces
ne se rencontrent nulle part. Aucun jeton d'établissement, quel que soit son
rôle, ne peut ouvrir un salon ; aucun jeton plateforme ne peut lire l'agenda
d'un salon. La frontière n'est pas gardée par une comparaison quelque part — elle
est cryptographique, et une comparaison oubliée ne peut pas l'ouvrir.

### Option C — Aucune identité : une commande d'exploitation, et rien d'autre

Ouvrir un salon est une opération rare. On peut la réserver à une commande jouée
depuis une tâche d'exploitation, sans route HTTP ni console.

C'est ce que le produit fait déjà, involontairement, par son seed — et c'est
précisément ce que #806 constate comme un manque. Une commande n'est ni traçable
(« qui, quand, quel établissement » ne se journalise pas dans un terminal), ni
idempotente, ni utilisable par une équipe commerciale. Elle reste néanmoins
**nécessaire** pour un cas : créer le **premier** opérateur, faute d'une identité
préexistante pour l'autoriser. L'option est donc écartée comme modèle général et
retenue comme amorce.

## Décision

**Option B, avec l'amorce de l'option C.**

### 1. Une identité hors établissement

`platform_operators` est une table **sans `tenant_id`**, et c'est la seule
exception que ce schéma porte avec `tenants`. Elle est accompagnée de
`platform_tenant_provisionings`, qui journalise les ouvertures de salon et porte
la clé d'idempotence ; cette seconde table est exemptée pour la même raison, et
son champ d'établissement se nomme `createdTenantId` — **jamais** `tenantId` —
pour que l'extension de scoping ne la prenne pas pour une table de salon.

Les deux modèles sont déclarés dans `PLATFORM_MODELS`
(`tenant-scope.extension.ts`), qui les rend **refusés** par le client scopé :
elles ne sont atteignables que par `prismaUnscoped`, sous les trois obligations
habituelles (nom, commentaire, filtre explicite). Elles ne sont donc pas
« globalement légitimes » au sens de `GLOBAL_MODELS` — un modèle global serait
lisible depuis n'importe quel repository métier ; celles-ci ne le sont que depuis
le sous-module `identity/platform`.

### 2. Pourquoi cela ne contredit pas « toute table métier porte `tenant_id` »

La règle protège une propriété précise : **aucune donnée d'un établissement ne
doit pouvoir être lue depuis un autre**. `tenant_id` est le moyen, la propriété
est la fin. Une table qui ne contient **aucune donnée d'établissement** n'a rien
à discriminer : lui ajouter la colonne ne protégerait rien et ferait exactement
le contraire de ce qu'elle promet, en rattachant l'identité de l'éditeur à l'un
des salons qu'il administre.

Le critère est donc : *cette ligne appartient-elle à un établissement ?*

| Table | À qui appartient une ligne | `tenant_id` |
|---|---|---|
| `users`, `appointments`, `payments`, … | à un salon | oui, non nullable |
| `tenants` | **est** le salon | non — racine |
| `platform_operators` | à l'éditeur | non — hors établissement |
| `platform_tenant_provisionings` | à l'éditeur (l'acte d'ouvrir) | non — hors établissement |

C'est la même lecture qui exempte déjà `tenants` : la racine ne porte pas la
colonne parce qu'elle *est* ce que la colonne désigne. `platform_operators` ne la
porte pas parce qu'elle est **au-dessus** de ce que la colonne désigne.

Trois garde-fous rendent l'exception vérifiable plutôt que déclarative :

- `prisma-schema.spec.ts` énumère les tables plateforme dans une liste nommée :
  une table ajoutée sans `tenant_id` et sans y figurer fait rougir la suite ;
- `tenant-scope.extension.ts` les **refuse** au client scopé, comme toute table
  qu'il ne sait pas filtrer ;
- aucune de ces deux tables ne porte de donnée de client final — ni nom, ni
  adresse, ni rendez-vous. Une fuite de portée sur elles n'exposerait pas les
  données personnelles que l'isolation protège (CDC §5.1).

### 3. Une authentification distincte, avec MFA exigée

- **Route distincte** : `POST /v1/platform/auth/login`, sous le préfixe
  `/v1/platform/*` que l'espace d'établissement n'emprunte jamais.
- **Jeton distinct** : type `platform`, **sans revendication `tenantId`**, signé
  par une clé **dérivée** du secret de rafraîchissement
  (`HMAC-SHA256(secret, 'spa-booking/platform-access-v1')`) — la conduite déjà
  retenue pour les invitations (`token.service.ts`). Deux étiquettes distinctes
  donnent deux clés indépendantes, sans variable d'environnement de plus.
- **Étanchéité par construction** : un jeton d'établissement présenté à
  `/v1/platform/*` échoue à la vérification cryptographique — clé différente,
  `typ` différent — et rend **401** ; un jeton plateforme présenté à une route
  d'établissement échoue de la même façon. Le refus ne dépend d'aucune
  comparaison applicative.
- **MFA exigée** : la connexion réclame un code TOTP (RFC 6238, SHA-1, six
  chiffres, pas de trente secondes, tolérance d'un pas) en plus du mot de passe.
  Elle est **obligatoire et non optionnelle** : le secret est posé à la création
  de l'opérateur, et il n'existe aucun chemin de connexion qui s'en passe. Un
  mot de passe seul, sur une console qui ouvre tous les salons, est un facteur de
  trop peu.
- **Pas de session longue** : aucun jeton de rafraîchissement, aucun cookie. La
  console se reconnecte, MFA comprise, à l'expiration du jeton d'accès. Une
  chaîne de rafraîchissement aurait rendu la MFA franchissable une fois pour
  toutes.

### 4. Le premier opérateur se crée par une commande

`npm run platform:operator -- --email … --first-name … --last-name …` crée un
opérateur et **affiche une seule fois** son mot de passe initial et l'URI
`otpauth://` à scanner. Aucune route publique ne crée d'opérateur : une console
qui ouvre tous les salons ne s'inscrit pas en libre-service, pas plus que les
salons eux-mêmes.

## Conséquences

**Ce que cela facilite.** L'éditeur ouvre un salon sans que personne n'ait à
toucher la base. L'acte est tracé — qui, quand, quel établissement — et
rejouable sans risque grâce à `Idempotency-Key`. Le périmètre du MVP reste tenu :
le multi-établissement **côté client** (un gérant qui pilote plusieurs salons)
reste hors périmètre (CDC §1.4) ; ici, c'est l'éditeur qui ouvre un
établissement par client.

**Ce que cela coûte.** Quatre choses, et aucune n'est cosmétique :

- **Deux tables hors de la règle.** La liste des exceptions passe de une à
  trois. Chaque ajout suivant devra se justifier ici, et la tentation sera réelle
  de ranger sous « plateforme » ce qui est en fait une donnée de salon. Le
  critère du tableau ci-dessus est ce qui doit trancher, pas la commodité.
- **Un second chemin d'authentification.** Deux routes de connexion, deux formes
  de jeton, deux gardes. Un durcissement apporté à l'une ne profite pas
  automatiquement à l'autre — la limitation de débit, notamment, est à poser des
  deux côtés.
- **Le secret TOTP est stocké en clair.** Il l'est comme le serait n'importe
  quel secret partagé nécessaire à la vérification : contrairement à un mot de
  passe, un secret TOTP ne peut pas être haché, la vérification exigeant de le
  recalculer. Une fuite de la table donne donc le second facteur — pas le
  premier, qui reste sous bcrypt. Le chiffrement au repos de cette colonne, par
  une clé de Secrets Manager, est la suite naturelle et n'est pas au périmètre
  de #806.
- **Les dérogations au scoping s'allongent.** `grep -rn PRISMA_UNSCOPED
  apps/api/src` compte désormais le dépôt de la console. `tenant-isolation` §3
  demande que cette liste reste « courte et relisible » : elle l'est, et chaque
  entrée porte son commentaire.

**Ce que cela ferme.** L'idée qu'un rôle supplémentaire puisse suffire. Tant que
l'identité de l'éditeur vivra dans `users`, elle portera un `tenantId` qui ne
désigne rien, et toute route de console devra contourner la portée depuis un
jeton d'établissement. Cet ADR referme cette voie : l'opérateur n'a pas de
`tenantId`, donc il n'a rien à contourner.
