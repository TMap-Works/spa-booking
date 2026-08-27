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

Pas encore écrits, et rien ici ne les préempte : le calcul de créneaux (#34), le
cache Redis et son invalidation (#35), l'option premier disponible (#36), les
plages bloquées et congés (#33).

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
| `availability.repository.ts` | Le seul point qui connaît le schéma — client Prisma **scopé**, aucune dérogation |
| `staff-schedule.service.ts` | Règles métier de la semaine de travail |
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

## Fenêtres de travail — ce que `#34` consommera

`StaffScheduleService.windowsFor(staffId, from, to)` rend les fenêtres réelles
d'un praticien en instants UTC : **horaires − jours de fermeture**. Le calcul de
créneaux y retranchera les congés (#33) et les rendez-vous déjà pris.

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

Aucun service ne compare de `tenantId` : un praticien d'un autre établissement
n'est pas trouvé, ce qui donne le **404** attendu plutôt qu'un 403 qui
confirmerait son existence (tenant-isolation §4).

Le cas propre à ce module : le **fuseau**. Une confusion de tenant sur `timezone`
ne change aucun identifiant — elle décalerait silencieusement toutes les heures
rendues. Les deux établissements du harnais de test sont donc dans deux fuseaux
distincts (`Europe/Paris`, `Indian/Antananarivo`), et
`test/availability-tenant.isolation-spec.ts` vérifie que chacun reçoit le sien.
