import { mergeRanges, rangesOverlap, subtractRanges } from '../availability.intervals';
import type { UtcRange } from '../availability.time';

/**
 * Algèbre d'intervalles — le calcul qui fait qu'« un praticien absent
 * n'apparaît dans aucun créneau » (#33, critère 3).
 *
 * Logique pure : aucune base, aucun fuseau. Ce sont des instants, et deux
 * instants se comparent sans rien savoir du calendrier — c'est précisément ce
 * qui rend un congé traversant un changement d'heure sans particularité ici.
 */

/** `[startsAt, endsAt[` depuis deux instants ISO — lisible dans les assertions. */
function range(startsAt: string, endsAt: string): UtcRange {
  return { startsAt: new Date(startsAt), endsAt: new Date(endsAt) };
}

/** Forme comparable d'un résultat : deux chaînes plutôt que deux `Date`. */
function readable(ranges: readonly UtcRange[]): string[] {
  return ranges.map((one) => `${one.startsAt.toISOString()}/${one.endsAt.toISOString()}`);
}

const D = '2026-08-03T';

describe('mergeRanges', () => {
  it('trie et fusionne les intervalles qui se chevauchent', () => {
    const merged = mergeRanges([
      range(`${D}11:00:00Z`, `${D}13:00:00Z`),
      range(`${D}09:00:00Z`, `${D}12:00:00Z`),
    ]);

    expect(readable(merged)).toEqual([`${D}09:00:00.000Z/${D}13:00:00.000Z`]);
  });

  it('recolle les intervalles adjacents', () => {
    // Sans cette fusion, il resterait entre eux une fenêtre libre de durée
    // nulle : un créneau que le découpage ne saurait pas ignorer.
    const merged = mergeRanges([
      range(`${D}09:00:00Z`, `${D}12:00:00Z`),
      range(`${D}12:00:00Z`, `${D}14:00:00Z`),
    ]);

    expect(readable(merged)).toEqual([`${D}09:00:00.000Z/${D}14:00:00.000Z`]);
  });

  it('laisse séparés deux intervalles disjoints', () => {
    const merged = mergeRanges([
      range(`${D}14:00:00Z`, `${D}15:00:00Z`),
      range(`${D}09:00:00Z`, `${D}10:00:00Z`),
    ]);

    expect(readable(merged)).toEqual([
      `${D}09:00:00.000Z/${D}10:00:00.000Z`,
      `${D}14:00:00.000Z/${D}15:00:00.000Z`,
    ]);
  });

  it('absorbe un intervalle entièrement contenu dans un autre', () => {
    const merged = mergeRanges([
      range(`${D}09:00:00Z`, `${D}18:00:00Z`),
      range(`${D}12:00:00Z`, `${D}13:00:00Z`),
    ]);

    expect(readable(merged)).toEqual([`${D}09:00:00.000Z/${D}18:00:00.000Z`]);
  });

  it('écarte les intervalles vides ou inversés', () => {
    const merged = mergeRanges([
      range(`${D}12:00:00Z`, `${D}12:00:00Z`),
      range(`${D}14:00:00Z`, `${D}13:00:00Z`),
    ]);

    expect(merged).toEqual([]);
  });

  it('ne mute pas ses arguments', () => {
    const source = range(`${D}09:00:00Z`, `${D}12:00:00Z`);
    const before = source.startsAt.getTime();

    mergeRanges([source, range(`${D}11:00:00Z`, `${D}18:00:00Z`)]);

    expect(source.startsAt.getTime()).toBe(before);
  });
});

