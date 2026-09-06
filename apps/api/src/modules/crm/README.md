# Module `crm`

Fiches clientes, coordonnées, notes internes, historique de visites (CDC §2.3).
C'est le module que le front-desk ouvre le plus souvent — et le seul dont la
totalité du contenu est une **donnée personnelle**. Tout ce qui suit découle de
ce fait.

## Ce qui est livré

| Ticket | Ce qu'il pose |
|---|---|
| #56 | Le CRUD des fiches, la note interne, la recherche indexée et l'historique agrégé |
| #313 | `ClientDirectoryService`, la porte par laquelle `appointments` obtient la fiche d'une cliente qui réserve sans compte |
| #465 | `assertBookableWithin`, le second battant de cette porte : confirmer qu'une fiche **désignée** par le comptoir est bien du fichier client |

Hors périmètre MVP, et donc non livré : fusion de doublons, segmentation,
export RGPD, campagnes. Le CDC §1.4 borne le module à un « CRM client de
base » ; chacun de ces besoins est une décision de produit à part entière.

## Les routes

| Méthode | Chemin | Rang |
|---|---|---|
| `GET` | `/api/v1/customers` | `STAFF` |
| `GET` | `/api/v1/customers/:id` | `STAFF` |
| `GET` | `/api/v1/customers/:id/history` | `STAFF` |
| `POST` | `/api/v1/customers` | `STAFF` |
| `PATCH` | `/api/v1/customers/:id` | `STAFF` |
| `PATCH` | `/api/v1/customers/:id/status` | `MANAGER` |

**Aucune route publique, aucune route ouverte au rôle `CLIENT`.** C'est la
propriété la plus importante du module : une surface anonyme, même en lecture,
même bornée, serait un annuaire de la clientèle d'un salon offert à qui connaît
son slug. Une cliente lit et corrige son propre profil par `GET /auth/me` et
`PATCH /users/me` — des routes sans identifiant en chemin, donc sans rien à
comparer.

`STAFF` fait tout ce qui relève de la relation client au quotidien : chercher,
créer au téléphone, corriger un numéro, noter une allergie. `MANAGER` garde la
seule opération qui **retire** quelque chose des écrans — la désactivation. Même
partage que chez `identity` entre `PATCH /users/:id` et `PATCH /users/:id/status`.

Pas de `DELETE` : `appointments.client_id` référence `users` en `Restrict`, si
bien qu'une fiche ayant honoré une seule visite ne se supprime pas, et le
reporting doit continuer à la compter. Un verbe qui n'efface rien mentirait au
client autant qu'au relecteur.

## Une fiche cliente **est** une ligne `users`

Le schéma initial en a décidé, et `users.password_hash` est nullable précisément
pour cela — « un client peut exister sans compte, saisi au comptoir par le
staff ». Une table `customers` parallèle aurait dédoublé le nom, l'adresse et le
téléphone, cassé la clé étrangère sur laquelle repose l'historique, et laissé
ouverte la question « laquelle des deux fait foi ? ».

Deux modules lisent donc la même table, et **chacun s'interdit ce que l'autre
sert** :

| | `identity` | `crm` |
|---|---|---|
| Ce qu'il lit | `role IN (STAFF, MANAGER, ADMIN)` | `role = CLIENT` |
| Ce qu'il rend | comptes, rôles, invitations | fiches, notes, historique |
| Ce qu'il ne voit pas | les fiches clientes (`findStaffAccountById`) | les comptes internes (`findById`) |

Le refus est symétrique et sans `if` : il est dans le `where`, et le `null`
devient un 404. `GET /users/:id` sur une cliente répond 404 ; `GET /customers/:id`
sur une praticienne aussi.

## La note interne, et ce qui la tient à l'écart

« Notes internes distinctes des informations visibles du client » est un critère
d'acceptation. Il tient par quatre choses, et non par une convention de nommage :

1. **la colonne** `users.internal_note`, écrite et lue par ce seul module ;
2. **les projections du dépôt** — `CUSTOMER_SUMMARY_SELECT` ne la lit pas. Une
   liste de deux cents fiches ne fait donc transiter aucune note, même pas
   jusqu'à la mémoire du processus ;
3. **les DTO** — `CustomerSummaryDto` ne la porte pas ; `CustomerDto`, servi au
   rang `STAFF`, si ;
