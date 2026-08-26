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
