# Module `availability`

Créneaux libres, horaires du personnel, plages bloquées, tampons — CDC §2.3.

C'est le module qui tient la frontière **heure murale ↔ instant UTC**. Tout ce
qui, dans ce produit, se dit « à 09:00 » sans dire lequel des 09:00 passe par
ici.

## Ce qui est livré

| Ticket | Ce qu'il pose |
|---|---|
| #41 | `TenantClockService` et `availability.time.ts` — la conversion, et les deux anomalies du changement d'heure |
| #32 | Horaires récurrents du personnel, jours de fermeture de l'établissement, fenêtres de travail |
| #33 | Plages bloquées et congés, l'algèbre d'intervalles, et l'appel d'invalidation du cache |
| #34 | **Le calcul des créneaux libres** — découpage, durée occupée, préavis, et les deux réglages qui les gouvernent |
| #35 | **Les deux endpoints de disponibilité**, le cache Redis à TTL court et son invalidation à toute écriture d'agenda |

Pas encore écrite, et rien ici ne la préempte : l'option premier disponible (#36).

## Les trois natures de données, et pourquoi on ne les confond pas

| Nature | Exemple | Stockage |
|---|---|---|
| **Instant** | le début d'un rendez-vous | `timestamptz`, en UTC |
| **Date civile** | « la semaine du 3 mars » | jamais stockée — une entrée de requête |
| **Heure murale** | « ouvre à 09:00 » | `INTEGER`, minutes depuis minuit local |

`09:00` à Paris vaut `08:00Z` en hiver et `07:00Z` en été. Stocker l'un des deux
décale l'agenda six mois par an — un bug de sévérité haute (CLAUDE.md, CDC §6).
C'est pourquoi une heure murale n'est **jamais** un `timestamptz` ici, et pourquoi
elle n'est pas non plus un `time` : voir
[ADR 0007](../../../../../docs/adr/0007-horaires-recurrents-en-minutes-murales.md).

Le décalage, lui, n'est stocké nulle part : il se recalcule pour l'instant
considéré, depuis la tzdata IANA de l'ICU
([ADR 0006](../../../../../docs/adr/0006-fuseaux-horaires-tenant.md)).

## Les fichiers

| Fichier | Rôle |
|---|---|
| `availability.time.ts` | Fonctions pures de conversion — ne connaît ni Prisma, ni HTTP, ni le domaine |
| `tenant-clock.service.ts` | Façade métier de la conversion : valide le fuseau, nomme les deux anomalies |
| `availability.schedule.ts` | Horaires récurrents : jours ISO, minutes murales, recouvrement, fenêtres de travail |
| `availability.intervals.ts` | Algèbre d'intervalles UTC : fusion, soustraction, recoupement |
| `availability.slots.ts` | Découpage d'une fenêtre libre en créneaux — durée occupée, grille, préavis |
| `availability.repository.ts` | Le seul point qui connaît le schéma — client Prisma **scopé**, aucune dérogation |
| `availability.service.ts` | Assemble les entrées du calcul de créneaux et regroupe la sortie par journée — **sans cache** |
| `availability.query.service.ts` | Le même calcul, derrière le cache : le chemin de lecture des deux endpoints |
| `availability-cache.ts` | Clé, durée de vie, lecture, écriture et invalidation du cache de disponibilité |
| `availability-cache.redis.ts` | L'entrepôt Redis — `SCAN`/`UNLINK`, `MGET`, pipeline, et un mode dégradé qui ne rejette jamais |
| `staff-schedule.service.ts` | Règles métier de la semaine de travail |
| `staff-time-off.service.ts` | Plages bloquées et congés du personnel |
| `closing-days.service.ts` | Jours de fermeture récurrents de l'établissement |
| `*.controller.ts` | HTTP uniquement — routes, codes, sérialisation |
| `dto/` | DTO d'entrée et de sortie, validation `class-validator` |

## Les routes

| Méthode | Chemin | Rang |
|---|---|---|
| `GET` | `/api/v1/availability` | `STAFF` |
| `GET` | `/api/v1/public/:tenantSlug/availability` | — (ouverte) |
| `GET` | `/api/v1/staff/:staffId/schedule` | `STAFF` |
| `PUT` | `/api/v1/staff/:staffId/schedule` | `MANAGER` |
| `GET` | `/api/v1/closing-days` | `STAFF` |
| `PUT` | `/api/v1/closing-days` | `MANAGER` |
| `GET` `POST` `PATCH` `DELETE` | `/api/v1/staff-time-off` | `STAFF` / `MANAGER` |

