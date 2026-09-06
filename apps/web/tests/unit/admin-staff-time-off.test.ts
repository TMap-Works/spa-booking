import type { StaffTimeOff } from '@spa/shared';
import { describe, expect, it } from 'vitest';

import {
  defaultReturnDate,
  formatTimeOff,
  formatUtcOffset,
  isFullDayTimeOff,
  localPartsOf,
  offsetDateTimeAt,
  timeOffWindow,
  validateTimeOffDraft,
  type TimeOffDraft,
} from '@/lib/admin/staff-time-off';

/**
 * Les plages bloquées et congés, côté écran (#53).
 *
 * Ce qui est vérifié ici est ce qui, mal fait, ferme un agenda au mauvais
 * moment : un fuseau deviné plutôt que celui du salon, un décalage lu la veille
 * d'un changement d'heure, une borne haute affichée comme incluse.
 */

/** Fuseau à décalage fixe — Madagascar ne change jamais d'heure. */
const TANA = 'Indian/Antananarivo';

/** Fuseau à heure d'été — c'est lui qui met la conversion à l'épreuve. */
const PARIS = 'Europe/Paris';

function timeOff(startsAt: string, endsAt: string, reason: string | null = null): StaffTimeOff {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    staffId: '22222222-2222-4222-8222-222222222222',
    startsAt,
    endsAt,
    reason,
  };
}

describe('la borne posée à partir d’une date du salon', () => {
  it('applique le décalage de l’établissement, jamais celui du navigateur', () => {
    // Une gérante en déplacement doit obtenir les mêmes bornes qu'au comptoir :
    // c'est exactement ce qu'un `new Date(...)` nu casserait.
    expect(offsetDateTimeAt('2026-08-03', '00:00', TANA)).toBe('2026-08-03T00:00:00+03:00');
  });

  it('lit le décalage à l’heure demandée, pas à minuit UTC', () => {
    // Paris est à +02:00 en août et +01:00 en janvier. Figer l'un des deux
    // décalerait l'absence d'une heure la moitié de l'année.
    expect(offsetDateTimeAt('2026-08-03', '09:00', PARIS)).toBe('2026-08-03T09:00:00+02:00');
    expect(offsetDateTimeAt('2026-01-12', '09:00', PARIS)).toBe('2026-01-12T09:00:00+01:00');
  });

  it('prend le décalage d’après la bascule pour une heure qui la suit', () => {
    // Le 29 mars 2026, Paris passe à +02:00 à 02:00 locales. À 00:00 le décalage
    // est encore +01:00, à 12:00 il est +02:00 : une seule passe de calcul —
    // celle qui lit l'heure murale comme si elle était UTC — se tromperait sur
    // l'une des deux.
    expect(offsetDateTimeAt('2026-03-29', '00:00', PARIS)).toBe('2026-03-29T00:00:00+01:00');
    expect(offsetDateTimeAt('2026-03-29', '12:00', PARIS)).toBe('2026-03-29T12:00:00+02:00');
  });

  it('écrit le décalage sous la forme qu’exige le contrat', () => {
    expect(formatUtcOffset(180)).toBe('+03:00');
    expect(formatUtcOffset(-210)).toBe('-03:30');
    expect(formatUtcOffset(0)).toBe('+00:00');
  });
});

describe('l’instant relu dans le fuseau du salon', () => {
  it('rend la date civile et l’heure murale de l’établissement', () => {
    // `2026-08-02T21:00Z` est déjà le 3 août à Antananarivo : c'est ce décalage
    // qui rend un congé « du 3 » illisible sans son fuseau.
    expect(localPartsOf('2026-08-02T21:00:00.000Z', TANA)).toEqual({
      date: '2026-08-03',
      time: '00:00',
    });
  });

  it('ne rend jamais 24:00 pour minuit', () => {
    // Certaines plateformes rendent `24` en `hour12: false` : recomposé tel
    // quel, l'horodatage serait refusé par le motif du contrat.
    expect(localPartsOf('2026-08-02T21:00:00.000Z', TANA).time).toBe('00:00');
  });
});