4. **l'absence de toute surface publique** — aucun schéma du parcours client ne
   la référence, et il n'y a aucune route par laquelle elle pourrait sortir.

## Aucune donnée personnelle dans les logs

Cinquième critère de #56, et il tient par une règle plus simple qu'une
politique : **ce module ne journalise rien**. Pas de logger injecté, pas de
`console`, aucun nom ni adresse ni numéro dans le message ou les `details` d'une
erreur de domaine — `CustomerEmailTakenError` ne porte même pas l'adresse en
cause, contrairement au `slug` des conflits du catalogue.

`__tests__/crm.logging.spec.ts` relit les sources du module pour l'interdire, et
vérifie en second rideau que `common/logging/redaction.ts` masquerait de toute
façon `firstName`, `lastName`, `email`, `phone` et `internalNote` par nom de
champ. La ceinture est le point 1 ; la rédaction est les bretelles.

## La recherche et ses index

Un seul terme, trois axes — c'est ce que fait un front-desk qui a un nom au
téléphone, un numéro sur un SMS ou une adresse sur une confirmation :

| Axe | Prédicat | Index |
|---|---|---|
| nom, prénom | préfixe, insensible à la casse | `(tenant_id, role, last_name, first_name)` |
| e-mail | préfixe sur l'adresse canonisée | `(tenant_id, email)` — l'unique du schéma initial |
| téléphone | préfixe | `(tenant_id, phone)` |

L'e-mail est comparé **sans** `mode: 'insensitive'` : `normalizeEmail` canonise à
l'écriture, la colonne ne contient que des minuscules, et la comparaison est donc
à la fois exacte et utilisable par l'index. Les noms, stockés tels que saisis,
exigent l'insensibilité — ce qui interdit à PostgreSQL d'utiliser le B-tree pour
le préfixe. Ce qui reste, et qui est l'essentiel : l'index borne les lignes
candidates à **un établissement et à sa seule clientèle** avant que le prédicat
de nom ne filtre à l'intérieur.

La recherche est par **préfixe** et non « contient » : aucun B-tree ne sert un
`%dur%`, et le promettre aurait été promettre un balayage complet. Le passage à
`pg_trgm` est une décision à prendre sur volumétrie réelle, pas d'avance.

Le terme fait au moins deux caractères : une lettre unique ramènerait la
quasi-totalité du fichier à chaque frappe.

## L'historique agrégé

`summary` compte, borne et somme sur la **totalité** des rendez-vous de la
fiche ; `visits` n'en montre que les cinquante plus récents au plus. Un agrégat
calculé sur la fenêtre serait faux dès que la fiche la dépasse, et il le serait
en silence — le pire mode de défaillance pour un chiffre affiché à un
commerçant.

Trois décisions méritent d'être connues avant de lire les chiffres :

- **`totalSpent` ne compte que les visites `COMPLETED`.** Ni les annulations, ni
  les absences, ni ce qui n'a pas encore eu lieu : un chiffre d'affaires qui
  compterait les rendez-vous à venir se démentirait à chaque annulation ;
- **`totalSpent` vaut `null`, jamais `0`,** quand aucune visite n'a été honorée.
  Un zéro laisserait croire à une cliente venue sans rien payer ;
- **`totalSpent` vaut `null` aussi quand la fiche porte plusieurs devises.**
  Chaque rendez-vous fige la sienne à la réservation, et un établissement qui
  change de devise laisse derrière lui des lignes dans l'ancienne. Additionner
  des entiers dont les codes diffèrent produirait un nombre plausible et faux ;
  choisir « la devise dominante » serait pire. La ventilation par devise dans la
  réponse est une évolution de contrat, donc une issue.

`GET /customers/:id/history` relit la fiche avant d'agréger, et le 404 qui en
découle n'est pas une politesse : sans lui, l'historique d'un identifiant
inconnu — ou d'une fiche du salon voisin — rendrait un agrégat vide en **200**,
indiscernable de celui d'une cliente jamais venue.

## Ce que le module lit, et ce qu'il n'importe pas

`CrmRepository` lit `users` et `appointments`. Il n'importe **aucun repository
voisin** : ce qu'api-module §3 interdit est un `../../identity/identity.repository`,
et il n'y en a pas. Les deux lectures sont argumentées en tête du fichier —
la première parce que la fiche *est* la ligne `users`, la seconde parce que
l'historique est une projection en lecture seule qui ne décide d'aucune règle de
cycle de vie. Le module **n'écrit jamais** dans `appointments`.

