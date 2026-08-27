/**
 * Réservation la nuit du changement d'heure — **dans les deux sens** (#41).
 *
 * C'est le test que l'issue nomme explicitement, et le seul qui distingue une
 * conversion correcte d'une conversion plausible. Les deux nuits n'ont rien de
 * symétrique :
 *
 * | Nuit | `Europe/Paris` | Ce qui casse sans elle |
 * |---|---|---|
 * | Printemps | 2026-03-29, 02:00 → 03:00 | `02:30` n'existe pas ; un offset figé la convertit quand même, et le client arrive une heure trop tôt |
 * | Automne | 2026-10-25, 03:00 → 02:00 | `02:30` a lieu deux fois ; la journée dure 25 h et un agenda calculé sur 24 h perd une heure de créneaux |
 *
 * Deux propriétés se vérifient ici et nulle part ailleurs :
 *
 * 1. **La durée d'un rendez-vous est une durée réelle.** Un soin de 60 minutes
 *    dure 60 minutes, y compris quand l'horloge murale saute de 02:00 à 03:00
 *    pendant qu'il se déroule. C'est la conséquence directe du stockage en UTC,
 *    et elle se perd dès qu'on calcule une fin en heure locale.
 * 2. **Aucun décalage n'est figé.** La même heure murale, prise en janvier et en
 *    juillet, ne donne pas le même offset — et le moteur le recalcule à chaque
 *    fois plutôt que de le mémoriser sur le tenant.
 *
 * Un fuseau de l'hémisphère sud (`Pacific/Auckland`) double chaque cas : les
 * transitions y sont inversées dans le calendrier, ce qui attrape tout code qui
 * aurait supposé « mars = avance, octobre = recul ».
 */

import {
  AmbiguousLocalTimeError,
  NonExistentLocalTimeError,
} from '../availability.errors';
import {
  formatOffsetDateTime,
  offsetMinutesAt,
  resolveZonedWallTime,
  zonedDateTimeToUtc,
  zonedDayLengthMinutes,
  zonedDayRange,
} from '../availability.time';
import { TenantClockService } from '../tenant-clock.service';

const PARIS = 'Europe/Paris';
const AUCKLAND = 'Pacific/Auckland';

/** Nuits de transition 2026, telles que les publie la tzdata. */
const SPRING_FORWARD = '2026-03-29'; // Paris : 02:00 → 03:00
const FALL_BACK = '2026-10-25'; // Paris : 03:00 → 02:00

const clock = new TenantClockService();

/** Fin d'un rendez-vous : une addition sur la ligne du temps, jamais sur l'horloge. */
function endOf(startsAt: Date, durationMinutes: number): Date {
  return new Date(startsAt.getTime() + durationMinutes * 60_000);
}

