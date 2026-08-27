/**
 * Instants et dates civiles — « tout est stocké en UTC » (CLAUDE.md).
 *
 * Le cas qui compte vraiment est le dernier : un décalage horaire accepté en
 * entrée, ou un intervalle vide laissé passer, sont les deux façons connues de
 * décaler un agenda d'un jour ou de faire chevaucher deux rendez-vous.
 */

import {
  addMinutes,
  calendarDateSchema,
  calendarDaysBetween,
  durationMinutesSchema,
  fromUtcInstant,
  isOffsetDateTime,
  localTimeSchema,
  localTimeToMinutes,
  minutesToLocalTime,
  offsetDateTimeSchema,
  timeZoneSchema,
  toUtcInstant,
  utcInstantSchema,
  utcIntervalSchema,
} from '../common/time';

describe('instants UTC', () => {
  it('accepte un instant ISO 8601 suffixé Z', () => {
    expect(utcInstantSchema.parse('2026-03-03T10:00:00Z')).toBe('2026-03-03T10:00:00Z');
  });

  it('refuse un instant porteur d’un décalage horaire', () => {
    expect(utcInstantSchema.safeParse('2026-03-03T10:00:00+01:00').success).toBe(false);
    expect(utcInstantSchema.safeParse('2026-03-03T10:00:00').success).toBe(false);
  });

  it('fait l’aller-retour Date ↔ instant sans perte', () => {
    const date = new Date('2026-03-03T10:00:00.000Z');

    expect(fromUtcInstant(toUtcInstant(date)).getTime()).toBe(date.getTime());
  });

  it('dérive une fin de rendez-vous d’une durée en minutes', () => {
    expect(addMinutes('2026-03-03T10:00:00.000Z', 45)).toBe('2026-03-03T10:45:00.000Z');
  });

  it('franchit correctement un changement d’heure européen', () => {
    // 2026-03-29 02:00 Europe/Paris : le passage à l'heure d'été. En UTC, rien
    // ne se passe — c'est précisément la propriété qu'on veut préserver.
    expect(addMinutes('2026-03-29T00:30:00.000Z', 60)).toBe('2026-03-29T01:30:00.000Z');
  });
});

describe('dates-heures entrantes', () => {
  it('accepte un offset explicite et le normalise en UTC', () => {
    // La dissymétrie voulue avec `utcInstantSchema` : en entrée l'API accepte
    // un décalage, et le convertit à la frontière plutôt que de laisser le
    // client le faire avec le fuseau de son navigateur.
    expect(offsetDateTimeSchema.parse('2026-03-29T03:30:00+02:00')).toBe(
      '2026-03-29T01:30:00.000Z',
    );
    expect(offsetDateTimeSchema.parse('2026-03-29T01:30:00Z')).toBe('2026-03-29T01:30:00.000Z');
    expect(offsetDateTimeSchema.parse('2026-03-28T15:30:00-10:00')).toBe(
      '2026-03-29T01:30:00.000Z',
    );
  });

  it('refuse une date-heure nue — trois fuseaux possibles, donc aucun', () => {
    expect(offsetDateTimeSchema.safeParse('2026-03-29T03:30:00').success).toBe(false);
    expect(offsetDateTimeSchema.safeParse('2026-03-29').success).toBe(false);
    expect(offsetDateTimeSchema.safeParse('1774743000').success).toBe(false);
  });

  it('refuse un offset syntaxiquement faux', () => {
    expect(isOffsetDateTime('2026-03-29T03:30:00+2:00')).toBe(false);
    expect(isOffsetDateTime('2026-03-29T03:30:00+0200')).toBe(false);
    expect(isOffsetDateTime('2026-03-29 03:30:00Z')).toBe(false);
    expect(isOffsetDateTime('2026-03-29T03:30:00+24:00')).toBe(false);
  });

  it('refuse une heure hors de la journée, plutôt que de la reporter au lendemain', () => {
    // `24:00` n'est pas du RFC 3339, et `Date.parse` le ramènerait au 30 mars :
    // un rendez-vous déplacé d'un jour sans qu'aucune erreur ne le dise.
    expect(isOffsetDateTime('2026-03-29T24:00:00Z')).toBe(false);
    expect(isOffsetDateTime('2026-03-29T24:00Z')).toBe(false);
    expect(isOffsetDateTime('2026-03-29T19:60:00Z')).toBe(false);
    expect(isOffsetDateTime('2026-03-29T19:30:60Z')).toBe(false);
  });

  it('refuse une date bien formée mais inexistante au calendrier', () => {
    // `Date.parse` ramènerait le 31 février au 3 mars sans rien signaler.
    expect(isOffsetDateTime('2026-02-31T10:00:00Z')).toBe(false);
    expect(isOffsetDateTime('2026-02-29T10:00:00Z')).toBe(false);
    expect(isOffsetDateTime('2028-02-29T10:00:00Z')).toBe(true);
  });

  it('tolère l’absence de secondes et une fraction, comme la RFC 3339', () => {
    expect(offsetDateTimeSchema.parse('2026-03-29T01:30Z')).toBe('2026-03-29T01:30:00.000Z');
    expect(offsetDateTimeSchema.parse('2026-03-29T01:30:00.500Z')).toBe(
      '2026-03-29T01:30:00.500Z',
    );
  });
});

