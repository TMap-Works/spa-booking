import { calendarDaysBetween } from '@spa/shared';

import { AppointmentRangeTooWideError, MAX_APPOINTMENT_RANGE_DAYS } from './appointments.errors';
import type { ResolvedRange } from './appointments.types';

/**
 * La **fenêtre d'un agenda** : deux dates civiles complétées, jugées, puis
 * converties en instants — booking-engine §4.
 *
 * ```
 * ?from= ?to=  ──►  from / to complétées  ──►  jugées  ──►  minuit … minuit
 *  (ce qui est   │  l'une par l'autre,    │  ≤ 31 j    │  du salon, borne
 *   demandé)     │  sinon la journée du   │  et non    │  haute exclue
 *                │  salon                 │  inversées │
 * ```
 *
 * ## Pourquoi un fichier à part, et pourquoi ici
 *
 * Parce que **trois** lectures posent cette même question et qu'elles doivent la
 * poser de la même façon : `AppointmentsService.listAgenda` sert l'agenda du
 * comptoir, `MyStaffService.agenda` et `MyStaffService.schedule` servent celui du
 * praticien connecté. La règle était écrite deux fois, mot pour mot — une fois
 * dans chaque service (#932).
 *
 * Deux écritures d'une borne, c'est une borne qui finit par diverger : relever le
 * plafond d'un seul côté aurait fait **diverger les deux agendas sur ce qu'est
 * une semaine**, le comptoir servant une fenêtre que le praticien refuse, ou
 * l'inverse. Rien ne l'aurait signalé — les deux suites passent, séparément.
 *
 * Le fichier est **pur**, sur le modèle de `billed-interval.ts` : ni Nest, ni
 * Prisma, ni horloge injectée. C'est ce qui permet de le couvrir par une suite
 * unitaire qui n'instancie aucun service, et de l'appeler depuis les deux
 * services sans qu'aucun des deux ait à connaître l'autre (api-module §3).
 *
 * ## Ce que ce fichier ne décide pas
 *
 * La **valeur** de la borne. Elle vient de `MAX_APPOINTMENT_RANGE_DAYS`, que le
 * contrat partagé porte depuis #510 et qu'`appointments.errors.ts` réexporte :
 * c'est la même borne que celle dont les DTO annoncent le refus, et il n'y a
 * toujours qu'une écriture du nombre 31.
 */

/**
 * Ce que la résolution lit d'une demande — deux bornes facultatives, et rien
 * d'autre.
 *
 * Volontairement structurel plutôt que nominal : `ListAgendaInput`, qui porte en
 * plus les filtres du comptoir, et `MyStaffRangeInput`, qui porte le compte
 * appelant, le satisfont tous deux tels quels. Aucun des deux n'a donc à être
 * importé ici, et la fonction ne peut pas lire par accident un champ qui ne la
 * concerne pas — un `staffId`, notamment.
 */
export interface AgendaWindowRequest {
  readonly from: string | null;
  readonly to: string | null;
}

/**
 * Le référentiel de dates de l'établissement : son fuseau, et quel jour il y est
 * **maintenant**.
 *
 * Un objet nommé plutôt que deux paramètres positionnels, parce que les deux
 * sont des chaînes : `resolveAgendaRange(input, today, timeZone)` aurait compilé
 * sans broncher et rendu une fenêtre calculée sur un fuseau nommé `2026-10-20`.
 *
 * `today` est une **valeur**, pas une horloge : c'est l'appelant qui l'obtient de
 * `TenantClockService.calendarDateOf(now, timeZone)`, seul endroit qui sache quel
 * jour il est à Papeete quand il est déjà demain à Paris. C'est ce qui garde
 * cette fonction pure, et testable sans avancer le temps.
 */
export interface TenantCalendarContext {
  readonly timeZone: string;
  readonly today: string;
}

