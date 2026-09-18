import { APPOINTMENTS_ERROR_CODES, MAX_APPOINTMENT_RANGE_DAYS } from '@spa/shared';

import { TenantClockService } from '../../availability/tenant-clock.service';
import { agendaWindowOf, resolveAgendaRange } from '../agenda-window';
import { AppointmentRangeTooWideError } from '../appointments.errors';

/**
 * La règle de fenêtre d'agenda — `agenda-window.ts` (#932).
 *
 * Elle était écrite **deux fois**, mot pour mot : dans `AppointmentsService`
 * pour l'agenda du comptoir, dans `MyStaffService` pour celui du praticien
 * connecté. Ces cas la verrouillent une fois pour ses trois appelants ; ce que
 * chacun d'eux en fait reste testé dans sa propre suite, et aucune de leurs
 * assertions n'a eu à changer.
 *
 * Ce qui se teste ici est donc **la règle**, sans service, sans base et sans
 * horloge courante : la journée du salon arrive par `today`, ce qui rend chaque
 * cas déterministe.
 */

/** Paris, pour l'unique raison qui compte : deux décalages dans l'année. */
const PARIS = 'Europe/Paris';

/** Le référentiel du salon, figé — l'appelant, lui, le tient de son horloge. */
const SALON = { timeZone: PARIS, today: '2026-10-20' };

describe('resolveAgendaRange', () => {
  it('retombe sur la journée du salon quand aucune borne n’est donnée', () => {
    expect(resolveAgendaRange({ from: null, to: null }, SALON)).toEqual({
      from: '2026-10-20',
      to: '2026-10-20',
      timeZone: PARIS,
    });
  });

  it('complète la borne haute par la borne basse', () => {
    expect(resolveAgendaRange({ from: '2026-03-04', to: null }, SALON)).toMatchObject({
      from: '2026-03-04',
      to: '2026-03-04',
    });
  });

  it('complète la borne basse par la borne haute, jamais par aujourd’hui', () => {
    // Le contrat déclare valide une borne haute seule. Retomber sur
    // « aujourd'hui » aurait rendu 422 toute date passée — la plage aurait été
    // inversée.
    expect(resolveAgendaRange({ from: null, to: '2026-03-04' }, SALON)).toMatchObject({
      from: '2026-03-04',
      to: '2026-03-04',
    });
  });

  it('fait voyager le fuseau avec les deux bornes', () => {
    // Sans lui, « du 3 au 9 mars » ne désigne aucun intervalle : la conversion
    // en instants consomme le couple, jamais une date seule.
    expect(resolveAgendaRange({ from: '2026-03-03', to: '2026-03-09' }, SALON).timeZone).toBe(
      PARIS,
    );
  });

  it('refuse une plage inversée', () => {
    expect(() => resolveAgendaRange({ from: '2026-03-08', to: '2026-03-02' }, SALON)).toThrow(
      AppointmentRangeTooWideError,
    );
  });

  /**
   * `calendarDaysBetween` compte les jours **bornes comprises** : du 1er au
   * 31 mars fait trente et une journées, et non trente. La borne porte donc sur
   * le nombre de journées servies, ce que la vue mois d'un calendrier demande.
   */
  it(`accepte exactement ${String(MAX_APPOINTMENT_RANGE_DAYS)} journées et refuse la suivante`, () => {
    expect(resolveAgendaRange({ from: '2026-03-01', to: '2026-03-31' }, SALON)).toMatchObject({
      to: '2026-03-31',
    });

    expect(() => resolveAgendaRange({ from: '2026-03-01', to: '2026-04-01' }, SALON)).toThrow(
      AppointmentRangeTooWideError,
    );
  });

  it('refuse sur le code, le statut et les `details` que le contrat annonce', () => {
    // Le front réagit sur `code`, jamais sur `message` (api-module §5), et les
    // trois clés de `details` sont ce que les deux agendas servaient déjà : les
    // déplacer ici ne devait rien changer au fil.
    let thrown: unknown;

    try {
      resolveAgendaRange({ from: '2026-03-01', to: '2026-04-01' }, SALON);
    } catch (error: unknown) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AppointmentRangeTooWideError);
    expect(thrown).toMatchObject({
      code: APPOINTMENTS_ERROR_CODES.APPOINTMENT_RANGE_TOO_WIDE,
      status: 422,
      details: {
        from: '2026-03-01',
        to: '2026-04-01',
        maxRangeDays: MAX_APPOINTMENT_RANGE_DAYS,
      },
    });
  });

  it('refuse sur les bornes **résolues**, et non sur celles qu’on a reçues', () => {
    // Une borne haute seule, complétée par elle-même, tient toujours dans la
    // fenêtre : le refus ne doit pas se prononcer sur un `null`.
    expect(() =>
      resolveAgendaRange({ from: null, to: '1999-01-01' }, SALON),
    ).not.toThrow();
  });
});

describe('agendaWindowOf', () => {
  /** L'horloge réelle : elle ne lit rien, elle calcule (booking-engine §4). */
  const clock = new TenantClockService();

  it('borne la fenêtre de minuit du salon à minuit du salon, borne haute exclue', () => {
    // Paris est à +02:00 en octobre : le 20 commence à 22:00 UTC la veille.
    expect(agendaWindowOf({ from: '2026-10-20', to: '2026-10-20', timeZone: PARIS }, clock)).toEqual(
      {
        from: new Date('2026-10-19T22:00:00.000Z'),
        to: new Date('2026-10-20T22:00:00.000Z'),
      },
    );
  });

  it('compte 25 heures sur la journée du retour à l’heure d’hiver', () => {
    // Le 25 octobre 2026 dure vingt-cinq heures à Paris. Une addition de
    // 24 heures aurait perdu la dernière heure d'agenda de la journée.
    const window = agendaWindowOf(
      { from: '2026-10-25', to: '2026-10-25', timeZone: PARIS },
      clock,
    );

    expect(window.to.getTime() - window.from.getTime()).toBe(25 * 60 * 60_000);
  });

  it('ferme la fenêtre sur la fin du dernier jour, jamais sur le début du suivant', () => {
    // Les deux instants coïncident, mais la borne haute doit venir du jour
    // demandé : la déduire du lendemain ferait dépendre la fenêtre d'une date
    // que personne n'a demandée — et qui peut être hors plage.
    const semaine = agendaWindowOf(
      { from: '2026-03-02', to: '2026-03-08', timeZone: PARIS },
      clock,
    );

    expect(semaine.from).toEqual(clock.dayRange('2026-03-02', PARIS).startsAt);
    expect(semaine.to).toEqual(clock.dayRange('2026-03-08', PARIS).endsAt);
  });
});
