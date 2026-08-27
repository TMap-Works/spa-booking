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

Pas encore écrits, et rien ici ne les préempte : l'endpoint de disponibilité avec
son cache Redis et son invalidation (#35), l'option premier disponible (#36).

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
| `availability.service.ts` | Assemble les entrées du calcul de créneaux et regroupe la sortie par journée |
| `staff-schedule.service.ts` | Règles métier de la semaine de travail |
| `staff-time-off.service.ts` | Plages bloquées et congés du personnel |
| `closing-days.service.ts` | Jours de fermeture récurrents de l'établissement |
| `*.controller.ts` | HTTP uniquement — routes, codes, sérialisation |
| `dto/` | DTO d'entrée et de sortie, validation `class-validator` |

## Les routes

Toutes se désignent par un **jeton** : le module n'a aucune surface publique, et
il n'y a donc rien à résoudre par slug d'URL.

| Méthode | Chemin | Rang |
|---|---|---|
| `GET` | `/api/v1/staff/:staffId/schedule` | `STAFF` |
| `PUT` | `/api/v1/staff/:staffId/schedule` | `MANAGER` |
| `GET` | `/api/v1/closing-days` | `STAFF` |
| `PUT` | `/api/v1/closing-days` | `MANAGER` |

Lecture au rang `STAFF` — consulter le planning fait partie du travail de
chacun ; écriture au rang `MANAGER` — fixer les heures de quelqu'un est une
décision de gestion.

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

### Ce que ce ticket ne pose pas

Aucune route, aucun cache. `GET /api/v1/availability`, la clé
`avail:{tenantId}:…` et son invalidation sont les critères de #35 ; l'agrégation
« premier disponible » et sa règle d'affectation, ceux de #36. `slotsFor` rend
d'ici là **tous** les créneaux de tous les candidats, triés par instant puis par
praticien — la matière sur laquelle #36 décidera.

Lire les rendez-vous existants sert à **proposer**, jamais à garantir : entre ce
`SELECT` et la validation de la cliente, une autre transaction peut insérer. La
garantie est la contrainte d'exclusion `appointments_no_overlap`, et elle seule
(ADR 0002, booking-engine §1).

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