Lecture au rang `STAFF` — consulter le planning fait partie du travail de
chacun ; écriture au rang `MANAGER` — fixer les heures de quelqu'un est une
décision de gestion.

### Pourquoi deux routes pour un seul calcul (#35)

Le back-office cale un rendez-vous téléphoné : il a un jeton. Le tunnel de
réservation, lui, n'en a pas — on réserve sans compte (#37), et l'établissement
s'y désigne par un slug d'URL que `TenantScopeMiddleware` résout. Une route
unique aurait dû distinguer ses deux appelants par la présence d'un en-tête,
c'est-à-dire faire dépendre les droits d'une donnée fournie par le client. Le
catalogue a tranché la même question de la même façon : `ServicesController` et
`PublicServicesController`.

Les deux servent **exactement la même charge utile** — des instants et des
identifiants de praticiens, jamais un `tenantId`, jamais un motif d'absence,
jamais une identité de cliente. C'est ce qui rend le partage sans risque, et
`availability-endpoint.integration-spec.ts` le vérifie corps contre corps.

La route publique porte un quota de 120 appels par minute et par adresse : elle
**calcule**, sur une surface anonyme, et un appelant qui fait varier `from` d'un
jour à chaque appel contourne le cache entièrement. Le quota laisse le calendrier
se rafraîchir toutes les demi-secondes, bien au-delà de ce que #44 demande.

### Pourquoi des `PUT` et aucun `DELETE`

La ressource est la **semaine**, pas la plage ; la **liste** de jours fermés, pas
le jour. Un `PUT` la remplace en entier : c'est la seule forme où l'invariante
« aucune plage ne se recouvre » se vérifie sur ce que l'utilisateur voit à
l'écran, et non sur un état intermédiaire qui dépendrait de l'ordre des appels.

Retirer une plage, c'est renvoyer la semaine sans elle. La vider, c'est envoyer
`entries: []` — et c'est ainsi qu'un praticien cesse d'être proposable sans être
désactivé.

## Le modèle de données

```
staff_schedules      (tenant_id, staff_id, weekday, start_minute, end_minute)
tenant_closing_days  (tenant_id, weekday)
```

- `weekday` en **ISO 8601** : 1 lundi … 7 dimanche. Pas le `0`-dimanche de
  `Date.getDay` — `0` est *falsy*, et le praticien du dimanche disparaîtrait au
  premier `weekday ?? défaut`.
- `start_minute` / `end_minute` : minutes depuis minuit **local**, borne haute
  **exclue**. `1440` vaut minuit de fin de journée, rendu `24:00` par l'API.
- Plusieurs lignes par couple (praticien, jour) : c'est ainsi que se dit la
  coupure méridienne.
- Le non-recouvrement est garanti en base par `EXCLUDE USING gist` sur
  `int4range(start_minute, end_minute)`. Le contrôle applicatif ne la remplace
  pas : il **nomme** ce que la contrainte refuserait sinon en violation brute,
  donc en 500.
- `end_minute > start_minute` est garanti de la même façon, par
  `staff_schedules_minutes_check`, et nommé de la même façon — mais au **DTO**
  (`@IsAfterLocalTime('startsAt')`, 400 sur le champ `endsAt`) et non au service.
  Une plage inversée est une faute de forme : elle se voit sur la plage seule,
  sans rien connaître des autres, à la différence du recouvrement.

### Les trois refus, et où chacun se décide

| Saisie | Statut | Décidé par |
|---|---|---|
| borne mal formée, jour hors 1-7, champ non déclaré | `400 VALIDATION_ERROR` | DTO, décorateurs de format |
| `endsAt` ≤ `startsAt` | `400 VALIDATION_ERROR` | DTO, `@IsAfterLocalTime` |
| deux plages du même jour qui se recouvrent | `422 OVERLAPPING_SCHEDULE_RANGES` | service, `firstOverlap` |

## Le calcul des créneaux libres (#34)

`AvailabilityService.slotsFor({ serviceId, staffId?, from, to }, now?)` rend les
créneaux proposables, regroupés dans les journées civiles de l'établissement.
Rien n'est matérialisé en base : le calcul se fait **à la demande**, à partir de
six lectures (CDC §2.3).

Les six étapes de booking-engine §3, et où chacune vit :

