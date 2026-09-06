# Module `appointments`

Cycle de vie du rendez-vous — réserver, reporter, annuler. C'est le point
d'entrée du revenu (CDC §2.3), et le module où le risque n°1 du projet, la double
réservation, est tenu.

## Ce qui est livré

| Ticket | Ce qu'il pose |
|---|---|
| #31 | La contrainte d'exclusion, le verrou consultatif d'agenda et la traduction du refus en 409 |
| #37 | La réservation publique sans compte — fiche cliente, intervalle occupé, prix figé |
| #39 | Le report — annulation et création liées dans une seule transaction |
| #40 | L'annulation des deux côtés du comptoir — trace écrite, créneau libéré |
| #36 | **L'option « premier disponible »** — `staffId` facultatif, et la règle d'affectation |
| #38 | **Le verrou Redis de créneau** — `SlotLockService`, un `SET NX EX` court autour des deux écritures qui prennent un créneau |
| #47 | **L'historique de la cliente connectée** — `GET /appointments/mine`, deux moitiés et un plafond |
| #317 | **La note interne suit le report** — recopiée par le repository, jamais relue ni servie |
| #313 | **La fiche cliente vient de `crm`** — ce module n'écrit plus dans `users`, et la résolution partage la transaction de l'insertion |
| #444 | L'agenda du back-office — `GET /appointments`, une plage de jours et les trois *summaries* imbriquées |
| #461 | **Les trois écritures de comptoir** — poser, déplacer et solder un rendez-vous depuis le planning (#50) |
| #465 | **Le `clientId` du comptoir est jugé sur son rôle** — la porte `crm` refuse un compte du personnel, dans la transaction d'insertion |

## Les routes

| Méthode | Chemin | Rang | Rend |
|---|---|---|---|
| `POST` | `/api/v1/public/:tenantSlug/appointments` | — (ouverte) | `bookedAppointmentSchema` |
| `POST` | `/api/v1/public/:tenantSlug/appointments/:id/reschedule` | — (ouverte) | `bookedAppointmentSchema` |
| `POST` | `/api/v1/public/:tenantSlug/appointments/:id/cancel` | — (ouverte) | `bookedAppointmentSchema` |
| `GET` | `/api/v1/appointments/mine` | toute identité vérifiée | `bookedAppointmentSchema[]` |
| `GET` | `/api/v1/appointments` | `STAFF` | `appointmentSchema[]` |
| `POST` | `/api/v1/appointments` | `STAFF` | `appointmentSchema` |
| `POST` | `/api/v1/appointments/:id/reschedule` | `STAFF` | `appointmentSchema` |
| `POST` | `/api/v1/appointments/:id/status` | `STAFF` | `appointmentSchema` |
| `POST` | `/api/v1/appointments/:id/cancel` | `STAFF` | `bookedAppointmentSchema` |

Les trois routes publiques ne sont pas gardées, et c'est le quatrième critère de
#37 : on réserve sans compte. Ce qui les tient est le `ValidationPipe` global, le
contrôle de disponibilité, la contrainte d'exclusion, et un quota par adresse.

Aucune route de back-office n'a de quota, et c'est délibéré : l'appelant a un
jeton signé, un établissement et un rôle — le quota utile est l'authentification
elle-même. Un comptoir qui traite une matinée d'appels enchaîne légitimement les
écritures, et un plafond par adresse pénaliserait le salon dont tout le personnel
partage la même sortie réseau.

### Pourquoi `STAFF` et non `MANAGER` sur les cinq routes de back-office

Poser, déplacer, solder, annuler et consulter sont des gestes de **tenue
d'agenda**, pas de configuration de l'établissement. Le CDC §1.4 réserve à
l'encadrement la seconde, jamais la conduite de la journée : exiger un manager
rendrait l'écran principal du back-office inutilisable par ceux qui l'utilisent
toute la journée, et laisserait des créneaux fantômes bloqués jusqu'à ce que
quelqu'un d'autre soit disponible.

## Les écritures de comptoir (#461)