describe('printemps — la nuit où une heure n’existe pas', () => {
  it('sait qu’il est 02:30 nulle part ce jour-là à Paris', () => {
    const resolved = zonedDateTimeToUtc(SPRING_FORWARD, '02:30', PARIS);

    expect(resolved.kind).toBe('skipped');
    // L'heure demandée est reportée à la sortie du trou : 02:30 → 03:30.
    expect(formatOffsetDateTime(resolved.instant, PARIS)).toBe('2026-03-29T03:30:00+02:00');
    expect(resolved.instant.toISOString()).toBe('2026-03-29T01:30:00.000Z');
  });

  it('refuse de poser un rendez-vous sur une heure qui n’a pas eu lieu', () => {
    expect(() => clock.requireExactInstant(SPRING_FORWARD, '02:30', PARIS)).toThrow(
      NonExistentLocalTimeError,
    );

    try {
      clock.requireExactInstant(SPRING_FORWARD, '02:30', PARIS);
      throw new Error('l’heure inexistante aurait dû être refusée');
    } catch (error) {
      const refusal = error as NonExistentLocalTimeError;

      expect(refusal.code).toBe('NON_EXISTENT_LOCAL_TIME');
      expect(refusal.status).toBe(422);
      // Le front a de quoi proposer un repli plutôt qu'un message d'échec sec.
      expect(refusal.details).toMatchObject({
        localDateTime: '2026-03-29T02:30',
        timeZone: PARIS,
        shiftedTo: '2026-03-29T03:30:00+02:00',
        gapMinutes: 60,
      });
    }
  });

  it('laisse passer les heures qui encadrent le trou', () => {
    expect(clock.requireExactInstant(SPRING_FORWARD, '01:30', PARIS).toISOString()).toBe(
      '2026-03-29T00:30:00.000Z',
    );
    expect(clock.requireExactInstant(SPRING_FORWARD, '03:30', PARIS).toISOString()).toBe(
      '2026-03-29T01:30:00.000Z',
    );
  });

  it('tient la durée réelle d’un soin qui traverse le saut d’horloge', () => {
    // Départ 01:30 locale (00:30Z), soin de 60 minutes. L'horloge du salon
    // affichera 03:30 à la fin : deux heures de plus au mur, une seule vécue.
    const startsAt = clock.requireExactInstant(SPRING_FORWARD, '01:30', PARIS);
    const endsAt = endOf(startsAt, 60);

    expect(endsAt.getTime() - startsAt.getTime()).toBe(60 * 60_000);
    expect(formatOffsetDateTime(startsAt, PARIS)).toBe('2026-03-29T01:30:00+01:00');
    expect(formatOffsetDateTime(endsAt, PARIS)).toBe('2026-03-29T03:30:00+02:00');
  });

  it('compte 23 heures à la journée civile qui perd une heure', () => {
    expect(zonedDayLengthMinutes(SPRING_FORWARD, PARIS)).toBe(23 * 60);

    const { startsAt, endsAt } = zonedDayRange(SPRING_FORWARD, PARIS);

    expect(startsAt.toISOString()).toBe('2026-03-28T23:00:00.000Z');
    expect(endsAt.toISOString()).toBe('2026-03-29T22:00:00.000Z');
  });

  it('trouve la même anomalie à Auckland, six mois plus tôt dans l’année', () => {
    // Hémisphère sud : l'avance d'horloge a lieu fin septembre.
    const resolved = zonedDateTimeToUtc('2026-09-27', '02:30', AUCKLAND);

    expect(resolved.kind).toBe('skipped');
    expect(formatOffsetDateTime(resolved.instant, AUCKLAND)).toBe('2026-09-27T03:30:00+13:00');
  });
});