| Étape | Ce qui la fait |
|---|---|
| 1. praticiens candidats via `service_staff` | `AvailabilityRepository.listServiceStaffIds` |
| 2. fenêtres de travail − jours de fermeture | `StaffScheduleService.windowsForMany` |
| 3. − congés, plages bloquées, rendez-vous occupants | `StaffTimeOffService.busyRanges`, `listBookedRanges`, `subtractRanges` |
| 4. découpage par pas de `slot_interval` | `availability.slots.ts` |
| 5. la durée occupée tient entièrement | `availability.slots.ts` |
| 6. passé et délai minimum de réservation | `availability.slots.ts` |

### Un créneau a deux intervalles, et on ne les confond pas

| Intervalle | Durée | Qui le voit |
|---|---|---|
| **occupé** | `buffer_before + duration + buffer_after` | l'agenda du praticien, la contrainte d'exclusion |
| **facturé** | `duration` | la cliente — c'est ce que rend l'API |

La grille se pose sur le premier, la réponse rend le second. L'inverse serait
impossible à exploiter : `PublicServiceView` ne porte délibérément pas les
tampons, et le front n'aurait donc aucun moyen de retrouver l'heure du
rendez-vous à partir de l'intervalle occupé.

Le filtre du préavis porte lui aussi sur l'intervalle **occupé** : c'est la
préparation de la cabine qui doit pouvoir commencer, pas seulement l'accueil.

### Où la grille prend son origine

À l'ouverture de la **fenêtre de travail**, jamais à minuit ni au bord d'un trou.
Un salon qui ouvre à 09:00 avec un pas de quinze minutes propose 09:00, 09:15,
09:30 — quels que soient les rendez-vous déjà pris. Ancrer la grille sur ce qu'il
reste après soustraction ferait glisser toutes les heures affichées à chaque
réservation, et deux clientes rafraîchissant la même page verraient des heures
différentes.

Les fenêtres sont **fusionnées avant** de servir d'origine : une journée continue
décrite en deux plages adjacentes (`09:00–12:00` puis `12:00–18:00`) est une
seule grille, sinon un soin de trente minutes ne pourrait jamais commencer à
11:45. Une vraie coupure méridienne reste deux fenêtres, et l'après-midi repart
bien de son ouverture.

### Les deux réglages de l'établissement

```
tenants.slot_interval_minutes       défaut 15,  borné 1..1440
tenants.min_booking_notice_minutes  défaut 60,  borné 0..43200
```

Ils sont sur `tenants` et non sur `services` : un salon annonce une grille, il
n'en annonce pas une par soin — deux prestations aux pas différents produiraient
sur un même agenda des créneaux qui se chevauchent à moitié. Les bornes sont
celles de `@spa/shared` (`MIN_SLOT_INTERVAL_MINUTES` et voisines) et de la
contrainte `CHECK` de la migration ; `tenant-booking-settings.spec.ts` relit le
SQL pour interdire qu'elles divergent.

La borne basse du pas n'est pas une préférence d'ergonomie : un pas nul fait
**boucler indéfiniment** le découpage, puisque le curseur n'avance plus.

### Ce qui reste à #36

L'agrégation « premier disponible » et sa règle d'affectation. `slotsFor` rend
d'ici là **tous** les créneaux de tous les candidats, triés par instant puis par
praticien — la matière sur laquelle #36 décidera.

Lire les rendez-vous existants sert à **proposer**, jamais à garantir : entre ce
`SELECT` et la validation de la cliente, une autre transaction peut insérer. La
garantie est la contrainte d'exclusion `appointments_no_overlap`, et elle seule
(ADR 0002, booking-engine §1).

## Le cache de disponibilité (#35)

```
avail:{tenantId}:{serviceId}:{staffId|any}:{date}   →   { timezone, slots }   TTL 60 s
```

Une clé par **journée**, et non par plage : une cliente qui fait glisser son
calendrier d'un jour réutilise alors toutes les journées déjà connues, là où une
clé portant la plage entière aurait forcé un recalcul complet à chaque pas. La
lecture est **tout ou rien** sur la plage demandée — le manque d'une seule
journée fait recalculer la plage entière, qui est ensuite écrite en entier.

Le fuseau est répété dans chaque valeur : sans lui, servir une réponse
entièrement issue du cache obligerait à relire `tenants` pour une seule colonne,
sur le chemin le plus chaud de l'API.

`{staffId}` vaut `any` quand la cliente n'en désigne aucun. Confondre les deux
servirait à la requête générale les créneaux d'un seul praticien : une réponse
amputée, donc des créneaux libres masqués.

### Ce que le cache garantit, et ce qu'il ne garantit pas