Trois routes, et deux d'entre elles ne portent **aucune règle nouvelle** :
`createAtDesk` délègue au corps commun de la réservation, `rescheduleAtDesk` à
`reschedule`. Ce qui change tient en deux points.

### La cliente est **désignée**, jamais créée

| Surface | Forme | Ce que le repository en fait |
|---|---|---|
| tunnel public | `client` — des coordonnées | demande la fiche à `crm`, qui la crée si elle manque |
| comptoir | `clientId` — une fiche | demande à `crm` de la **confirmer**, et l'écrit telle quelle |

C'est `ClientReference` qui porte la distinction côté domaine, et le
`.strict()` des deux schémas de `packages/shared` qui la tient côté contrat :
`bookGuestAppointmentRequestSchema` refuse un `clientId`,
`createAppointmentRequestSchema` refuse un `client`. Les deux sens sont
nécessaires — un seul laisse ouverte la porte qu'on ne regarde pas, et un
`client` glissé dans une demande de back-office ferait naître un second dossier
pour une cliente déjà fichée.

Les deux branches passent par une porte de `crm`, et aucune ne lit `users` depuis
ce module — il ne saurait pas ce qu'est une fiche cliente, et le lui apprendre
reviendrait à lui donner un moyen de parcourir la clientèle (api-module §3).

`clientId` est **obligatoire** sur cette route, là où le contrat le déclare
facultatif : le jeton est celui d'un membre du personnel, il n'y a pas de cliente
à en déduire. L'écart va dans le sens strict, et un 400 nommant le champ vaut
mieux qu'un rendez-vous posé au nom de personne.

### Trois façons de désigner la mauvaise fiche, un seul refus (#465)

| Ce que le `clientId` désigne | Qui le refuse |
|---|---|
| rien du tout | `ClientDirectoryService.assertBookableWithin` |
| une fiche du salon voisin | idem — le contrôle porte `tenant_id` dans son propre SQL |
| un compte `STAFF`, `MANAGER` ou `ADMIN` | idem — les clés étrangères, elles, ne voient pas le rôle |

Jusqu'à #465, l'identifiant descendait tel quel jusqu'aux clés étrangères, et
c'était la doctrine du module : la base tranche, le code traduit.
`appointments_client_id_fkey` jugeait l'existence de la ligne,
`appointments_tenant_id_client_id_fkey` son établissement. Aucune des deux ne
juge son **rôle** — or `appointments.client_id` référence `users`, où vivent
aussi les comptes du personnel. Un membre du personnel qui posait l'identifiant
d'un collègue obtenait un rendez-vous parfaitement valide dont la cliente était
un employé : invisible dans l'annuaire CRM (qui filtre sur `role = CLIENT`),
servi à l'employé par `/appointments/mine`, et compté comme cliente par le
reporting du CDC §1.4.

Une contrainte de schéma aurait été plus forte, et c'est la première voie qui a
été regardée. Elle n'existe pas : `users` ne porte aucune colonne dérivée sur
laquelle une clé étrangère partielle pourrait s'appuyer. La porte est donc
applicative — mais elle n'est pas pour autant une « vérification préalable » :

- elle est appelée **depuis la transaction d'insertion**, après le verrou
  consultatif d'agenda et avant l'`INSERT`. Un refus n'a rien à défaire, le
  `ROLLBACK` s'en charge — la même propriété que #313 a obtenue pour la fiche
  d'invitée ;
- elle lit sous `FOR SHARE`. Sans ce verrou de ligne, une transaction concurrente
  pourrait promouvoir la fiche au personnel entre la lecture et l'insertion, et
  les clés étrangères — qui ne regardent pas le rôle — la laisseraient passer.
  C'est ce qui distingue ce contrôle de celui que booking-engine §1 interdit.

Les clés étrangères restent le filet en dessous : `AppointmentsRepository.create`
continue de traduire leur refus dans le même 404.

#### Pourquoi 404 et non un 409 `CLIENT_NOT_BOOKABLE`

L'issue laissait l'arbitrage ouvert. **404**, le même que pour une fiche inconnue
et pour celle du salon voisin — même classe `NotFoundError`, même message —, et
donc aucun code neuf dans `@spa/shared`.

Trois raisons, et la troisième est décisive.