/**
 * Les bornes demandées, **complétées puis jugées**.
 *
 * ## Les deux bornes se complètent l'une l'autre
 *
 * Et la journée du salon ne sert que lorsqu'**aucune** n'est donnée. Le contrat
 * déclare valide une borne seule, des deux côtés (`appointmentListQuerySchema`,
 * `myStaffRangeQuerySchema`) : retomber sur « aujourd'hui » pour un `?to=` isolé
 * aurait rendu 422 une requête que le contrat annonce — toute borne haute passée
 * aurait donné une plage inversée.
 *
 * ## Jugées avant toute lecture
 *
 * Une plage inversée ou plus large que `MAX_APPOINTMENT_RANGE_DAYS` sort en 422
 * ici, avant que le moindre `SELECT` ne parte : sans cela, la taille de la
 * réponse ne dépendrait que de l'appelant, et une plage saisie au 20**2**6 au
 * lieu de 2026 ferait parcourir deux siècles d'agenda pour une faute de frappe.
 *
 * `calendarDaysBetween` compte les jours **bornes comprises** — du 1er au
 * 31 janvier fait trente et une journées, non trente. La borne porte donc sur le
 * nombre de journées servies, ce que la vue mois d'un calendrier demande.
 *
 * @throws {AppointmentRangeTooWideError} 422 `APPOINTMENT_RANGE_TOO_WIDE`, dont
 * les `details` portent les deux bornes **résolues** et la borne du contrat.
 */
export function resolveAgendaRange(
  request: AgendaWindowRequest,
  tenant: TenantCalendarContext,
): ResolvedRange {
  const from = request.from ?? request.to ?? tenant.today;
  const to = request.to ?? from;

  if (to < from || calendarDaysBetween(from, to) > MAX_APPOINTMENT_RANGE_DAYS) {
    throw new AppointmentRangeTooWideError(from, to);
  }

  return { from, to, timeZone: tenant.timeZone };
}

/**
 * Ce dont la conversion en instants a besoin d'une horloge — et rien d'autre.
 *
 * `TenantClockService` le satisfait structurellement, si bien que les deux
 * services lui passent le leur tel quel. Ce n'est **pas** une horloge injectée :
 * c'est un paramètre, au même titre que `BilledIntervalSource` dans
 * `billed-interval.ts`, et la fonction reste déterminée par ses seules entrées —
 * `dayRange` ne lit ni le temps courant, ni la base.
 *
 * Le port existe pour que ce fichier n'importe pas `AvailabilityModule` : un
 * module n'importe pas le service d'un autre par un chemin relatif profond
 * (api-module §3), et les deux services, eux, ont déjà cette porte.
 */
export interface TenantDayBoundaries {
  dayRange(calendarDate: string, timeZone: string): { readonly startsAt: Date; readonly endsAt: Date };
}

/** Une fenêtre d'agenda **en instants**, telle que le repository la lit. */
export interface AgendaWindow {
  readonly from: Date;
  readonly to: Date;
}

/**
 * La fenêtre résolue, en instants : du premier minuit du salon au dernier, borne
 * haute exclue.
 *
 * `dayRange` et non une arithmétique de millisecondes : une journée civile dure
 * 23, 24 ou 25 heures selon la date, et une fenêtre calculée à la main aurait
 * perdu ou doublé une heure d'agenda deux fois par an (booking-engine §4).
 *
 * Les deux bornes viennent de `dayRange` pour la même raison, et c'est le
 * `endsAt` du **dernier** jour qui ferme la fenêtre — jamais le `startsAt` du
 * suivant, qui aurait fait dépendre la borne haute d'une date que personne n'a
 * demandée.
 */
export function agendaWindowOf(range: ResolvedRange, days: TenantDayBoundaries): AgendaWindow {
  return {
    from: days.dayRange(range.from, range.timeZone).startsAt,
    to: days.dayRange(range.to, range.timeZone).endsAt,
  };
}