L'arbitrage de booking-engine §3 est **asymétrique**, et tout le reste en découle :

| Défaut du cache | Coût | Verdict |
|---|---|---|
| montre un créneau déjà pris | un 409 et un reclic | **acceptable** |
| masque un créneau libre | une vente | **inacceptable** |

D'où le TTL court **et** l'invalidation explicite, qui ne font pas double emploi :
le TTL borne la dérive, l'invalidation supprime l'attente sur les cas où elle
coûte cher — une annulation qui libère un créneau, un congé qui en retire un.

### Qui lit ce cache, et qui ne le lit jamais

C'est la garantie du cinquième critère du ticket — « un cache périmé ne peut
jamais provoquer une double réservation » — et elle tient à une seule ligne du
module :

| Chemin | Service | Voit le cache |
|---|---|---|
| `GET …/availability` | `AvailabilityQueryService` | oui |
| `POST …/appointments` (réservation, report) | `AvailabilityService` | **non** |

`AvailabilityModule` exporte le second et **pas** le premier : `appointments` ne
peut donc pas, même par accident, décider d'un créneau sur une réponse cachée.
`availability.module.spec.ts` verrouille cette décision — c'est un témoin, pas un
test de comportement, parce que la propriété porte sur une absence.

### L'invalidation, et les quatre écritures qui la déclenchent

`AvailabilityCacheService.invalidateCurrentTenant()` chasse `avail:{tenantId}:*`
par `SCAN` + `UNLINK` — jamais `KEYS`, qui bloquerait le Redis partagé par tous
les établissements le temps du balayage.