describe('heures murales', () => {
  it('accepte HH:MM sur les vingt-quatre heures', () => {
    expect(localTimeSchema.parse('00:00')).toBe('00:00');
    expect(localTimeSchema.parse('23:59')).toBe('23:59');
  });

  it('refuse ce qui n’est pas une heure de la journée', () => {
    expect(localTimeSchema.safeParse('9:00').success).toBe(false);
    expect(localTimeSchema.safeParse('24:00').success).toBe(false);
    expect(localTimeSchema.safeParse('09:60').success).toBe(false);
    expect(localTimeSchema.safeParse('09:00:00').success).toBe(false);
  });

  it('fait l’aller-retour avec les minutes depuis minuit', () => {
    expect(localTimeToMinutes('09:30')).toBe(570);
    expect(minutesToLocalTime(570)).toBe('09:30');
    expect(minutesToLocalTime(0)).toBe('00:00');
    expect(minutesToLocalTime(1439)).toBe('23:59');
  });

  it('refuse de sortir de la journée civile', () => {
    // Une fenêtre qui déborde sur le lendemain se décrit par deux plages, pas
    // par un « 25:30 » que rien ne saurait afficher.
    expect(() => minutesToLocalTime(1440)).toThrow(RangeError);
    expect(() => minutesToLocalTime(-1)).toThrow(RangeError);
    expect(() => minutesToLocalTime(90.5)).toThrow(RangeError);
  });

  it('n’est pas un instant : elle ne porte ni date ni fuseau', () => {
    // La conversion en instant demande une date **et** un fuseau, et n'est pas
    // toujours définie — c'est le moteur du module `availability` (#41) qui la
    // fait, pas le contrat.
    expect(utcInstantSchema.safeParse('09:00').success).toBe(false);
  });
});

describe('dates civiles', () => {
  it('accepte une date réelle', () => {
    expect(calendarDateSchema.parse('2026-03-03')).toBe('2026-03-03');
    expect(calendarDateSchema.safeParse('2028-02-29').success).toBe(true);
  });

  it('refuse une date bien formée mais inexistante', () => {
    expect(calendarDateSchema.safeParse('2026-02-31').success).toBe(false);
    expect(calendarDateSchema.safeParse('2026-02-29').success).toBe(false);
    expect(calendarDateSchema.safeParse('2026-13-01').success).toBe(false);
  });

  it('refuse un format qui n’est pas YYYY-MM-DD', () => {
    expect(calendarDateSchema.safeParse('03/03/2026').success).toBe(false);
    expect(calendarDateSchema.safeParse('2026-3-3').success).toBe(false);
  });

  it('compte les journées bornes comprises', () => {
    expect(calendarDaysBetween('2026-03-03', '2026-03-03')).toBe(1);
    expect(calendarDaysBetween('2026-03-01', '2026-03-31')).toBe(31);
  });

  it('compte juste en travers d’un changement d’heure', () => {
    // Du 28 au 30 mars 2026 : trois jours civils, quand bien même l'un d'eux ne
    // dure que 23 heures en heure locale française.
    expect(calendarDaysBetween('2026-03-28', '2026-03-30')).toBe(3);
  });
});

describe('fuseaux et durées', () => {
  it('accepte un identifiant IANA connu et refuse le reste', () => {
    expect(timeZoneSchema.safeParse('Europe/Paris').success).toBe(true);
    expect(timeZoneSchema.safeParse('Pacific/Tahiti').success).toBe(true);
    expect(timeZoneSchema.safeParse('Europe/Atlantis').success).toBe(false);
    expect(timeZoneSchema.safeParse('').success).toBe(false);
  });

  it('refuse une durée nulle, négative ou fractionnaire', () => {
    expect(durationMinutesSchema.safeParse(30).success).toBe(true);
    expect(durationMinutesSchema.safeParse(0).success).toBe(false);
    expect(durationMinutesSchema.safeParse(-15).success).toBe(false);
    expect(durationMinutesSchema.safeParse(15.5).success).toBe(false);
  });
});

describe('intervalles UTC', () => {
  it('accepte un intervalle non vide', () => {
    const parsed = utcIntervalSchema.safeParse({
      startsAt: '2026-03-03T10:00:00Z',
      endsAt: '2026-03-03T10:45:00Z',
    });

    expect(parsed.success).toBe(true);
  });

  it('refuse un intervalle vide — il passerait sous la contrainte d’exclusion', () => {
    const parsed = utcIntervalSchema.safeParse({
      startsAt: '2026-03-03T10:00:00Z',
      endsAt: '2026-03-03T10:00:00Z',
    });

    expect(parsed.success).toBe(false);
  });

  it('refuse un intervalle inversé', () => {
    const parsed = utcIntervalSchema.safeParse({
      startsAt: '2026-03-03T11:00:00Z',
      endsAt: '2026-03-03T10:00:00Z',
    });

    expect(parsed.success).toBe(false);
  });
});
