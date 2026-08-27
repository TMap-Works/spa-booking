/**
 * Moteur de conversion heure locale ↔ UTC (#41) — les propriétés ordinaires.
 *
 * Les deux nuits de changement d'heure ont leur suite dédiée
 * (`dst-booking.spec.ts`) : c'est le critère d'acceptation de l'issue et il
 * mérite d'être lisible seul. Ici, tout le reste — l'aller-retour, les bornes de
 * journée, le format de sortie, et les entrées mal formées.
 */

import {
  formatOffset,
  formatOffsetDateTime,
  offsetMinutesAt,
  resolveZonedWallTime,
  utcToZonedWallTime,
  zonedDateTimeToUtc,
  zonedDayLengthMinutes,
  zonedDayRange,
  zonedWallTimeToUtc,
} from '../availability.time';

const PARIS = 'Europe/Paris';
const TAHITI = 'Pacific/Tahiti'; // UTC-10, sans heure d'été
const KATHMANDU = 'Asia/Kathmandu'; // UTC+05:45, l'offset non entier en heures

describe('heure murale d’un instant', () => {
  it('rend les composants tels que les affiche l’horloge du salon', () => {
    expect(utcToZonedWallTime(new Date('2026-07-15T07:00:00Z'), PARIS)).toEqual({
      year: 2026,
      month: 7,
      day: 15,
      hour: 9,
      minute: 0,
      second: 0,
    });
  });

  it('franchit minuit local sans changer de jour par erreur', () => {
    // Le piège de `hour12: false`, qui rend « 24 » pour minuit sur plusieurs
    // versions d'ICU : la date en sortirait décalée d'un jour.
    expect(utcToZonedWallTime(new Date('2026-07-14T22:00:00Z'), PARIS)).toMatchObject({
      day: 15,
      hour: 0,
    });
  });

  it('rend la veille pour un fuseau très à l’ouest', () => {
    expect(utcToZonedWallTime(new Date('2026-07-15T05:00:00Z'), TAHITI)).toMatchObject({
      day: 14,
      hour: 19,
    });
  });
});

describe('décalage à un instant donné', () => {
  it('rend des minutes signées', () => {
    expect(offsetMinutesAt(new Date('2026-07-15T09:00:00Z'), PARIS)).toBe(120);
    expect(offsetMinutesAt(new Date('2026-07-15T09:00:00Z'), TAHITI)).toBe(-600);
    expect(offsetMinutesAt(new Date('2026-07-15T09:00:00Z'), 'UTC')).toBe(0);
  });

  it('rend un décalage non entier en heures là où le fuseau en a un', () => {
    expect(offsetMinutesAt(new Date('2026-07-15T09:00:00Z'), KATHMANDU)).toBe(345);
  });

  it('ne se laisse pas troubler par les millisecondes', () => {
    // Le formateur ICU ne les voit pas ; les inclure dans la soustraction ferait
    // apparaître un décalage fractionnaire là où il n'y en a aucun.
    expect(offsetMinutesAt(new Date('2026-07-15T09:00:00.789Z'), PARIS)).toBe(120);
  });
});

describe('heure murale → instant', () => {
  it('fait l’aller-retour sans perte hors transition', () => {
    const instant = zonedWallTimeToUtc(
      { year: 2026, month: 7, day: 15, hour: 9, minute: 30, second: 0 },
      PARIS,
    );

    expect(instant.toISOString()).toBe('2026-07-15T07:30:00.000Z');
    expect(utcToZonedWallTime(instant, PARIS)).toMatchObject({ hour: 9, minute: 30 });
  });

  it('qualifie la résolution ordinaire d’exacte, avec son offset', () => {
    const resolved = resolveZonedWallTime(
      { year: 2026, month: 1, day: 15, hour: 9, minute: 0, second: 0 },
      PARIS,
    );

    expect(resolved).toMatchObject({ kind: 'exact', offsetMinutes: 60 });
  });

  it('accepte le couple date civile + HH:MM', () => {
    expect(zonedDateTimeToUtc('2026-07-15', '09:30', PARIS).instant.toISOString()).toBe(
      '2026-07-15T07:30:00.000Z',
    );
  });

  it('refuse une date ou une heure mal formée par un défaut de programmation', () => {
    // `RangeError` et non erreur de domaine : le DTO aurait refusé en 400 bien
    // avant, et un `NaN` propagé se manifesterait trois couches plus loin.
    expect(() => zonedDateTimeToUtc('15/07/2026', '09:30', PARIS)).toThrow(RangeError);
    expect(() => zonedDateTimeToUtc('2026-07-15', '9:30', PARIS)).toThrow(RangeError);
    expect(() => zonedDateTimeToUtc('2026-07-15', '24:00', PARIS)).toThrow(RangeError);
  });
});

describe('bornes d’une journée civile du tenant', () => {
  it('borne une journée ordinaire à 24 heures, borne haute exclue', () => {
    const { startsAt, endsAt } = zonedDayRange('2026-07-15', PARIS);

    expect(startsAt.toISOString()).toBe('2026-07-14T22:00:00.000Z');
    expect(endsAt.toISOString()).toBe('2026-07-15T22:00:00.000Z');
    expect(zonedDayLengthMinutes('2026-07-15', PARIS)).toBe(1440);
  });

  it('passe au mois suivant en fin de mois', () => {
    expect(zonedDayRange('2026-07-31', PARIS).endsAt.toISOString()).toBe(
      '2026-07-31T22:00:00.000Z',
    );
  });

  it('connaît le 29 février d’une année bissextile', () => {
    expect(zonedDayRange('2028-02-28', PARIS).endsAt.toISOString()).toBe(
      '2028-02-28T23:00:00.000Z',
    );
    expect(zonedDayLengthMinutes('2028-02-29', PARIS)).toBe(1440);
  });

  it('passe à l’année suivante au 31 décembre', () => {
    expect(zonedDayRange('2026-12-31', PARIS).endsAt.toISOString()).toBe(
      '2026-12-31T23:00:00.000Z',
    );
  });
});

describe('sortie ISO 8601 avec offset explicite', () => {
  it('note l’offset du fuseau, jamais l’heure murale nue', () => {
    expect(formatOffsetDateTime(new Date('2026-07-15T07:30:00Z'), PARIS)).toBe(
      '2026-07-15T09:30:00+02:00',
    );
    expect(formatOffsetDateTime(new Date('2026-01-15T08:30:00Z'), PARIS)).toBe(
      '2026-01-15T09:30:00+01:00',
    );
  });

  it('note « Z » pour un fuseau à décalage nul', () => {
    expect(formatOffsetDateTime(new Date('2026-07-15T09:30:00Z'), 'UTC')).toBe(
      '2026-07-15T09:30:00Z',
    );
  });

  it('note un offset négatif et un offset à minutes non nulles', () => {
    expect(formatOffset(-600)).toBe('-10:00');
    expect(formatOffset(345)).toBe('+05:45');
    expect(formatOffsetDateTime(new Date('2026-07-15T09:00:00Z'), KATHMANDU)).toBe(
      '2026-07-15T14:45:00+05:45',
    );
  });

  it('rend une chaîne que le moteur relit sur le même instant', () => {
    const instant = new Date('2026-10-25T00:30:00Z');

    expect(Date.parse(formatOffsetDateTime(instant, PARIS))).toBe(instant.getTime());
  });
});