`CrmModule` n'importe qu'`IdentityModule`, et seulement pour ses gardes. Il
n'exporte que `ClientDirectoryService` — voir ci-dessous.

## La porte de la réservation sans compte (#313)

`appointments.client_id` est `NOT NULL` : poser un rendez-vous d'invité suppose
une ligne `users`. Jusqu'à #313, `AppointmentsRepository` l'écrivait lui-même,
faute de porte — la table d'un autre domaine écrite par un module qui ne la
possède pas. `CrmModule` exporte désormais `ClientDirectoryService`, et lui seul.

Ce qu'elle laisse passer est étroit à dessein : **un identifiant de fiche, jamais
une fiche**. Pas de nom, pas d'adresse, pas de note interne, aucune lecture du
fichier client. Un module qui voudrait *afficher* une cliente n'a toujours aucun
chemin pour cela.

### Elle prend une transaction, et c'est une entorse assumée

`resolveWithin(scope, contact)` reçoit la portée transactionnelle de l'appelant,
là où api-module §2 veut qu'un service ignore Prisma. C'est le prix d'un critère
qui ne se satisfait pas autrement : **un 409 de créneau ne doit laisser aucune
fiche derrière lui**. Résoudre la cliente dans une transaction et poser le
rendez-vous dans une autre laisse, à chaque course perdue, une fiche publique
sans rendez-vous au fichier du salon.

L'entorse est bornée : la portée est opaque pour le service — il la transmet, ne
l'ouvre ni ne la referme —, le SQL reste dans `CrmRepository`, et le client reçu
est le **scopé**, si bien que l'extension de tenant continue de s'appliquer mot
pour mot.

### Deux décisions produit, et ce qu'elles coûtent

**Une adresse portée par un compte `STAFF`/`MANAGER`/`ADMIN` est refusée**
(`CLIENT_EMAIL_NOT_BOOKABLE`, 409). La résolution lit sur la seule adresse — sans
filtre de rôle — puis **juge** ce qu'elle trouve : c'est ce qui transforme la
collision `@@unique([tenantId, email])` en un refus choisi, là où un filtre
`role: 'CLIENT'` dans le `where` aurait mené à une création refusée en `P2002`
nu, donc à un 500.

| | Ce que la route rend |
|---|---|
| adresse inconnue | 201, fiche créée |
| adresse déjà cliente | 201, fiche réutilisée telle quelle |
| adresse d'un compte du personnel | 409 `CLIENT_EMAIL_NOT_BOOKABLE` |

Ce que ce refus laisse deviner : qu'une adresse porte un compte **non client**
dans cet établissement. C'est le coût assumé, et il est borné — les deux premières
lignes du tableau sont indiscernables, si bien que la route ne dit rien du fichier
client. Il est par ailleurs le même refus que le comptoir reçoit déjà :
`POST /customers` sur cette adresse rend `CUSTOMER_EMAIL_TAKEN`, l'unicité ne
distinguant pas les rôles. Le parcours public ne peut pas réussir en silence là où
le back-office, authentifié, est refusé.