describe('automne — la nuit où une heure a lieu deux fois', () => {
  it('rend les deux occurrences de 02:30 à Paris', () => {
    const resolved = zonedDateTimeToUtc(FALL_BACK, '02:30', PARIS);

    expect(resolved.kind).toBe('ambiguous');

    if (resolved.kind !== 'ambiguous') {
      throw new Error('résolution ambiguë attendue');
    }

    // La première occurrence est encore à l'heure d'été (+02:00), la seconde à
    // l'heure d'hiver (+01:00). Une heure d'écart réelle, la même au mur.
    expect(resolved.instant.toISOString()).toBe('2026-10-25T00:30:00.000Z');
    expect(resolved.alternative.toISOString()).toBe('2026-10-25T01:30:00.000Z');
    expect(resolved.offsetMinutes).toBe(120);
    expect(resolved.alternativeOffsetMinutes).toBe(60);
    expect(resolved.alternative.getTime() - resolved.instant.getTime()).toBe(60 * 60_000);
  });

  it('refuse de choisir seul entre les deux occurrences', () => {
    expect(() => clock.requireExactInstant(FALL_BACK, '02:30', PARIS)).toThrow(
      AmbiguousLocalTimeError,
    );

    try {
      clock.requireExactInstant(FALL_BACK, '02:30', PARIS);
      throw new Error('l’heure ambiguë aurait dû être refusée');
    } catch (error) {
      const refusal = error as AmbiguousLocalTimeError;

      expect(refusal.code).toBe('AMBIGUOUS_LOCAL_TIME');
      expect(refusal.status).toBe(422);
      expect(refusal.details).toMatchObject({
        firstOccurrence: '2026-10-25T02:30:00+02:00',
        secondOccurrence: '2026-10-25T02:30:00+01:00',
      });
    }
  });

  it('tient la durée réelle d’un soin qui traverse le recul d’horloge', () => {
    // Départ à la première occurrence de 02:30 (00:30Z), soin de 60 minutes.
    // L'horloge du salon affichera de nouveau 02:30 à la fin.
    const resolved = zonedDateTimeToUtc(FALL_BACK, '02:30', PARIS);
    const endsAt = endOf(resolved.instant, 60);

    expect(endsAt.getTime() - resolved.instant.getTime()).toBe(60 * 60_000);
    expect(formatOffsetDateTime(resolved.instant, PARIS)).toBe('2026-10-25T02:30:00+02:00');
    expect(formatOffsetDateTime(endsAt, PARIS)).toBe('2026-10-25T02:30:00+01:00');
    // Deux rendez-vous distincts, la même heure au mur : c'est l'instant UTC —
    // et lui seul — qui les sépare, y compris pour la contrainte d'exclusion.
    expect(resolved.instant.toISOString()).not.toBe(endsAt.toISOString());
  });

  it('compte 25 heures à la journée civile qui gagne une heure', () => {
    expect(zonedDayLengthMinutes(FALL_BACK, PARIS)).toBe(25 * 60);

    const { startsAt, endsAt } = zonedDayRange(FALL_BACK, PARIS);

    expect(startsAt.toISOString()).toBe('2026-10-24T22:00:00.000Z');
    expect(endsAt.toISOString()).toBe('2026-10-25T23:00:00.000Z');
  });

  it('trouve la même ambiguïté à Auckland, six mois plus tôt dans l’année', () => {
    // Hémisphère sud : le recul d'horloge a lieu début avril.
    const resolved = resolveZonedWallTime(
      { year: 2026, month: 4, day: 5, hour: 2, minute: 30, second: 0 },
      AUCKLAND,
    );

    expect(resolved.kind).toBe('ambiguous');
  });
});

describe('aucun décalage figé', () => {
  it('rend un offset différent pour la même heure murale selon la saison', () => {
    const winter = clock.requireExactInstant('2026-01-15', '09:00', PARIS);
    const summer = clock.requireExactInstant('2026-07-15', '09:00', PARIS);

    expect(winter.toISOString()).toBe('2026-01-15T08:00:00.000Z');
    expect(summer.toISOString()).toBe('2026-07-15T07:00:00.000Z');

    expect(clock.offsetMinutesAt(winter, PARIS)).toBe(60);
    expect(clock.offsetMinutesAt(summer, PARIS)).toBe(120);
  });

  it('applique les règles de l’année considérée, pas celles d’aujourd’hui', () => {
    // La Russie a supprimé l'heure d'été en 2011. Un offset mémorisé une fois
    // pour toutes relirait de travers tout l'historique d'avant.
    expect(offsetMinutesAt(new Date('2010-07-15T00:00:00Z'), 'Europe/Moscow')).toBe(240);
    expect(offsetMinutesAt(new Date('2026-07-15T00:00:00Z'), 'Europe/Moscow')).toBe(180);
  });

  it('n’invente aucune transition dans un fuseau qui n’en a pas', () => {
    const january = offsetMinutesAt(new Date('2026-01-15T09:00:00Z'), 'Indian/Antananarivo');
    const july = offsetMinutesAt(new Date('2026-07-15T09:00:00Z'), 'Indian/Antananarivo');

    expect(january).toBe(180);
    expect(july).toBe(180);
    expect(zonedDayLengthMinutes(SPRING_FORWARD, 'Indian/Antananarivo')).toBe(24 * 60);
  });

  it('traite un saut d’horloge d’une demi-heure comme les autres', () => {
    // Lord Howe avance de 30 minutes, pas de 60. Toute logique qui aurait codé
    // « une heure » en dur échoue ici.
    const resolved = zonedDateTimeToUtc('2026-10-04', '02:15', 'Australia/Lord_Howe');

    expect(resolved.kind).toBe('skipped');

    if (resolved.kind !== 'skipped') {
      throw new Error('trou d’horloge attendu');
    }

    expect(resolved.gapMinutes).toBe(30);
  });
});