describe('subtractRanges', () => {
  const workday = [range(`${D}09:00:00Z`, `${D}18:00:00Z`)];

  it('rend la fenêtre intacte quand aucune absence ne la touche', () => {
    const left = subtractRanges(workday, [range(`${D}19:00:00Z`, `${D}20:00:00Z`)]);

    expect(readable(left)).toEqual([`${D}09:00:00.000Z/${D}18:00:00.000Z`]);
  });

  it('coupe la fenêtre en deux quand l’absence tombe au milieu', () => {
    // Le cas du déjeuner. C'est celui qu'un filtre « le créneau tombe-t-il
    // pendant une absence ? » raterait dès que le pas de découpage est plus
    // large que l'absence.
    const left = subtractRanges(workday, [range(`${D}12:15:00Z`, `${D}12:45:00Z`)]);

    expect(readable(left)).toEqual([
      `${D}09:00:00.000Z/${D}12:15:00.000Z`,
      `${D}12:45:00.000Z/${D}18:00:00.000Z`,
    ]);
  });

  it('décale le début quand l’absence mord sur le matin', () => {
    const left = subtractRanges(workday, [range(`${D}08:00:00Z`, `${D}11:00:00Z`)]);

    expect(readable(left)).toEqual([`${D}11:00:00.000Z/${D}18:00:00.000Z`]);
  });

  it('tronque la fin quand l’absence mord sur le soir', () => {
    const left = subtractRanges(workday, [range(`${D}16:00:00Z`, `${D}23:00:00Z`)]);

    expect(readable(left)).toEqual([`${D}09:00:00.000Z/${D}16:00:00.000Z`]);
  });

  it('ne laisse rien d’une journée entièrement couverte', () => {
    const left = subtractRanges(workday, [range(`${D}00:00:00Z`, '2026-08-04T00:00:00Z')]);

    expect(left).toEqual([]);
  });

  it('efface toutes les journées d’un congé sur plusieurs jours', () => {
    // Le critère « congés sur plusieurs jours » : trois journées de travail, une
    // seule ligne d'absence, et plus aucune fenêtre à découper en créneaux.
    const week = [
      range('2026-08-03T09:00:00Z', '2026-08-03T18:00:00Z'),
      range('2026-08-04T09:00:00Z', '2026-08-04T18:00:00Z'),
      range('2026-08-05T09:00:00Z', '2026-08-05T18:00:00Z'),
      range('2026-08-06T09:00:00Z', '2026-08-06T18:00:00Z'),
    ];

    const left = subtractRanges(week, [range('2026-08-03T00:00:00Z', '2026-08-06T00:00:00Z')]);

    expect(readable(left)).toEqual(['2026-08-06T09:00:00.000Z/2026-08-06T18:00:00.000Z']);
  });

  it('laisse le créneau qui commence exactement à la fin de l’absence', () => {
    // Borne haute exclue : un congé « jusqu'à 14:00 » n'empêche pas un
    // rendez-vous à 14:00. Même convention que la contrainte d'exclusion
    // d'`appointments`.
    const left = subtractRanges([range(`${D}14:00:00Z`, `${D}15:00:00Z`)], [
      range(`${D}09:00:00Z`, `${D}14:00:00Z`),
    ]);

    expect(readable(left)).toEqual([`${D}14:00:00.000Z/${D}15:00:00.000Z`]);
  });

  it('traite des absences qui se chevauchent comme une seule', () => {
    // Étendre un congé en posant une seconde ligne est un geste ordinaire : le
    // résultat doit être le même que si l'on avait modifié la première.
    const left = subtractRanges(workday, [
      range(`${D}12:00:00Z`, `${D}14:00:00Z`),
      range(`${D}13:00:00Z`, `${D}15:00:00Z`),
    ]);

    expect(readable(left)).toEqual([
      `${D}09:00:00.000Z/${D}12:00:00.000Z`,
      `${D}15:00:00.000Z/${D}18:00:00.000Z`,
    ]);
  });

  it('ne dépend pas de l’ordre dans lequel les absences arrivent', () => {
    const holes = [
      range(`${D}15:00:00Z`, `${D}16:00:00Z`),
      range(`${D}10:00:00Z`, `${D}11:00:00Z`),
      range(`${D}12:00:00Z`, `${D}13:00:00Z`),
    ];

    const straight = subtractRanges(workday, holes);
    const reversed = subtractRanges(workday, [...holes].reverse());

    expect(readable(reversed)).toEqual(readable(straight));
    expect(readable(straight)).toEqual([
      `${D}09:00:00.000Z/${D}10:00:00.000Z`,
      `${D}11:00:00.000Z/${D}12:00:00.000Z`,
      `${D}13:00:00.000Z/${D}15:00:00.000Z`,
      `${D}16:00:00.000Z/${D}18:00:00.000Z`,
    ]);
  });

  it('rend les fenêtres fusionnées quand il n’y a aucune absence', () => {
    const left = subtractRanges(
      [range(`${D}09:00:00Z`, `${D}12:00:00Z`), range(`${D}12:00:00Z`, `${D}18:00:00Z`)],
      [],
    );

    expect(readable(left)).toEqual([`${D}09:00:00.000Z/${D}18:00:00.000Z`]);
  });

  it('reste juste quand une absence traverse un changement d’heure', () => {
    // Nuit du 25 octobre 2026 à Paris : l'horloge recule, la journée dure
    // vingt-cinq heures. Les bornes sont des instants — construits ailleurs avec
    // le fuseau — et l'arithmétique n'a donc rien de particulier à faire.
    const night = [range('2026-10-24T22:00:00Z', '2026-10-25T23:00:00Z')];

    const left = subtractRanges(night, [
      range('2026-10-25T00:00:00Z', '2026-10-25T02:00:00Z'),
    ]);

    expect(readable(left)).toEqual([
      '2026-10-24T22:00:00.000Z/2026-10-25T00:00:00.000Z',
      '2026-10-25T02:00:00.000Z/2026-10-25T23:00:00.000Z',
    ]);
  });
});

describe('rangesOverlap', () => {
  it('reconnaît deux intervalles sécants', () => {
    expect(
      rangesOverlap(range(`${D}09:00:00Z`, `${D}12:00:00Z`), range(`${D}11:00:00Z`, `${D}13:00:00Z`)),
    ).toBe(true);
  });

  it('ne compte pas comme chevauchement deux intervalles adjacents', () => {
    expect(
      rangesOverlap(range(`${D}09:00:00Z`, `${D}12:00:00Z`), range(`${D}12:00:00Z`, `${D}13:00:00Z`)),
    ).toBe(false);
  });
});
