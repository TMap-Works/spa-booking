# ADR 0013 — Matrice de permissions par rôle

- **Statut** : Accepté
- **Date** : 2026-09-17
- **Décideurs** : PO (arbitrage du 16/09/2026), équipe backend
- **Contexte CDC** : §1.4 « comptes staff avec **rôles et permissions** », §2.4
  « Compte (client / staff / admin) + rôle », §3 « le front-desk gère l'agenda,
  le staff et les fiches clients », §5.1 (minimisation des données)

## Contexte

Depuis #201, l'autorisation du produit tient dans un **rang** : `CLIENT` <
`STAFF` < `MANAGER` < `ADMIN`, et `@AuthAtLeast('STAFF')` ouvre une route à ce
rôle et à tous ceux au-dessus. `apps/api/src/modules/identity/roles.ts` a
toujours dit à quelle condition ce rang restait vrai, et à quelle condition il
cesserait de l'être :

> Les quatre rôles du MVP sont strictement emboîtés : un `ADMIN` peut tout ce que
> peut un `MANAGER`, qui peut tout ce que peut un `STAFF`. Un rang numérique
> suffit donc à exprimer « au moins ce rôle ». Le jour où deux rôles cessent
> d'être comparables […] ce rang devient faux et il faut une vraie liste de
> permissions : c'est une décision d'ADR, pas un ajout de ligne.

