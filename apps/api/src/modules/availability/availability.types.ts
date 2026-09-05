/**
 * Formes de données du module `availability` — CDC §2.3 « créneaux libres,
 * horaires du staff, plages bloquées, buffers ».
 *
 * TODO(#26) : `StaffScheduleView`, `StaffScheduleEntryView` et `ClosingDaysView`
 * appartiennent au contrat d'API et sont décrites par
 * `packages/shared/src/schemas/availability.ts` (`staffScheduleSchema`,
 * `staffScheduleEntrySchema`, `closingDaysSchema`). Elles devront en être
 * importées le jour où `apps/api` dépendra du paquet partagé — même TODO que
 * `catalog.types.ts` et `identity.types.ts`.
 *
 * ## Aucune de ces formes ne porte de `tenantId`
 *
 * Ni en entrée, ni en sortie. En entrée, parce que l'établissement vient du
 * jeton vérifié et de nulle part ailleurs (tenant-isolation §2). En sortie,
 * parce que c'est une information interne qui n'apporte rien au consommateur et
 * invite aux essais (§4).
 *
 * ## Ni aucune ne porte d'instant
 *
 * Un horaire récurrent **n'est pas** un point de la ligne du temps : `09:00`
 * n'est un instant qu'une fois posé sur une date et rapporté à un fuseau. Ces
 * formes transportent donc des heures murales, et le fuseau qui leur donne leur
 * sens. C'est `WorkingWindow` — interne, jamais sérialisée — qui porte les
 * instants, une fois la conversion faite.
 */

import type { IsoWeekday } from './availability.schedule';

/** Une plage de travail récurrente, telle que l'API la rend et la reçoit. */
export interface StaffScheduleEntryView {
  /** Jour ISO 8601 : 1 lundi … 7 dimanche. */
  readonly weekday: IsoWeekday;
  /** Heure murale `HH:MM` dans le fuseau de l'établissement. */
  readonly startsAt: string;
  /** Heure murale `HH:MM`, ou `24:00` pour minuit — borne **exclue**. */
  readonly endsAt: string;
}

/**
 * La semaine de travail d'un praticien.
 *
 * `timezone` accompagne les heures murales parce que sans lui elles ne veulent
 * rien dire : c'est le fuseau dans lequel l'écran doit les lire. Il est
 * **rendu**, jamais accepté en entrée — il appartient à l'établissement, pas à
 * la charge utile.
 */
export interface StaffScheduleView {
  readonly staffId: string;
  readonly timezone: string;
  /** Triées par jour puis par heure de début — un écran ne trie pas. */
  readonly entries: readonly StaffScheduleEntryView[];
}

/** Les jours de fermeture récurrents de l'établissement. */
export interface ClosingDaysView {
  /** Jours ISO fermés, croissants. Vide si le salon ouvre sept jours sur sept. */
  readonly weekdays: readonly IsoWeekday[];
}

/**
 * Ce qu'on demande au moteur de disponibilité — la forme **servie**, celle que
 * le cache sait indexer.
 *
 * `from` et `to` sont des dates civiles de l'établissement, bornes comprises.
 * `staffId` restreint à un praticien ; son absence vaut « tous ceux qui
 * pratiquent le soin ».
 *
 * TODO(#26) : cette forme appartient au contrat d'API — `packages/shared`
 * l'expose déjà, au même nom et aux mêmes quatre champs
 * (`availabilityQuerySchema`). Elle devra en être importée le jour où `apps/api`
 * dépendra du paquet partagé, sans quoi les deux déclarations homonymes
 * deviendront ambiguës à l'import — même TODO que les trois formes ci-dessus.
 */
export interface AvailabilityQuery {
  readonly serviceId: string;
  readonly staffId?: string;
  readonly from: string;
  readonly to: string;
}