1. **C'est la conduite que `crm` tient déjà partout.** `findById`, `update` et
   `setActive` replient « inconnu ici », « d'un autre établissement » et « c'est
   un compte du personnel » sur un seul `null`, que le service traduit en 404 —
   « distinguer la troisième dirait qui travaille au salon à qui n'a que le droit
   de lire des fiches ». Un 409 ici aurait dit exactement cela, et aurait fait de
   `POST /appointments` une sonde de l'annuaire du personnel, interrogeable
   identifiant par identifiant par n'importe quel porteur de jeton `STAFF`.
2. **La symétrie avec `CLIENT_EMAIL_NOT_BOOKABLE` est trompeuse.** Ce 409-là
   existe parce que `@@unique([tenantId, email])` ne laisse **aucune** troisième
   voie : la visiteuse ne pourra jamais réserver sous cette adresse, et un front
   qui la renverrait au calendrier la ferait se heurter au même refus à chaque
   essai (#452). Ici la voie existe et elle est triviale — le comptoir a désigné
   la mauvaise ligne, la bonne est à un choix de tiroir. « Introuvable au fichier
   client » est à la fois vrai et actionnable ; « définitivement non réservable »
   ne le serait pas.
3. **Aucun écran n'aurait affiché ce 409.** Le tiroir de #50 choisit la fiche
   dans l'annuaire client, qui ne contient que des `CLIENT` : ce corps ne se
   produit jamais par la surface prévue. Un code distinct qu'aucun front ne rend
   n'est pas une information utile au comptoir, c'est une information rendue à qui
   fabrique la requête à la main.

### La réponse est la ligne d'**agenda**, pas la forme publique

Les trois routes rendent `appointmentSchema` — cliente, praticien et prestation
imbriqués. L'appelant est un calendrier : il doit pouvoir replacer le bloc qu'il
vient de toucher sans une requête de plus, et `bookedAppointmentSchema` ne porte
que des identifiants.

Cela coûte une lecture de plus par écriture (`findAgendaById`), et c'est le bon
prix : la seule autre voie était de recomposer la ligne depuis le catalogue et
l'annuaire du personnel, ce qui aurait fait **deux** façons de fabriquer la même
ligne — celle de `listAgenda` et une autre. Le jour où elles auraient divergé
d'un champ, le tiroir aurait affiché autre chose que la case qu'il venait de
remplir.

### Le changement de statut, et le seul cas qu'il ne traite pas lui-même

`POST /:id/status` fait avancer un rendez-vous sous le contrôle
d'`AppointmentLifecycleService`, qui porte la table du cycle de vie et lui seul :
`pending → completed` sort en **422 `INVALID_STATE_TRANSITION`**, comme tout
retour en arrière depuis un statut terminal et comme un statut vers lui-même.

Le corps accepte les cinq statuts du vocabulaire, `cancelled` compris — c'est ce
que `changeAppointmentStatusRequestSchema` déclare. Cette transition-là est
**déléguée à l'annulation** : une ligne passée `CANCELLED` par un simple
changement de statut n'aurait ni `cancelled_at`, ni `cancelled_by`, ni motif, et
le reporting du CDC §1.4 compterait une annulation dont il ne saurait dire ni
quand ni de quel côté du comptoir elle vient. C'est aussi ce qui donne une
destination au `reason` du contrat ; sur toute autre transition, il n'a pas de
colonne où aller et n'est pas consigné.

L'écriture elle-même est un `updateMany` filtré sur le statut **relu**, qui rend
un compte : deux transitions concurrentes du même rendez-vous se sérialisent sur
le verrou de ligne, et la seconde sort en 409. Même conduite que l'annulation et
le report — le service parle, la base décide (booking-engine §1).

## Le contrat partagé, et le doublon qui l'accompagne (#314)

`packages/shared` est la source de vérité du contrat d'API (CLAUDE.md) : le front
ne redéclare jamais un type que l'API expose. Ce module y a ses contreparties, et
elles sont **nommées** — se tromper de schéma, ici, se paie en fuite de donnée
personnelle ou en réservation au nom d'un autre.

| Ce module | `packages/shared/src/schemas/appointment.ts` |
|---|---|
| `BookAppointmentDto` | `bookGuestAppointmentRequestSchema` |
| `GuestContactDto` | `guestContactSchema` |
| `AppointmentDto` | `bookedAppointmentSchema` |
| `RescheduleAppointmentDto` | `rescheduleAppointmentRequestSchema` |
| `CancelAppointmentDto` | `cancelAppointmentRequestSchema` |
| `MyAppointmentsQueryDto` | `myAppointmentsQuerySchema` |
| `CreateAppointmentDto` | `createAppointmentRequestSchema` |
| `ChangeAppointmentStatusDto` | `changeAppointmentStatusRequestSchema` |
| `AppointmentListQueryDto` | `appointmentListQuerySchema` |
| `AgendaAppointmentDto` | `appointmentSchema` |

Deux appariements qu'on croirait interchangeables et qui ne le sont pas — ce sont
les deux que #461 a servis, et s'en tromper reste aussi coûteux :

- **`createAppointmentRequestSchema`** est la demande du **back-office** — un
  `clientId`, pas de coordonnées. Le tunnel public qui l'accepterait réserverait
  au nom de quelqu'un d'autre. `BookAppointmentDto` reste sa jumelle publique,
  et les deux se refusent mutuellement leur champ distinctif ;
- **`appointmentSchema`** est la ligne d'**agenda** — elle imbrique les
  *summaries* de la cliente, du praticien et de la prestation. La servir sur une
  route ouverte diffuserait l'identité d'une cliente à qui connaît un
  identifiant de rendez-vous. Les routes publiques rendent des identifiants,
  c'est `bookedAppointmentSchema` ; les routes de comptoir rendent la ligne
  d'agenda, derrière `@AuthAtLeast('STAFF')`.

Un troisième écart, propre à `CreateAppointmentDto` : `clientId` y est
**obligatoire** alors que le contrat le déclare facultatif. Il va dans le sens
strict — le DTO refuse ce que le contrat tolère —, donc un front qui valide avec
le contrat peut produire une requête que la route refuse en 400. C'est le cas
qu'aucun appelant réel ne produit : le tiroir de #50 désactive son bouton
d'enregistrement tant qu'aucune fiche n'est choisie.

Ces formes sont donc écrites **deux fois** — ici en `class-validator`, là-bas en
Zod — parce que `apps/api` ne dépend pas encore de `@spa/shared` : c'est ce
qu'attend le quatrième critère de #314, et la dépendance manque toujours à
`apps/api/package.json`. Le doublon n'est tenable qu'à une condition, et deux
suites s'en chargent :

- `__tests__/guest-contract.spec.ts` — la **requête**, champ par champ et borne
  par borne, sur les fixtures littérales de
  `packages/shared/src/__tests__/guest-booking.spec.ts` ;
- `test/appointments-booking.integration-spec.ts` — la **réponse**, dont le jeu
  de clés servi est comparé à celui de `bookedAppointmentSchema`.

Deux écarts de comportement subsistent, tous deux assumés :

- **`phone`** — le contrat le veut en E.164 et le normalise ; le DTO accepte un
  format libre borné et conserve la saisie. L'écart est orienté dans le **sens
  sûr** : le contrat étant le plus strict, un formulaire qui valide avec lui ne
  produit jamais une requête que la route refuse. Le refermer demande de décider
  si `users.phone` est en E.164 pour **tous** ses écrivains, `identity` compris,
  ce qui déborde ce module ;
- **la version d'UUID** — `uuidSchema` accepte n'importe quelle version, les DTO
  exigent `@IsUUID('4')`. Celui-là penche dans le sens **inverse**, et donc moins
  confortable : le contrat est le plus permissif. Il reste théorique tant que
  tous les identifiants proposés à un formulaire viennent de l'API, qui n'émet
  que des v4 — mais c'est un « tant que », pas une garantie, et il porte sur
  toute la surface du contrat et non sur ce module.

Ces deux-là et le découpage en labels du domaine d'une adresse (que
`@IsEmail()` borne à 63 octets et que le contrat ne rejoue pas) sont l'inventaire
complet au terme de #314. Les bornes de longueur d'adresse, elles, ont été
alignées : voir l'en-tête d'`emailSchema`.

