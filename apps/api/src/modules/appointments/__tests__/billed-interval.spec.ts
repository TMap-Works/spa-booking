import { billedIntervalOf, billedStartOf } from '../billed-interval';

/**
 * La conversion « intervalle occupé → intervalle facturé » — booking-engine §3,
 * étape 5.
 *
 * Elle était jusqu'à #750 enfouie dans `appointments.service.ts`, où seul
 * l'agenda pouvait l'appeler. Ces cas la verrouillent pour ses deux appelants :
 * la vue publique et l'agenda d'`appointments`, l'historique et l'export du
 * `crm`. Ce que chacun d'eux en fait se teste dans sa propre suite ; ce qui se
 * teste ici est **la règle**, une fois.
 */

const OCCUPE = new Date('2026-09-16T13:00:00.000Z');

describe('billedStartOf', () => {
  it('décale le début de la ligne du tampon de préparation', () => {
    // Le cas de la fiche d'Alice Marchand (#750) : la ligne commence à 13:00
    // UTC, le soin à 13:10 — c'est 13:10 que la cliente a réservé.
    expect(billedStartOf({ startsAt: OCCUPE }, { durationMinutes: 60, bufferBeforeMinutes: 10 })).toBe(
      new Date('2026-09-16T13:10:00.000Z').getTime(),
    );
  });

  it('rend le début de la ligne quand la prestation n’a pas de tampon avant', () => {
    // La majorité du catalogue : les deux intervalles coïncident, et c'est
    // pourquoi l'écart de #750 est resté invisible aussi longtemps.
    expect(billedStartOf({ startsAt: OCCUPE }, { durationMinutes: 60, bufferBeforeMinutes: 0 })).toBe(
      OCCUPE.getTime(),
    );
  });
});

describe('billedIntervalOf', () => {
  it('encadre la seule durée du soin, tampons exclus', () => {
    expect(
      billedIntervalOf({ startsAt: OCCUPE }, { durationMinutes: 60, bufferBeforeMinutes: 10 }),
    ).toEqual({
      startsAt: new Date('2026-09-16T13:10:00.000Z'),
      endsAt: new Date('2026-09-16T14:10:00.000Z'),
    });
  });

  it('ne déduit jamais la fin de l’`ends_at` de la ligne', () => {
    // La ligne occupe 13:00 → 14:20 (10 + 60 + 10). Le soin, lui, va de 13:10 à
    // 14:10 : afficher 14:20 annoncerait à la cliente une séance de 80 minutes
    // qu'elle n'a ni réservée ni payée.
    const { endsAt } = billedIntervalOf(
      { startsAt: OCCUPE },
      { durationMinutes: 60, bufferBeforeMinutes: 10 },
    );

    expect(endsAt).not.toEqual(new Date('2026-09-16T14:20:00.000Z'));
  });

  it('ne renvoie pas l’instance de `Date` qu’on lui a passée', () => {
    // Les deux bornes sont des `Date` neuves : un appelant qui muterait celle
    // qu'il a rendue — ou celle qu'il a passée — ne toucherait pas l'autre.
    const record = { startsAt: new Date(OCCUPE) };

    const { startsAt } = billedIntervalOf(record, { durationMinutes: 60, bufferBeforeMinutes: 0 });

    expect(startsAt).not.toBe(record.startsAt);
    expect(startsAt).toEqual(record.startsAt);
  });
});