/**
 * La même demande, **augmentée de ce que seul le report renseigne** (#316).
 *
 * ## Pourquoi deux types plutôt qu'un champ de plus sur le premier
 *
 * Parce que ce champ ne doit jamais atteindre le chemin caché. La clé de cache
 * est `(serviceId, staffId, journée)` : une vue calculée en ignorant un
 * rendez-vous, écrite sous cette clé, ferait voir son créneau libre à **tous**
 * les lecteurs suivants pendant le TTL. Le défaut serait borné — la réservation
 * rejoue le moteur à froid, et la contrainte tranche —, mais il n'a aucune
 * raison d'exister.
 *
 * `AvailabilityQueryService` accepte donc `AvailabilityQuery` et rien d'autre,
 * `AvailabilityService` accepte celle-ci. La séparation est la même, et pour la
 * même raison, que celle des deux services : une garantie qu'on lit sur le
 * graphe d'injection plutôt que dans un argument par défaut.
 */
export interface EngineAvailabilityQuery extends AvailabilityQuery {
  /**
   * Le rendez-vous à ne **pas** compter comme occupant — celui qu'un report est
   * en train de déplacer, et lui seul.
   *
   * Sans effet s'il désigne un rendez-vous d'un autre établissement : la lecture
   * est scopée, et cet identifiant n'y retire rien (tenant-isolation §4).
   */
  readonly excludeAppointmentId?: string;
}

/**
 * Un créneau proposable, tel que le moteur de disponibilité le rend (#34).
 *
 * Les instants sortent en **chaînes ISO 8601 suffixées `Z`** et non en `Date` —
 * même arbitrage que `StaffTimeOffView` : c'est le format de sortie du contrat,
 * et le fixer ici évite qu'un `JSON.stringify` ou un intercepteur ne rende un
 * jour autre chose.
 *
 * `startsAt` et `endsAt` bornent le **soin**, jamais l'agenda : leur écart vaut
 * exactement `services.duration_minutes`. Les tampons encadrent ce créneau et
 * occupent le praticien plus longtemps, mais ils ne sont ni facturés ni montrés
 * (CDC §2.3). C'est aussi la seule forme calculable côté client, qui ne reçoit
 * pas les tampons — voir `availabilitySlotSchema` du contrat partagé.
 */
export interface AvailabilitySlotView {
  readonly startsAt: string;
  readonly endsAt: string;
  readonly staffId: string;
}

/**
 * Les créneaux d'une **journée civile de l'établissement**.
 *
 * Le regroupement est fait ici et non côté front : découper une liste d'instants
 * UTC en journées demande le fuseau du tenant, et c'est exactement le calcul
 * qu'on ne veut pas voir réimplémenté dans un navigateur — il y serait fait avec
 * le fuseau de la machine, et une cliente en déplacement verrait ses créneaux
 * glisser d'un jour.
 *
 * Une journée sans créneau est rendue avec `slots: []` plutôt qu'omise : le
 * calendrier doit pouvoir afficher « complet » sans avoir à deviner ses trous.
 */
export interface DayAvailabilityView {
  readonly date: string;
  readonly slots: readonly AvailabilitySlotView[];
}

/**
 * La réponse du moteur de disponibilité.
 *
 * `timezone` accompagne les instants parce que c'est **le fuseau qui a servi au
 * découpage en journées** : sans lui, un front ne peut pas savoir à quelle
 * journée du salon appartient un instant, et regrouperait autrement que le
 * serveur.
 *
 * TODO(#26) : ces trois formes appartiennent au contrat d'API et sont décrites
 * par `packages/shared/src/schemas/availability.ts` (`availabilitySlotSchema`,
 * `dayAvailabilitySchema`, `availabilityResponseSchema`). Elles devront en être
 * importées le jour où `apps/api` dépendra du paquet — même TODO que
 * `StaffScheduleView` ci-dessus.
 */
export interface AvailabilityView {
  readonly serviceId: string;
  readonly timezone: string;
  readonly days: readonly DayAvailabilityView[];
}
