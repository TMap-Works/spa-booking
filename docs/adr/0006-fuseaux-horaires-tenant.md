# ADR 0006 — Les fuseaux horaires se calculent depuis la tzdata IANA, jamais depuis un offset stocké

- **Statut** : Accepté
- **Date** : 2026-08-27
- **Contexte CDC** : §2.3 Disponibilité et réservations, §6 Registre des risques

## Contexte

Un rendez-vous mal fuseau-horairé est un bug de sévérité haute (CLAUDE.md) : le
client se présente à la mauvaise heure, le praticien attend, le créneau est perdu
pour tout le monde. Le produit vise des établissements de plusieurs fuseaux —
`Europe/Paris` et `Indian/Antananarivo` sont deux marchés du MVP — et deux
natures de données se côtoient dans le même agenda :

- des **instants** : le début d'un rendez-vous, un horodatage de paiement. Ils
  sont stockés en `timestamptz` et n'ont qu'une seule lecture possible ;
- des **heures murales** : « le salon ouvre à 09:00 ». Elles ne désignent pas un
  instant tant qu'on ne leur adjoint pas une date **et** un fuseau.

Deux fois par an, la fonction qui va des secondes aux premières cesse d'être une
bijection. La nuit du passage à l'heure d'été, l'horloge saute de 02:00 à 03:00 :
`02:30` n'existe pas. La nuit du passage à l'heure d'hiver, elle recule de 03:00
à 02:00 : `02:30` existe deux fois, à une heure réelle d'écart. Le MVP ne peut
pas ignorer ces deux nuits : ce sont des nuits de samedi à dimanche, les plus
chargées d'un salon.

Le stockage était déjà tranché avant cet ADR — toutes les colonnes `DateTime` du
schéma sont en `@db.Timestamptz(6)` et `tenants.timezone` porte un identifiant
IANA obligatoire, sans valeur par défaut. Ce qui restait ouvert est le **code** :
d'où vient le décalage, et que faire des deux nuits.

## Options envisagées

### Option A — Mémoriser l'offset du tenant

Ajouter `tenants.utc_offset_minutes` à la création de l'établissement et s'en
servir partout. Une soustraction, aucune dépendance, aucun appel système.

C'est faux la moitié de l'année, et personne ne repasse corriger : un agenda
calculé ainsi décale **toute** la saison suivante d'une heure. Le défaut est
invisible en développement — on teste rarement un 29 mars — et se manifeste en
production, un dimanche matin, sur tous les rendez-vous à la fois. C'est
exactement le risque que le CDC §6 classe en impact élevé.

### Option B — Une bibliothèque de fuseaux tierce

`luxon`, `date-fns-tz` ou `@js-temporal/polyfill`. Ergonomie supérieure, API de
désambiguïsation explicite chez Temporal, communauté large.

Trois coûts, dont un rédhibitoire. Le paquet embarque ou recopie sa propre
tzdata, qui vieillit indépendamment de celle de Node : deux sources de vérité
pour la même question, et c'est la plus périmée qui décide. Il faut ensuite le
mettre à jour au rythme des révisions tzdata — plusieurs par an — sur un projet
qui n'a pas de mainteneur de dépendances dédié. Enfin, le paquet devrait vivre
dans `packages/shared` pour être commun au front et au back, ce qui alourdirait
un contrat qui n'est jusqu'ici que des types et des schémas Zod.

### Option C — La tzdata de l'ICU, via `Intl`

Node 20 embarque un ICU complet, donc la base tzdata, et l'expose par
`Intl.DateTimeFormat`. Le décalage d'un fuseau à un instant donné se lit en
formatant cet instant dans le fuseau puis en comparant l'heure murale obtenue à
l'instant d'origine. L'inverse — heure murale vers instant — se dérive du même
mécanisme.

Une seule source de tzdata pour tout le processus, mise à jour avec Node,
aucune dépendance à suivre. Le contrat partagé s'en sert déjà pour valider un
identifiant de fuseau (`isValidTimeZone`), et l'ICU connaît l'historique des
règles : un rendez-vous archivé se relit avec les règles de son époque.

Le coût est réel : `Intl` ne répond pas à « cette heure murale existe-t-elle ? »,
il faut le déduire. Et construire un `Intl.DateTimeFormat` est cher.

## Décision

**Le décalage n'est jamais stocké. Il est recalculé pour l'instant considéré,
depuis la tzdata IANA de l'ICU, via `Intl`.** Le moteur vit dans un seul fichier,
`apps/api/src/modules/availability/availability.time.ts`, et c'est le seul
endroit du code qui traverse la frontière heure locale ↔ UTC.

Trois conséquences de conception en découlent.

**La conversion heure murale → instant rend une résolution qualifiée, pas un
`Date`.** L'algorithme est celui de `Temporal.TimeZone.getPossibleInstantsFor` :
lire l'heure murale comme si elle était UTC, relever l'offset un jour avant et un
jour après ce repère, en dériver les instants candidats, ne garder que ceux qui
se relisent bien à l'heure demandée. **Le nombre de survivants est le
diagnostic** — un seul, l'heure est ordinaire (`exact`) ; deux, elle est ambiguë
(`ambiguous`) ; aucun, elle n'existe pas (`skipped`). Aucune table de transitions
n'est nécessaire, et les fuseaux dont le saut ne vaut pas une heure — Lord Howe,
trente minutes — sont traités sans clause particulière.