describe('l’absence, telle qu’elle s’écrit', () => {
  it('reconnaît un congé en journées pleines', () => {
    expect(isFullDayTimeOff(timeOff('2026-08-02T21:00:00.000Z', '2026-08-16T21:00:00.000Z'), TANA)).toBe(
      true,
    );
  });

  it('affiche le dernier jour d’absence, pas le jour de reprise', () => {
    // La borne haute est exclue : `2026-08-16T21:00Z` est minuit du 17 à
    // Antananarivo, donc un congé qui court jusqu'au **16** inclus. Écrire
    // « 17 » ferait croire à un jour de congé de plus — l'écart qu'on découvre
    // le jour où une cliente n'a pas pu réserver.
    const label = formatTimeOff(
      timeOff('2026-08-02T21:00:00.000Z', '2026-08-16T21:00:00.000Z'),
      TANA,
    );

    expect(label).toMatch(/3 août 2026/);
    expect(label).toMatch(/16 août 2026/);
    expect(label).not.toMatch(/17 août/);
  });

  it('réduit une journée unique à une seule date', () => {
    const label = formatTimeOff(
      timeOff('2026-08-02T21:00:00.000Z', '2026-08-03T21:00:00.000Z'),
      TANA,
    );

    expect(label).toMatch(/^3 août 2026$/);
  });

  it('garde les heures d’une plage bloquée d’un après-midi', () => {
    const label = formatTimeOff(
      timeOff('2026-10-03T06:00:00.000Z', '2026-10-03T09:00:00.000Z'),
      TANA,
    );

    expect(label).toMatch(/09:00 – 12:00/);
  });
});

describe('la fenêtre du planning', () => {
  it('part de minuit du jour demandé, jamais de « maintenant »', () => {
    // Sans quoi un congé commencé ce matin disparaîtrait de l'écran à midi.
    expect(timeOffWindow('2026-09-06', 180, TANA)).toEqual({
      from: '2026-09-06T00:00:00+03:00',
      to: '2027-03-05T00:00:00+03:00',
    });
  });

  it('borne la fenêtre à ce que l’API accepte', () => {
    // Au-delà d'un an, l'API refuse en 422 : élargir ici ne ferait qu'échouer
    // plus loin.
    const window = timeOffWindow('2026-09-06', 5_000, TANA);

    expect(window.to.slice(0, 10) <= '2027-09-07').toBe(true);
  });
});

describe('la saisie, jugée avant l’appel', () => {
  const base: Omit<TimeOffDraft, 'staffId'> = {
    fromDate: '2026-08-03',
    fromTime: '',
    toDate: '2026-08-17',
    toTime: '',
    reason: 'Congés annuels',
  };
  const STAFF = '22222222-2222-4222-8222-222222222222';

  it('convertit une saisie de journées pleines en instants UTC', () => {
    const verdict = validateTimeOffDraft({ ...base, staffId: STAFF }, TANA);

    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      // Le schéma partagé normalise en UTC à la frontière : minuit à
      // Antananarivo vaut 21:00 la veille.
      expect(verdict.request.startsAt).toBe('2026-08-02T21:00:00.000Z');
      expect(verdict.request.endsAt).toBe('2026-08-16T21:00:00.000Z');
      expect(verdict.request.reason).toBe('Congés annuels');
    }
  });

  it('n’envoie pas de motif quand le champ est vide', () => {
    // « Absent » et « chaîne vide » ne disent pas la même chose : le second
    // occuperait la colonne d'un motif que personne n'a écrit.
    const verdict = validateTimeOffDraft({ ...base, reason: '   ', staffId: STAFF }, TANA);

    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.request.reason).toBeUndefined();
    }
  });

  it('réclame le premier jour avant tout le reste', () => {
    const verdict = validateTimeOffDraft({ ...base, fromDate: '', staffId: STAFF }, TANA);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.field).toBe('fromDate');
    }
  });

  it('refuse un intervalle qui recule, en désignant le jour de reprise', () => {
    const verdict = validateTimeOffDraft(
      { ...base, fromDate: '2026-08-17', toDate: '2026-08-03', staffId: STAFF },
      TANA,
    );

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) {
      expect(verdict.field).toBe('toDate');
    }
  });

  it('refuse une absence de plus d’un an', () => {
    const verdict = validateTimeOffDraft(
      { ...base, fromDate: '2026-08-03', toDate: '2028-08-03', staffId: STAFF },
      TANA,
    );

    expect(verdict.ok).toBe(false);
  });

  it('propose le lendemain comme jour de reprise', () => {
    // La borne haute étant exclue, c'est ainsi que s'écrit « un jour de congé ».
    expect(defaultReturnDate('2026-08-03')).toBe('2026-08-04');
  });
});