## L'historique de la cliente connectée (#47)

Le CDC §1.4 demande « un compte client avec historique ». La route qui le sert
est `GET /api/v1/appointments/mine`, et sa forme tient en trois décisions.

### La cliente vient du jeton, et il n'y a aucun champ pour en désigner une autre

`MyAppointmentsQueryDto` ne porte **ni `clientId`, ni `from`, ni `to`** : deux
moitiés et un plafond, rien d'autre. L'agenda du back-office a bien un filtre par
cliente (`appointmentListQuerySchema`), mais il vit derrière une garde `STAFF` et
sur une autre surface. Ici, `clientId` vient de `@CurrentUser()`, et le
`ValidationPipe` global — `forbidNonWhitelisted` — refuse en 400 celui qu'on
glisserait dans la requête.

### « À venir » n'est pas un filtre de temps

| Moitié | Prédicat | Ordre |
|---|---|---|
| `upcoming` | l'intervalle n'est pas terminé **et** le statut occupe encore le créneau | croissant |
| `past` | le complément exact | décroissant |

Un rendez-vous annulé pour demain n'a plus rien à honorer : il descend dans
l'historique, avec sa mention. Les deux moitiés sont **disjointes et
complémentaires**, si bien qu'aucun rendez-vous ne peut disparaître de l'espace
client — un simple `starts_at < now` aurait laissé les annulations futures hors
des deux.

