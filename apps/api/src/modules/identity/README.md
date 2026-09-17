# Module `identity`

Comptes, sessions, rôles et **permissions** (CDC §1.4, §2.4). C'est le module qui
décide qui entre, au nom de quel établissement, et ce qu'il a le droit de faire —
les trois questions dont dépendent toutes les autres surfaces du produit.

Ce document décrit le **modèle d'autorisation**. Le reste du module — émission et
rotation des jetons, invitation du personnel, réglages d'établissement, console
plateforme — est documenté dans les en-têtes des fichiers concernés.

## Les trois questions, et les trois mécaniques qui y répondent

| Question | Ce qui y répond | Ce qu'il lit |
|---|---|---|
| Qui êtes-vous ? | `JwtAuthGuard` | l'en-tête `Authorization: Bearer`, et rien d'autre |
| De quel établissement ? | la revendication `tenantId` du **même jeton vérifié** | jamais un en-tête, un paramètre ou un corps (tenant-isolation §2) |
| Avez-vous le droit ? | `RolesGuard` puis `PermissionsGuard` | la revendication `role`, confrontée à la matrice |

Aucune des trois ne consulte de ressource. C'est ce qui rend leurs refus
indiscernables les uns des autres : un 403 de garde est identique pour un
identifiant du tenant courant, un identifiant du voisin et un identifiant qui
n'existe nulle part — la garde n'a pas l'information qui les distinguerait.

## Rôles **et** permissions — les deux vocabulaires, et lequel gouverne quoi

Le module porte deux listes, et elles ne disent pas la même chose.

**Les rôles** (`roles.ts`) sont ce que la colonne `users.role` stocke et ce que
les jetons transportent : `CLIENT`, `STAFF`, `MANAGER`, `ADMIN`, dans l'ordre de
déclaration de l'énumération PostgreSQL. Ils forment une hiérarchie, et
`hasAtLeastRole` la rend comparable.

**Les permissions** (`permissions.ts`, vocabulaire dans
`packages/shared/src/constants/permissions.ts`) sont ce qu'un compte a le droit
de faire. Elles ne sont pas ordonnées.

Jusqu'à #812, le premier vocabulaire suffisait : les quatre rôles étaient
strictement emboîtés, et `@AuthAtLeast('STAFF')` exprimait tout ce qu'il y avait
à exprimer. Le retour de test du PO du 16/09/2026 a montré que ce n'était plus
vrai — une praticienne connectée lisait le planning du salon, l'annuaire des
comptes et les dix-sept fiches clientes, parce que le rang `STAFF` ouvrait tout
cela d'un bloc. Ce qui sépare la praticienne de la gérante n'est pas un cran de
capacité mais un **ensemble d'objets** : `agenda:read:own` et `agenda:read:all`
ne sont pas deux crans d'une même échelle.

La décision, ses options écartées et la table complète avec la raison de chaque
case : [ADR 0013](../../../../../docs/adr/0013-matrice-de-permissions-par-role.md).

### Le rang n'a pas disparu, et ce n'est pas une inconséquence

Il gouverne encore ce pour quoi il reste vrai : l'**administration des comptes**
(`PATCH /users/:id`, `PATCH /users/:id/role`, `PATCH /users/:id/status`,
`POST /users`) et l'**anonymisation** d'une fiche cliente. Ces gestes-là sont
bien emboîtés — un `ADMIN` peut tout ce que peut un `MANAGER` —, et les
réexprimer en permissions n'aurait rien ajouté qu'une indirection.

La règle de choix est simple : **une permission quand la portée est en jeu, un
rang quand seul le niveau l'est.**

### La matrice, en une ligne par rôle

| Rôle | Ce qu'il porte |
|---|---|
| `CLIENT` | rien — son propre périmètre passe par des routes qui n'exigent aucune permission (`GET /auth/me`, `PATCH /users/me`, `GET /appointments/mine`) |
| `STAFF` | `agenda:read:own`, `appointment:write:own`, `customers:read:own` |
| `MANAGER` | les trois ci-dessus, plus `agenda:read:all`, `appointment:write:all`, `customers:read:all`, `customers:write`, `accounts:read`, `checkout:collect`, `reporting:read` |
| `ADMIN` | tout le vocabulaire — il n'y a rien au-dessus |

La ligne `CLIENT` est **vide et non absente** : la garde doit lire un tableau, et
non un `undefined` qu'un `?? []` distrait aurait pu retourner en « aucune
exigence ».

## Déclarer l'accès d'une route

```ts
@Auth()                                          // toute identité vérifiée
@Auth('ADMIN')                                   // ces rôles exactement
@AuthAtLeast('MANAGER')                          // ce rôle et tous ceux au-dessus
@AuthWith('agenda:read:all')                     // cette permission
@AuthWith('customers:read:own', 'customers:read:all')  // l'une **ou** l'autre
```

Les quatre sont des composites : ils posent l'annotation **et** les gardes qui la
font respecter, dans l'ordre qui compte. `@RequirePermissions('…')` posé seul
serait un commentaire — la route resterait ouverte, et rien ne le signalerait.