Sa contrepartie : un membre du personnel client de son propre salon ne réserve pas
en ligne avec son adresse professionnelle. Il en utilise une autre, ou le comptoir
réserve pour lui (#50). L'alternative — réutiliser son compte — aurait accroché un
rendez-vous à une fiche que le fichier client ne montre jamais (`role = CLIENT`),
donc un rendez-vous dont le comptoir ne peut pas ouvrir la cliente.

**Une fiche désactivée est réutilisée telle quelle.** `is_active` gouverne les
écrans du back-office — la recherche l'exclut par défaut —, pas l'identité de qui
réserve. L'écarter n'aurait laissé que deux issues : créer une seconde fiche, ce
que l'unicité interdit, ou refuser — c'est-à-dire faire de cette route publique un
oracle sur le fichier client, la donnée même que ce module protège.

### Le rôle est jugé sous verrou de ligne (#468)

La lecture qui porte ce refus est un `SELECT … FOR SHARE`, dans la transaction de
l'appelant — la même conduite que le second battant, pour la même raison. Elle
était nue jusqu'à #468, et le refus n'était donc **pas atomique** par rapport à
l'insertion qu'il garde : sous `READ COMMITTED`, chaque instruction prend son
propre instantané, si bien qu'une lecture pouvait voir `CLIENT` pendant qu'une
transaction concurrente promouvait la fiche au personnel et validait. Les deux
clés étrangères de `appointments.client_id` prouvent l'existence de la ligne et
son établissement, jamais son rôle : le rendez-vous passait.

Le verrou est **partagé** : deux réservations d'invité pour la même personne chez
deux praticiens différents avancent de front, et seuls les écrivains de la ligne
attendent — ceux, précisément, qui pourraient la promouvoir. Comme au comptoir,
le SQL brut ne repasse pas par l'extension de scoping (ADR 0006), et `tenant_id`
est donc écrit à la main dans la requête, depuis le contexte de requête.

L'ordre d'acquisition ne change pas : `AppointmentsRepository.insert` prend
d'abord le verrou consultatif d'agenda, puis appelle la porte. Aucun chemin ne
détient un verrou de ligne `users` avant l'agenda, donc aucun cycle d'attente
nouveau.

**Ce que ce verrou ne ferme pas**, et il faut le dire : la fenêtre de l'adresse
**libre**. `FOR SHARE` verrouille les lignes rendues, et une lecture qui n'en rend
aucune ne verrouille rien — deux transactions peuvent constater ensemble que
l'adresse est libre. Cette course-là n'est pas laissée ouverte pour autant :
c'est celle que l'unicité arbitre, ci-dessous. La fermer par un verrou
demanderait un verrou de prédicat, c'est-à-dire `SERIALIZABLE` sur la transaction
d'agenda — des échecs de sérialisation sur des réservations sans rapport entre
elles, pour remplacer un arbitrage que la contrainte rend déjà gratuitement.

### La course sur l'adresse se rejoue chez l'appelant

Deux réservations d'invité concurrentes sur la même adresse : la perdante reçoit
`P2002`, que la porte traduit en `ClientRecordRaceError`. Elle n'est **pas**
rattrapée sur place — une violation de contrainte abandonne la transaction côté
PostgreSQL, et Prisma n'ouvre aucun point de sauvegarde : relire échouerait en
`25P02`. C'est `AppointmentsRepository.writingAgenda` qui rejoue la transaction
entière, au même titre qu'un interblocage, trois fois au plus. La tentative
suivante relit alors **sous verrou** la fiche que la gagnante vient d'écrire, et
la juge : les deux fenêtres sont donc couvertes, chacune par le mécanisme qui lui
convient.

## Le second battant : la fiche désignée par le comptoir (#465)

`resolveWithin` part de coordonnées et crée au besoin ; `assertBookableWithin`
part d'une fiche que le comptoir a **désignée** et ne crée jamais rien. Même
porte, même signature — une portée de transaction, un identifiant en retour, rien
de la fiche —, et la même question : « cette réservation peut-elle se rattacher à
cette ligne `users` ? ».

### Ce qu'elle referme

`appointments.client_id` référence `users`, où vivent aussi les comptes du
personnel. Les deux clés étrangères composites que traverse une insertion prouvent
que la ligne existe et qu'elle est du bon établissement — jamais qu'elle est du
**fichier client**. Le tunnel public refusait déjà ce cas depuis #313 ; le
comptoir désigne au lieu de résoudre, et ne traversait donc pas cette porte. Un
`STAFF` qui posait l'identifiant d'un collègue obtenait un rendez-vous valide dont
la cliente était un employé.

Une contrainte de schéma aurait été plus forte, et c'est la première voie qui a
été regardée : `users` ne porte aucune colonne dérivée sur laquelle une clé
étrangère partielle pourrait s'appuyer. La porte est donc applicative.

### Les deux lectures qui jugent un rôle sont les seules à écrire du SQL brut

Pour le `FOR SHARE`, que le client Prisma n'exprime pas — et sans lequel ce
contrôle serait exactement la « vérification applicative suivie d'un `INSERT` »
que booking-engine §1 interdit. Sous `READ COMMITTED`, une lecture nue verrait
`CLIENT`, une transaction concurrente promouvrait la fiche et validerait, et
l'insertion passerait : les clés étrangères, elles, ne regardent pas le rôle. Le
verrou de ligne ferme la fenêtre jusqu'au `COMMIT` de l'appelant.

Ce battant a porté le verrou seul de #465 à #468, où il a été étendu à
`resolveWithin`. Le module compte donc désormais **deux** lectures en SQL — celles
qui jugent un rôle avant une insertion qui en dépend, et elles seules. Tout le
reste (recherche, projections, historique, et les deux créations) passe par le
client scopé, qui pose `tenant_id` sans qu'aucune requête ait à le nommer.

Il est **partagé** et non exclusif : deux réservations pour la même cliente chez
deux praticiens différents doivent pouvoir avancer de front. Seuls les écrivains
de la ligne attendent — ceux dont il faut se prémunir.

Le SQL brut ne repasse pas par l'extension de scoping (ADR 0006) : `tenant_id`
est donc écrit à la main dans la requête, depuis le contexte de requête et de
nulle part d'autre. C'est ce qui rend une fiche du salon voisin **absente** plutôt
que refusée pour un autre motif.

### Le refus est un 404, et c'est un arbitrage

| Ce que l'identifiant désigne | Ce que la porte rend |
|---|---|
| une fiche `CLIENT` de l'établissement | l'identifiant, tel quel |
| rien du tout | `NotFoundError` — 404 |
| une fiche du salon voisin | `NotFoundError` — 404 |
| un compte `STAFF`, `MANAGER` ou `ADMIN` | `NotFoundError` — 404 |

Les trois refus sont **littéralement** le même : même classe, même message. Aucun
code neuf dans `@spa/shared`, et c'est délibéré.

C'est d'abord la conduite que ce module tient déjà partout : `findById`, `update`
et `setActive` replient « inconnu ici », « d'un autre établissement » et « c'est
un compte du personnel » sur un seul `null` — *« distinguer la troisième dirait
qui travaille au salon à qui n'a que le droit de lire des fiches »*. Un 409
`CLIENT_NOT_BOOKABLE` aurait dit exactement cela, et aurait fait de
`POST /appointments` une sonde de l'annuaire du personnel.

La symétrie avec `CLIENT_EMAIL_NOT_BOOKABLE` est par ailleurs trompeuse. Ce
409-là existe parce que `@@unique([tenantId, email])` ne laisse **aucune**
troisième voie : la visiteuse ne réservera jamais sous cette adresse, et le front
doit le savoir pour ne pas la renvoyer au calendrier (#452). Ici la voie existe et
elle est triviale — le comptoir a désigné la mauvaise ligne, et le tiroir de #50
ne montre que des `CLIENT`, si bien que ce corps ne se produit jamais par la
surface prévue. « Introuvable au fichier client » est vrai et actionnable ;
« définitivement non réservable » ne le serait pas.

## Tests

| Suite | Ce qu'elle couvre |
|---|---|
| `__tests__/customers.service.spec.ts` | CRUD, recherche, pagination, portée fermée par défaut |
| `__tests__/client-directory.service.spec.ts` | la porte de #313 : lecture sans filtre de rôle, refus d'une adresse du personnel, fiche désactivée réutilisée, course traduite en réessai — son verrou de #468 : `FOR SHARE`, filtre `tenant_id` écrit à la main, refus sans portée de tenant — et celle de #465 : mêmes garanties, quatre rôles, refus muet sur le rôle |
| `__tests__/customer-history.service.spec.ts` | agrégat vs fenêtre, bornes, devises multiples |
| `__tests__/crm.logging.spec.ts` | le module ne journalise rien ; la rédaction couvrirait ses champs |
| `apps/api/test/crm.integration-spec.ts` | les six routes servies, gardes, validation, sérialisation |
| `apps/api/test/crm-tenant.isolation-spec.ts` | le protocole de fuite sur les six routes |
| `apps/api/test/appointments-exclusion.integration-spec.ts` | la porte exercée contre un vrai PostgreSQL : le `ROLLBACK` qui emporte la fiche, le refus d'une adresse du personnel sans 500, la frontière du tenant sur cette écriture, et le rôle jugé à l'instant de l'insertion (#468) |
| `apps/api/test/appointments-exclusion.concurrency-spec.ts` | les courses : deux réservations d'invité sur la même adresse inconnue (#313), et la **promotion concurrente** qui prouve que le `FOR SHARE` de #468 verrouille vraiment — la suite unitaire ne vérifie que ce que la requête demande |

Le scénario délibéré des suites d'isolation est **la même personne dans les deux
salons** : `@@unique([tenantId, email])` l'autorise expressément, et c'est là
qu'une confusion de tenant se voit.