### Une lecture du catalogue, pas N

`billedView` a besoin des tampons de la prestation pour retrouver l'intervalle
facturé. L'historique lit donc le catalogue **une fois** (`activeOnly: false` —
un soin retiré de la vente reste dans l'historique de celles qui l'ont réservé)
et le résout par une table. Une prestation introuvable retombe sur l'intervalle
occupé plutôt que de vider l'écran.

Aucune migration : `@@index([tenantId, clientId, startsAt])` sert exactement
cette requête depuis #31, et `Appointment.clientId` référence déjà `User`.

## Les deux intervalles d'un rendez-vous

| Intervalle | Durée | Qui le voit | Où il vit |
|---|---|---|---|
| **occupé** | `buffer_before + duration + buffer_after` | l'agenda du praticien | `appointments.starts_at` / `ends_at`, donc `time_range`, donc la contrainte |
| **facturé** | `duration` | la cliente | `AppointmentView`, dérivé à la lecture |

La base stocke le premier, l'API rend le second. Même asymétrie que dans
`availability.slots.ts` : la grille se pose sur l'occupé, la sortie rend le
facturé.

## L'option « premier disponible » (#36)

Le CDC §1.4 la nomme explicitement : « choix du praticien ou *premier
disponible* ». Elle se dit en **omettant `staffId`** du corps de la réservation.
Son absence n'est pas une donnée manquante, c'est un choix.

### La règle d'affectation

> Le rendez-vous va au **premier praticien libre dans l'ordre du moteur de
> disponibilité** — `(instant, puis identifiant de praticien)` —, et au suivant
> si la base refuse son créneau.

La liste des candidats est celle que `AvailabilityService.slotsFor` rend **pour
l'instant demandé**, sans `staffId` : tous les praticiens qui pratiquent la
prestation et que le moteur propose alors. Rien n'est recalculé dans ce module,
et aucune règle de disponibilité n'y est réécrite.

Trois propriétés l'ont fait retenir :