Plusieurs permissions citées se lisent « **l'une d'elles** », jamais « toutes ».
C'est ce que réclame une route à double portée : le fichier client s'ouvre au
praticien comme au gérant, et c'est ensuite le **contenu** de la réponse qui
diffère, pas l'accès.

## Les deux refus, et comment choisir

La garde juge la **route**. Le service juge la **portée** — « ce rendez-vous
est-il le vôtre ? » —, parce qu'il faut lire la ressource pour le savoir.

| Situation | Réponse | Levée par |
|---|---|---|
| Rôle sans la permission exigée | **403 `FORBIDDEN`**, `details.requiredPermissions` | `PermissionsGuard` |
| Ressource d'un **autre** établissement | **404** | le service, sur le `null` du client Prisma scopé |
| Ressource du **même** établissement, hors du périmètre de l'appelant | **403 `OWN_SCOPE_ONLY`**, `details.scope` | le service (`OwnScopeOnlyError`) |

Le troisième cas est le seul endroit du produit où un refus d'accès s'assume en
403, et il ne contredit pas tenant-isolation §4. La règle du 404 protège
l'existence d'une ressource d'un **autre** salon ; ici, l'appelant connaît déjà
celle de la ressource — il travaille dans la pièce d'à côté, il voit le fauteuil
occupé. Un 404 ne lui cacherait rien et lui ferait croire à un rendez-vous
effacé.

**L'ordre compte autant que le contenu** : le 404 du voisin est rendu **avant**
le 403 de portée. L'inverse dirait à un salon que la ligne d'un autre existe.

Et lorsque l'appelant ne sait **pas** que la ressource existe — une fiche cliente
qui n'est pas la sienne —, c'est le 404 qui s'applique, pour la raison
symétrique : un 403 sur les identifiants du fichier et un 404 sur les autres
ferait de la route un oracle qui énumère la clientèle du salon.

## Ce que `GET /api/v1/auth/me` rend, et pourquoi lui seul

Le profil du compte **et ses permissions effectives**
(`authenticatedAccountSchema` du contrat partagé). Le back-office construit son
sommaire à partir de cette liste au lieu de recopier la matrice : une seconde
écriture de la même décision aurait divergé au premier ticket — c'est ce qui a
produit trois corrections successives sur les seuils du sommaire (#458, #480,
#484).

La liste ne **protège** rien. Un sommaire qui afficherait une entrée de trop
n'ouvre aucune donnée : la seule frontière est la garde de l'API, qu'aucun front
ne peut contourner. Elle évite de proposer un écran qui répondra 403.

Deux précisions qui expliquent la forme retenue :

- elle n'est émise **sur aucune des trois routes de session** (connexion,
  inscription, rafraîchissement). Un droit qu'on découvre en même temps que son
  jeton invite à le ranger avec lui, c'est-à-dire à le conserver après qu'un
  administrateur l'a retiré ;
- elle se dérive du rôle **relu en base**, et non de celui du jeton. Un jeton
  d'accès vit quinze minutes : une rétrogradation se voit ainsi au prochain rendu
  du shell plutôt qu'à la prochaine connexion.

## Ce qui tient le modèle en place

| Suite | Ce qu'elle protège |
|---|---|
| `__tests__/permissions.spec.ts` | la matrice dit ce que l'ADR 0013 a tranché — la table y est **réécrite à la main**, pas importée |
| `__tests__/route-permissions.spec.ts` | chaque route du périmètre exige la permission attendue, **rôle par rôle**, gardes réelles et jeton signé |
| `__tests__/roles.guard.spec.ts` | le défaut fermé de la couche : sans métadonnée, une identité vérifiée reste exigée |
| `appointments/__tests__/appointments.own-scope.spec.ts` | le praticien agit sur les siens, reçoit `OWN_SCOPE_ONLY` sur ceux d'une collègue, et 404 sur ceux du voisin |
| `crm/__tests__/customers.service.spec.ts` | le fichier client rendu au praticien se borne à sa propre clientèle |

## Reste à faire

- `.claude/skills/tenant-isolation/SKILL.md` doit décrire la frontière entre le
  404 d'isolation et le 403 de portée. Le fichier est sous `.claude/`, refusé en
  écriture aux agents non interactifs : la reprise fait l'objet d'une issue de
  suivi rattachée au jalon S4.
- Le sommaire du back-office ne consomme pas encore la liste servie par
  `/auth/me` : le câblage traverse `apps/web/app/(admin)/[tenantSlug]/admin/layout.tsx`
  et `components/navigation.ts`, et suit la même issue.
- Les deux casses de rôle — `CLIENT` côté colonne et jeton, `client` côté contrat
  — cohabitent toujours (`receivedUserRoleSchema`). Les unifier invaliderait tous
  les jetons en circulation : c'est une décision de contrat doublée d'une
  migration, et elle reste ouverte depuis #510.