| Écriture | Où l'appel se fait |
|---|---|
| rendez-vous posé, reporté, annulé | `AppointmentsService` (#35) |
| absence posée, déplacée, retirée | `StaffTimeOffService` (#33) |
| semaine de travail remplacée | `StaffScheduleService` (#35) |
| jours de fermeture remplacés | `ClosingDaysService` (#35) |

Le tenant vient du **contexte de requête**, jamais d'un argument : un appelant
qui pourrait le choisir pourrait invalider — donc sonder l'existence du — cache
d'un autre établissement (tenant-isolation §2). Et le préfixe **commence** par le
tenant, ce qui est la seule position qui rende l'invalidation possible sans
balayer l'espace de clés entier.

L'invalidation a lieu **après** l'écriture : la faire avant laisserait le cache
se reconstruire sur l'ancien état si l'écriture échouait ensuite. Un refus —
créneau non proposable, recouvrement d'horaires — n'invalide rien.

### Une panne de Redis n'est jamais une panne de l'API

Aucune méthode de `RedisAvailabilityCacheStore` ne rejette : un cache injoignable
se comporte comme un cache vide, et l'endpoint recalcule. `commandTimeout` est
posé à 200 ms, sous le budget de 300 ms du quatrième critère — le cache ne peut
donc jamais rendre une réponse *plus lente* que s'il n'existait pas.

Le corollaire vaut pour l'écriture : si l'invalidation échoue, le rendez-vous
vient tout de même d'être posé. Refuser la réservation pour cette raison
échangerait une vente contre au plus soixante secondes de cache périmé.

### Trois limites connues, toutes bornées par le TTL

Elles sont écrites ici parce qu'elles se ressemblent : aucune ne peut rendre le
cache plus faux que ce que le TTL de soixante secondes autorise déjà, et aucune
n'atteint la réservation, qui rejoue le moteur à froid.

| Limite | Effet | Ce qui la refermerait |
|---|---|---|
| l'invalidation balaie l'espace de clés **partagé** (`SCAN` filtre après coup), et abandonne au-delà de ~100 000 clés vivantes | une écriture d'agenda paie le balayage des clés de ses voisins | un espace de clés versionné par tenant, invalidé par un `INCR` |
| course « lire puis écrire » : une invalidation tombée entre le défaut et l'écriture est perdue | une absence posée pendant le calcul peut rester invisible 60 s | une écriture conditionnelle sur cette même génération |
| une écriture du **catalogue** n'invalide rien | une prestation désactivée continue d'être servie 60 s | `CatalogModule` ne peut pas dépendre d'`AvailabilityModule`, qui dépend déjà de lui — il faudrait un événement de domaine |

Les deux premières appellent le même changement de forme de clé, et une issue de
suivi les porte ensemble.

### Une dette assumée : une seconde connexion Redis

`CacheConnection` (`infrastructure/cache`) tient le client Redis partagé de
l'application mais n'expose que `ping()`. Ce module ouvre donc sa propre
connexion, avec la même politique de connexion paresseuse et de réessai — et le
client n'est créé qu'à la **première commande**, si bien qu'une application qui
ne sert jamais de disponibilité n'ouvre jamais cette socket. L'unification des
deux clients est portée par une issue de suivi ; le jour où elle aura lieu, c'est
`availability-cache.redis.ts` qui disparaîtra, pas un appelant.

### Le temps de réponse, et comment il est tenu plutôt que mesuré

Le quatrième critère demande « sous 300 ms sur un mois de données ». Un test qui
chronométrerait une requête dépendrait de la machine et deviendrait le premier
test instable de la suite. Ce qui est vérifié à sa place est **structurel**, et
vrai partout :

- un succès de cache n'appelle pas le moteur du tout — donc aucune des six
  lectures, sur aucun volume de données (`availability.query.service.spec.ts`) ;
- une plage de trente et un jours coûte **un** aller-retour Redis (`MGET`), pas
  trente et un ;
- le calcul lui-même est borné à trente et un jours par
  `AVAILABILITY_RANGE_TOO_WIDE`, et `windowsForMany` le tient en trois requêtes
  quel que soit le nombre de praticiens.

## Fenêtres de travail

`StaffScheduleService.windowsFor(staffId, from, to)` rend les fenêtres réelles
d'un praticien en instants UTC : **horaires − jours de fermeture** ;
`windowsForMany` fait de même pour plusieurs praticiens en trois requêtes, ce
dont le calcul de créneaux se sert. Le premier lève un 404 sur un praticien
inconnu, le second rend une entrée absente — les identifiants qu'il reçoit
viennent d'une lecture déjà scopée, et distinguer « inconnu » de « connu
ailleurs » offrirait une sonde d'existence.

C'est un **appel de service**, la voie prévue par api-module §3 — jamais un
import du repository de ce module.

Trois propriétés que la suite unitaire verrouille :

- la journée du passage à l'heure d'été dure **23 heures**, celle du retour à
  l'heure d'hiver **25** ;
- une plage entièrement contenue dans le trou d'horloge (`02:00–03:00` fin mars à
  Paris) ne produit **aucune** fenêtre ;
- le jour de semaine se lit sur la **date civile du tenant**, jamais sur
  l'instant UTC — à Kiritimati (UTC+14), le lundi 09:00 local est le dimanche
  19:00Z, et un calcul qui aurait lu le jour depuis l'instant l'aurait rangé au
  dimanche.

## Isolation

Le repository injecte le client Prisma **scopé** : aucune requête n'a à répéter
`tenant_id`, donc aucune ne peut l'oublier. `prismaUnscoped` n'y est pas injecté
du tout — rien ici n'est légitimement inter-tenant.

Cela vaut aussi pour les trois tables que le module lit **sans les posséder** —
`staff`, `service_staff`, `appointments`. Il ne les crée ni ne les modifie ; il
en lit une projection réduite, scopée par la même extension. Le jour où le
catalogue exposera « quels praticiens pratiquent cette prestation » et où #37
aura posé `AppointmentsService`, ces lectures deviendront les appels de service
correspondants — la porte vers la durée et les tampons d'une prestation, elle,
est déjà `ServicesService`.

Aucun service ne compare de `tenantId` : un praticien d'un autre établissement
n'est pas trouvé, ce qui donne le **404** attendu plutôt qu'un 403 qui
confirmerait son existence (tenant-isolation §4).

Le cas propre à ce module : le **fuseau**. Une confusion de tenant sur `timezone`
ne change aucun identifiant — elle décalerait silencieusement toutes les heures
rendues. Les deux établissements du harnais de test sont donc dans deux fuseaux
distincts (`Europe/Paris`, `Indian/Antananarivo`), et
`test/availability-tenant.isolation-spec.ts` vérifie que chacun reçoit le sien.

Le second cas propre à ce module depuis #35 : le **cache**. C'est une seconde
source de vérité, donc un second endroit où l'isolation peut céder — et d'une
façon qu'aucun filtre `tenant_id` ne verrait. Deux établissements peuvent poser
la même question ; si la clé ne les distingue pas, le second reçoit la réponse du
premier sans qu'aucune requête n'ait traversé de frontière. La fuite serait dans
une chaîne de caractères. `test/availability-endpoint.isolation-spec.ts` couvre
les trois propriétés qui l'empêchent : la clé commence par le tenant,
l'invalidation ne porte que le préfixe du tenant courant, et la lecture prend le
tenant du contexte et non d'un argument.