**Les deux anomalies ne sont jamais tranchées en silence sur un rendez-vous.**
`TenantClockService.requireExactInstant` refuse en 422 (`NON_EXISTENT_LOCAL_TIME`,
`AMBIGUOUS_LOCAL_TIME`), avec de quoi proposer un repli. Les calculs internes qui
n'ont pas d'enjeu métier — bornes d'une journée, découpage d'une fenêtre de
travail — utilisent la politique par défaut de `Temporal` (`compatible`) : trou
d'horloge résolu vers l'avant, ambiguïté résolue sur la première occurrence.

**Une journée civile ne dure pas 24 heures.** Sa borne haute est le minuit du
lendemain, jamais « début + 24 h » : cette seconde forme laisse une heure de
créneaux hors de la journée en octobre et en invente une en mars.

Côté contrat, **toute date qui traverse l'API porte un offset explicite**. En
sortie, l'API n'émet que des instants UTC suffixés `Z` — qui est un offset
explicite, et le seul référentiel où deux horodatages se comparent par simple
ordre lexicographique. En entrée, elle accepte aussi `±HH:MM` et normalise à la
frontière ; elle refuse en 400 la date-heure nue, dont le fuseau ne peut être que
deviné. L'heure `24:00` est refusée avec elle : le profil RFC 3339 ne la connaît
pas, et `new Date` la reporterait sans un mot au lendemain.

## Conséquences

**Ce que cela facilite.** Aucune dépendance de fuseau à suivre, aucune fenêtre
pendant laquelle notre tzdata serait plus vieille que celle de la plateforme.
Le passage heure d'été/hiver est un cas de test, pas une astreinte. Un
établissement s'ouvre dans n'importe quel fuseau sans une ligne de code, y compris
les fuseaux à décalage non entier en heures (`Asia/Kathmandu`, +05:45).

**Ce que cela coûte.** L'API est plus verbeuse que celle d'une bibliothèque
dédiée : lire une heure murale demande de formater et de relire, et résoudre une
heure murale demande jusqu'à quatre appels à `Intl`. Les formateurs sont donc
mémoïsés par fuseau — le cache est borné par le nombre de fuseaux valides,
puisque la validation précède l'insertion. Si le calcul de créneaux devenait un
point chaud mesuré, le remède serait un cache d'offsets par fuseau et par
journée, pas le retour à un offset stocké.

**Ce que cela ferme.** Le décalage d'un établissement ne peut pas être « corrigé
à la main » : il n'existe pas de champ à corriger. Un fuseau mal saisi se répare
en changeant `tenants.timezone`, et tous les affichages suivent — ce qui est le
comportement voulu, mais signifie aussi qu'aucun rattrapage local n'est possible.

**Ce que cela laisse ouvert.** Le modèle d'horaires récurrents du personnel
(`staff_schedules`, jour de semaine + heure murale) relève de #32 et n'existe pas
encore. Les utilitaires de conversion sont écrits pour lui et testés sans lui ;
#32 les consommera tels quels, et il ne doit pas exister de second endroit où
convertir. `AvailabilityModule` n'est délibérément pas enregistré dans
`AppModule` tant qu'il n'a pas de consommateur.

**L'adoption du format d'entrée est faite depuis #297.** `startsAt` de
`createAppointmentRequestSchema` et de `rescheduleAppointmentRequestSchema` est
en `offsetDateTimeSchema` ; les DTO NestJS correspondants portent
`@IsOffsetDateTime()`, et le contrat et l'API décrivent donc la même frontière.
Les champs de **sortie** restent en `utcInstantSchema` — c'est l'asymétrie
décidée plus haut, pas un reste à traiter. Les bornes `from` / `to` de
`appointmentListQuerySchema` restent en `calendarDateSchema` pour une raison
d'une autre nature : ce ne sont pas des instants, mais des dates civiles du
calendrier de l'établissement, dont le fuseau est `tenants.timezone` et non celui
de l'appelant.

Ce qui reste ouvert de ce côté est une **duplication**, pas une divergence :
`IsOffsetDateTime` et `OFFSET_DATE_TIME_PATTERN` existent en deux copies —
`availability` et `appointments` —, parce qu'un module n'importe pas un fichier
profond d'un autre (api-module §3) et qu'`apps/api` ne dépend pas encore de
`@spa/shared`. Les deux copies portent les noms du paquet partagé, pour que la
substitution ne change pas une borne en silence, et deux suites les tiennent
d'accord — `availability/__tests__/date-time.validation.spec.ts` et
`appointments/__tests__/date-time.validation.spec.ts`. C'est #26 qui les
résorbe.

**Ce qu'on saura si on s'est trompé.** Un rendez-vous dont l'heure affichée au
client diffère de celle du back-office, ou une journée de fin mars/fin octobre
qui propose un créneau de trop ou de moins. Les deux se voient dans les tests
`dst-booking.spec.ts` ; s'ils passent et que le symptôme apparaît quand même,
c'est que la conversion a été refaite ailleurs que dans `availability.time.ts`.