Le retour de test du PO du 16/09/2026 (#804, ticket #812) a montré que ce jour
était arrivé. Connectée comme praticienne (`claire@spa-lumiere.test`, rôle
`STAFF`), une utilisatrice :

- arrivait sur le **planning de tout le salon**, avec les rendez-vous et les noms
  des clientes de sa collègue ;
- lisait l'écran Personnel — les quatre comptes du salon, avec leur adresse
  e-mail et leur rôle, administratrice comprise ;
- ouvrait les dix-sept fiches clientes : téléphone, e-mail et note interne ;
- pouvait créer, reporter, annuler et changer le statut de **n'importe quel**
  rendez-vous du salon ;
- accédait à l'encaissement, dont l'écran liste la journée de tout le salon.

Rien de cela n'était un défaut de câblage : chaque route portait bien la garde
que son auteur avait voulue. Le défaut est **dans la forme même du rang**. Ce
qui sépare la praticienne de la gérante n'est pas un cran de capacité mais un
**ensemble d'objets** : les deux lisent des rendez-vous, l'une les siens, l'autre
ceux du salon. Aucun entier n'ordonne cela — `agenda:read:own` et
`agenda:read:all` ne sont pas deux crans d'une même échelle.

**L'arbitrage du PO (16/09)** fixe la cible : *le praticien ne voit que son
propre planning*. Il lit ses rendez-vous et agit sur eux seulement ; il ne lit ni
le planning du salon ni celui de ses collègues ; il ne voit que les clientes de
ses rendez-vous ; il ne lit pas la liste des comptes ; il n'accède pas à
l'encaissement.

## Options envisagées

### Option A — Ajouter un rôle sous `STAFF`

Créer un rang `PRACTITIONER` inférieur à `STAFF`, et laisser `STAFF` désigner la
personne d'accueil.

Ce qui plaide pour : aucun changement de mécanique, une ligne dans l'énumération
et une migration additive.

Ce qui l'écarte : **cela ne résout rien**. Le praticien aurait alors *moins* que
la personne d'accueil sur toute la surface, y compris sur son propre agenda, qu'il
doit pouvoir lire et écrire. Il faudrait donc soit lui rendre `agenda:read`, ce
qui lui rendrait le planning du salon avec, soit poser des exceptions au rang —
c'est-à-dire écrire une matrice sans l'assumer. Le rang aurait survécu comme
forme et serait devenu faux comme sens, ce qui est la pire des deux situations :
une garde qu'on lit comme une hiérarchie et qui n'en est plus une.

### Option B — Filtrer les réponses selon le rôle, sans changer les gardes

Laisser `@AuthAtLeast('STAFF')` en place et faire filtrer chaque service :
`GET /appointments` rendrait l'agenda du salon à un manager et seulement ses
lignes à un praticien.

Ce qui plaide pour : diff minimal côté routes, et un seul écran côté front.

Ce qui l'écarte : le filtre devient un `if` sur le rôle **dans chaque service**,
c'est-à-dire autant d'écritures de la même décision qu'il y a de surfaces. C'est
exactement la trajectoire qui a produit trois corrections successives sur les
seuils du sommaire du back-office (#458, #480, #484). Surtout, le défaut d'un
filtre oublié est **silencieux** : la route répond 200, avec trop de données, et
aucun test d'accès ne rougit. Le produit a déjà tranché la question dans l'autre
sens pour l'agenda du praticien (#811) : une **route à part**, sans aucun
identifiant à comparer, plutôt qu'un filtre sur la route du salon.

### Option C — Une matrice de permissions nommées, portée par le contrat

Nommer les droits (`agenda:read:own`, `agenda:read:all`, `appointment:write:own`,
…), écrire une fois la table qui les associe aux rôles, et faire déclarer à
chaque route la permission qu'elle exige.

Ce qui plaide pour : la décision a **une seule écriture** ; la garde ne fait
qu'une appartenance à une liste, comme aujourd'hui ; le nom de la permission
porte la portée, si bien qu'aucun service n'a à redemander le rôle ; et la liste
effective d'un compte peut être **émise** au front, qui cesse alors de recopier
la table.

Ce que cela coûte : un second vocabulaire à tenir à jour à côté des rôles, et un
décorateur de plus.

## Décision

**Nous adoptons l'option C.** Une matrice de permissions nommées remplace le rang
partout où le rang a cessé d'être vrai. Le rang **survit** là où il l'est encore
— l'administration des comptes et les réglages —, et l'ADR ne le supprime pas :
il le complète.

### Le vocabulaire

Les permissions vivent dans `packages/shared/src/constants/permissions.ts`. Ce
sont des chaînes stables, qui voyagent dans les réponses de `GET /api/v1/auth/me`
et dans les conditions d'affichage du back-office : en renommer une est un
changement de contrat.

Le suffixe `:own` / `:all` fait **partie du nom**, et non d'un paramètre : une
route qui accepterait `agenda:read` puis déciderait de la portée d'après le rôle
aurait remis la matrice là où on vient de la retirer.

### La matrice

Elle vit dans `apps/api/src/modules/identity/permissions.ts` — côté serveur, et
là seulement.

| Permission | `CLIENT` | `STAFF` | `MANAGER` | `ADMIN` | La raison de la case |
|---|:-:|:-:|:-:|:-:|---|
| `agenda:read:own` | | ✓ | ✓ | ✓ | Un praticien doit voir sa journée en arrivant (#811). Un manager qui donne des soins a aussi la sienne. |
| `agenda:read:all` | | | ✓ | ✓ | **Arbitrage du PO** : le praticien ne voit que son propre planning. L'agenda du salon porte les noms des clientes de ses collègues. |
| `appointment:write:own` | | ✓ | ✓ | ✓ | Marquer honoré ou non présenté, noter, libérer un créneau : la conduite de sa propre journée, et elle n'attend pas un manager. |
| `appointment:write:all` | | | ✓ | ✓ | Poser un rendez-vous pour une cliente et un praticien qu'on désigne est un geste de comptoir, pas de fauteuil. |
| `customers:read:own` | | ✓ | ✓ | ✓ | Le praticien a besoin de la fiche de la personne qu'il va recevoir — allergie, préférence — et d'aucune autre. |
| `customers:read:all` | | | ✓ | ✓ | Le fichier entier, c'est dix-sept dossiers avec téléphone, e-mail et note interne. |
| `customers:write` | | | ✓ | ✓ | Créer, corriger, exporter : des décisions **sur** le fichier, pas des lectures dedans. |
| `accounts:read` | | | ✓ | ✓ | L'annuaire du salon expose l'adresse et le rôle de chaque compte, administratrice comprise. |
| `accounts:write` | | | | ✓ | Inviter, changer un rôle, désactiver — le rang le plus élevé, inchangé depuis #55. |
| `checkout:collect` | | | ✓ | ✓ | L'écran d'encaissement liste la journée **de tout le salon** : c'est un agenda complet par une autre porte. |
| `reporting:read` | | | ✓ | ✓ | Le chiffre d'affaires de l'établissement — inchangé, les rapports étaient déjà au seuil `MANAGER`. |
| `settings:write` | | | | ✓ | Fuseau, horaires, mentions légales du ticket — inchangé, `GET /v1/tenant` était déjà au seuil `ADMIN`. |

La ligne `CLIENT` est **vide et non absente** : la garde doit lire un tableau, et
non un `undefined` qu'un `?? []` distrait aurait pu retourner en « aucune
exigence ». Une cliente connectée lit son propre périmètre par des routes qui
n'exigent aucune permission — `GET /auth/me`, `PATCH /users/me`,
`GET /appointments/mine`.

### Les deux couches de refus, et le code qui les distingue

**La garde** (`PermissionsGuard`, posée par `@AuthWith(...)`) juge l'accès à la
**route**. Elle ne consulte aucune ressource — c'est ce qui rend son 403
rigoureusement identique pour un identifiant du tenant courant, un identifiant du
voisin et un identifiant qui n'existe nulle part. Elle rend `FORBIDDEN`, avec
`details.requiredPermissions`.

Plusieurs permissions citées sur une route se lisent « **l'une d'elles** ». C'est
ce que réclame une route à double portée : `GET /v1/customers` s'ouvre au
praticien comme au gérant, et c'est ensuite le contenu de la réponse qui diffère,
pas l'accès.

**Le service** juge la **portée** — « ce rendez-vous est-il le vôtre ? » — parce
qu'il faut lire la ressource pour le savoir. Il rend `OWN_SCOPE_ONLY`, un 403,
avec `details.scope` qui nomme la permission qui aurait permis le geste.

### Où le 403 est juste, et où il reste une fuite

La règle « une ressource d'un autre établissement rend 404, jamais 403 »
(tenant-isolation §4) n'est pas amendée. Elle protège une chose précise : qu'un
salon ne puisse pas apprendre ce que possède le salon voisin.

`OWN_SCOPE_ONLY` porte sur une ressource du **même** établissement. Le praticien
qui vise le rendez-vous de sa collègue en connaît déjà l'existence — il partage
la pièce, il voit le fauteuil occupé. Un 404 ne lui cacherait rien et lui ferait
croire à un rendez-vous effacé.

**La distinction se joue sur ce que l'appelant sait déjà**, et elle mène à deux
réponses différentes dans ce même ticket :

| Cas | Réponse | Pourquoi |
|---|---|---|
| Rendez-vous d'une collègue, même salon | **403 `OWN_SCOPE_ONLY`** | son existence est déjà connue de l'appelant |
| Rendez-vous d'un autre établissement | **404** | son existence est précisément ce qu'on protège |
| Fiche cliente hors de son périmètre, même salon | **404** | l'appelant ne sait **pas** qu'elle existe ; un 403 sur les identifiants du fichier et un 404 sur les autres ferait de la route un oracle qui énumère la clientèle du salon |

L'ordre des vérifications compte donc autant que leur contenu : **le 404 du
voisin est rendu avant le 403 de portée**, faute de quoi le second dirait au
premier que la ligne existe ailleurs.

### Ce que le front en fait

`GET /api/v1/auth/me` rend désormais les **permissions effectives** du compte, à
côté du profil. Le back-office construit son sommaire à partir de cette liste au
lieu de recopier la matrice : une seconde écriture de la même décision aurait
divergé au premier ticket — la trajectoire exacte de #458, #480 et #484.

Cette liste ne **protège** rien : un sommaire qui afficherait une entrée de trop
n'ouvre aucune donnée, la seule frontière étant la garde de l'API. Elle évite de
proposer un écran qui répondra 403.

Elle est émise sur `/auth/me` et **sur aucune des trois routes de session** : un
droit qu'on découvre en même temps que son jeton invite à le ranger avec lui,
c'est-à-dire à le conserver après qu'un administrateur l'a retiré. Elle se dérive
du rôle **relu en base**, et non de celui du jeton, pour que la rétrogradation
d'un compte se voie au prochain rendu du shell plutôt qu'à sa prochaine
connexion.

## Conséquences

**Ce que cela facilite.** La question « qui a le droit de quoi » a une réponse
unique, lisible d'un coup d'œil, et testée ligne à ligne
(`identity/__tests__/permissions.spec.ts`). Chaque route déclare ce qu'elle
exige, et une suite parcourt les routes du périmètre **rôle par rôle**
(`identity/__tests__/route-permissions.spec.ts`) : un décorateur oublié rougit
au lieu de rendre 200 à qui ne devrait rien lire. Un cinquième rôle — un
comptable qui voit le chiffre d'affaires et aucun agenda — s'exprime désormais
sans rien casser.

**Ce que cela coûte.** Deux vocabulaires à tenir plutôt qu'un : les rôles
subsistent pour l'administration des comptes, les permissions gouvernent le
reste. Un lecteur pressé peut chercher un seuil de rang là où il n'y en a plus,
d'où les en-têtes de contrôleur réécrits en même temps que les décorateurs. La
portée `:own` coûte par ailleurs **une lecture** — la fiche praticien du compte —
sur les écritures de rendez-vous faites par un praticien ; elle est évitée pour
tous les autres, la matrice répondant seule.

**Ce que cela ferme, et qui gênera.** Le rang `STAFF` ne donne plus accès à
l'encaissement, à l'annuaire des comptes, ni à la création d'une fiche cliente.
Un salon qui confierait l'accueil à un compte `STAFF` devra le passer `MANAGER` :
le produit n'a pas de rôle « réception » distinct du rôle « praticien », et en
créer un est hors du périmètre MVP. C'est une conséquence assumée de l'arbitrage
du PO, et la seule alternative aurait été de laisser la praticienne lire le salon
entier.

**Ce qui reste à faire.** `.claude/skills/tenant-isolation/SKILL.md` doit décrire
la frontière entre le 404 d'isolation et le 403 de portée telle que la table
ci-dessus la fixe. Le fichier est sous `.claude/`, refusé en écriture aux agents
non interactifs : la reprise fait l'objet d'une issue de suivi. Côté front, le
sommaire du back-office ne consomme pas encore la liste servie par `/auth/me` —
le câblage traverse `layout.tsx` et `components/navigation.ts`, hors de
l'empreinte de #812, et fait l'objet de la même issue de suivi.