- **déterministe à agenda constant** — deux requêtes identiques posées sur le
  même état du calendrier désignent le même praticien. Ce n'est pas de
  l'idempotence : au second envoi d'un double clic, le premier praticien est déjà
  pris, le repli affecte le suivant, et la cliente repart avec **deux**
  rendez-vous plutôt qu'un 409 — la contrainte d'exclusion porte sur `(tenant,
  praticien, intervalle)`, jamais sur la cliente. Désarmer le double envoi reste
  au front (#45) ; une déduplication côté serveur est portée par une issue de
  suivi ;
- **elle remplit un agenda avant d'en ouvrir un autre** — le salon garde des
  plages libres continues chez les praticiens suivants. Une répartition tournante
  émietterait toutes les journées, et un agenda émietté ne vend plus de soin
  long ;
- **elle ne propose jamais un praticien qui ne pratique pas la prestation** : les
  candidats sont l'intersection de `service_staff` calculée par le moteur
  (booking-engine §6, troisième critère du ticket).

Contrepartie assumée : à égalité de disponibilité, c'est toujours le même
praticien qui prend la réservation sans préférence. Une répartition à la charge
coûterait une lecture de plus par réservation ; une issue de suivi la porte.

### Le repli en cas de conflit

Quatrième critère du ticket. Chaque tentative est une **écriture complète**,
verrou consultatif d'agenda compris, jugée par `appointments_no_overlap`. Quand
elle est refusée, le praticien suivant est tenté ; le 409 n'est prononcé
qu'une fois la liste épuisée.

Ce que le repli n'est pas : une façon de contourner le refus. Il n'y a aucune
vérification applicative « ce créneau est-il libre ? » avant l'insertion, aucun
réordonnancement des candidats entre deux tours, aucune mémoire des praticiens
« probablement pris ». La contrainte reste le seul arbitre de l'unicité
(ADR 0002, booking-engine §1) — le repli est ce qu'on fait **après** avoir reçu
son verdict.

Le nombre de tours est borné par la liste que le moteur vient de rendre. Sur une
réservation nominale il vaut un ; il ne croît que sous contention réelle, et
jamais au-delà de l'effectif affecté à ce soin.

### Ce que la réponse dit, et ce qu'elle tait

Le rendez-vous rendu porte **toujours** `staffId` : c'est par lui que la cliente
apprend qui lui a été affecté. Le 409, lui, rend `details.staffId: null` quand
elle n'a désigné personne — nommer le dernier praticien tenté apprendrait à un
appelant anonyme un identifiant qu'il n'a jamais soumis, et ferait de cette route
une sonde d'agenda.

### Pas d'affectation au report

`reschedule` garde le praticien de la demande, ou celui du rendez-vous d'origine.
Un report qui changerait de praticien de lui-même déplacerait une cliente chez
quelqu'un qu'elle n'a pas choisi.

### Ce que le report emporte, et ce qu'il ne rend pas (#317)

Le successeur reprend de la ligne d'origine la cliente, la prestation, le prix
figé, le statut, la note de la cliente et la **note interne du praticien**. Cette
dernière appartient au rendez-vous, pas au créneau : la laisser sur la ligne
annulée ferait perdre au salon, à chaque déplacement d'heure, ce qu'un praticien
avait écrit.

Elle est pour autant la seule à ne **jamais** ressortir. Deux voies existaient ;
celle qui n'a pas été retenue élargissait `APPOINTMENT_SELECT` — la frontière de
sortie du module, commune aux six lectures — pour exclure ensuite la note de
`AppointmentView`. Elle aurait remplacé une garantie structurelle par une
discipline, sur une vue qui sert aussi le parcours public.

La voie retenue lit `staff_note` **là où elle est recopiée** et nulle part
ailleurs : `RESCHEDULE_SOURCE_SELECT`, local au report, alimente le `create` ; le
`select` de ce `create` reste `APPOINTMENT_SELECT`, si bien que la ligne écrite
est relue sans sa note. Aucune valeur de `staff_note` n'atteint donc un
`AppointmentRecord`, ni `AppointmentView`, ni `AppointmentDto`.

Le back-office de #50 aura besoin de la lire : ce sera une sortie distincte,
gardée par un rôle — jamais un champ de plus sur la vue publique.

## Ce qui garantit l'unicité, et ce qui ne la garantit pas

| Mécanisme | Ce qu'il fait |
|---|---|
| `appointments_no_overlap` | **La garantie.** Refuse tout chevauchement `(tenant, praticien, intervalle)` sur les statuts occupants |
| verrou consultatif `pg_advisory_xact_lock` | Ordonne les candidates d'un même praticien — supprime les interblocages, ne décide de rien (ADR 0006) |
| verrou Redis `slot:{tenant}:{staff}:{instant}` | **Confort d'interface.** Évite de donner à deux personnes le créneau affiché — ne garantit rien, et une panne de Redis le retire sans rien refuser (#38, ADR 0002) |
| contrôle de disponibilité | Refuse un créneau que le calendrier ne proposait pas — jour de fermeture, congé, préavis. Ne dit rien de l'unicité |
| cache de disponibilité | **Jamais lu ici.** `AvailabilityModule` n'exporte pas `AvailabilityQueryService` : un cache périmé ne peut pas faire réserver un créneau pris (#35) |

## La fiche cliente ne s'écrit plus ici (#313)

Réserver sans compte suppose une ligne `users` — `appointments.client_id` est
`NOT NULL`. `AppointmentsRepository.findOrCreateClient` l'écrivait lui-même
depuis #37, faute de porte : `crm` n'existait pas, et `identity` n'exporte ni son
repository ni `UsersService`. C'était la table d'un autre domaine écrite par un
module qui ne la possède pas (api-module §3).

`CrmModule` exporte désormais `ClientDirectoryService`, et c'est le **repository**
de ce module qui l'appelle — pas le service. La raison est l'atomicité : le seul
moment où la résolution peut avoir lieu est à l'intérieur de la transaction
d'insertion, et c'est le repository qui l'ouvre. La faire descendre depuis le
service aurait exigé qu'il manipule une portée Prisma, ce qu'api-module §2 lui
interdit.

### L'ordre dans la transaction, et pourquoi il est celui-là

```
BEGIN
  pg_advisory_xact_lock(agenda du praticien)     ← ordonne les candidates (ADR 0006)
  crm.resolveWithin(tx, coordonnées)             ← tunnel public : la fiche, trouvée ou créée
  crm.assertBookableWithin(tx, clientId)         ← comptoir : la fiche, confirmée sous FOR SHARE (#465)
  INSERT INTO appointments …                     ← jugé par appointments_no_overlap
COMMIT   -- ou ROLLBACK, qui emporte les deux
```

Les deux lignes du milieu s'excluent : une réservation emprunte l'une ou l'autre,
selon la forme de sa `ClientReference`.

Le verrou d'abord : il supprime le cycle d'attente, et une résolution posée avant
lui ferait attendre sur l'index unique de `users` une transaction qui ne tient pas
encore l'agenda — un ordre d'acquisition dicté par les données, c'est-à-dire ce
que le verrou existe pour supprimer. La fiche ensuite, parce qu'il faut la ligne
avant de pouvoir la désigner.

Le `FOR SHARE` du contrôle de comptoir est **partagé**, délibérément : deux
réservations pour la même cliente chez deux praticiens différents le détiennent
ensemble et n'attendent pas l'une l'autre. Il ne bloque que les écrivains de la
ligne `users` — ceux, précisément, qui pourraient la promouvoir au personnel entre
le contrôle et l'insertion.

**Ce que cela change pour l'appelant** : un 409 de créneau ne laisse plus de fiche
derrière lui. Ce n'est pas du code, c'est le `ROLLBACK` — exactement comme
l'atomicité du report. `test/appointments-exclusion.integration-spec.ts` le prouve
contre un vrai PostgreSQL ; aucun double en mémoire ne le pourrait.

### Deux refus nouveaux sur la route publique

| Situation | Réponse |
|---|---|
| l'adresse porte un compte `STAFF`/`MANAGER`/`ADMIN` | 409 `CLIENT_EMAIL_NOT_BOOKABLE` — décision de `crm`, laissée passer telle quelle |
| deux réservations concurrentes créent la même fiche | rejouée par `writingAgenda`, trois tentatives au plus ; épuisées, un 500 |

La route de comptoir a son symétrique depuis #465 — un `clientId` qui désigne un
compte du personnel —, et il ne rend **pas** le même code : 404, indistinctement
d'une fiche inconnue. Les deux surfaces ne sont pas dans la même situation, et
l'arbitrage est détaillé plus haut, « Trois façons de désigner la mauvaise
fiche ».

La seconde ligne suit l'arbitrage de l'interblocage : une course d'ordonnancement
se rejoue, elle ne se maquille pas en refus métier. Elle ne peut pas être rattrapée
dans `crm` — une violation de contrainte abandonne la transaction côté PostgreSQL,
et seul celui qui l'a ouverte peut la rejouer.

Le détail des deux décisions produit, et ce qu'elles coûtent, est dans le
[README de `crm`](../crm/README.md).

## Le verrou Redis de créneau (#38)

L'ADR 0002 le décrit en une phrase, et c'est exactement ce que le module en
fait :

> Un verrou Redis court est posé pendant la saisie du paiement pour éviter
> d'afficher un créneau à deux personnes, mais il ne conditionne jamais la
> validité de l'écriture.

La primitive vit dans `infrastructure/cache` — `CacheConnection.acquireLock` /
`releaseLock`, un `SET NX EX` et une libération par script conditionné au jeton.
La **convention de clé** et l'usage vivent ici, dans `slot-lock.service.ts`.

### La clé

`slot:{tenantId}:{staffId}:{instant du soin en ISO 8601}` — la forme de
booking-engine §2, bâtie comme celle du cache de disponibilité : racine, puis
établissement, puis le reste. Le tenant en tête est ce qui empêche un
établissement de verrouiller — ou d'observer — le créneau d'un autre
(tenant-isolation §5). Il vient du contexte de requête, jamais d'un argument.

L'instant est celui du **soin**, pas la borne occupée : le verrou existe pour ne
pas donner deux fois le créneau *affiché*.

### Ce qu'il ne fait pas

| | |
|---|---|
| Tenir le verrou | **n'autorise rien.** L'insertion reste jugée par `appointments_no_overlap` |
| Ne pas le tenir | n'interdit que le cas où un autre appelant écrit ce créneau **à cet instant** — et sans préférence de praticien, l'affectation passe au suivant |
| Redis injoignable | **ne refuse jamais.** `CacheLockOutcome` distingue `taken` d'`unavailable` ; le second réserve sans verrou |
| Une écriture en erreur | relâche quand même : le `finally` ne trie pas |
| Annuler | ne prend aucun verrou — on ne se dispute pas un créneau qu'on libère |

Le TTL est de dix secondes. Ce n'est pas la durée attendue — le verrou est tenu
quelques dizaines de millisecondes et relâché dans un `finally` — mais la borne
du seul cas où le `finally` ne s'exécute pas : un processus abattu entre la prise
et la libération.

### Ce qui reste à faire, et qui n'est pas dans ce module

Le verrou est **posé** ici, il n'est **lu** nulle part. Faire qu'un créneau tenu
apparaisse comme occupé sur le calendrier d'un second visiteur — le « pendant la
saisie du paiement » du titre, avec la bannière d'expiration décrite par
[docs/design/appointments/slot-unavailable.md](../../../../../docs/design/appointments/slot-unavailable.md)
— demande deux choses hors de l'empreinte de ce ticket : que le moteur de
disponibilité consulte cet espace de clés, et une surface qui tienne le verrou
entre la sélection et la validation. Une issue de suivi les porte.

## Isolation

Le repository injecte le client Prisma **scopé** : aucune requête ne répète
`tenant_id`, donc aucune ne peut l'oublier. Un rendez-vous d'un autre
établissement est **introuvable** — 404, jamais 403, qui confirmerait son
existence (tenant-isolation §4).

Le cas propre à l'option « premier disponible » : les candidats viennent d'une
lecture déjà scopée, si bien qu'un praticien du voisin ne peut pas être affecté —
et un `staffId` du voisin explicitement demandé rend le même 409 qu'un créneau
pris, jamais un 404 qui distinguerait les deux.
`test/appointments-tenant.isolation-spec.ts` couvre les deux.

L'historique (#47) ajoute une **seconde** frontière à la première :
`test/appointments-mine.isolation-spec.ts` sème deux rendez-vous portant le
**même `clientId`** dans deux établissements, et une seconde cliente dans le
même. Un filtre par cliente sans filtre par établissement ramènerait les deux, et
aucune assertion sur « la liste n'est pas vide » ne le verrait.
