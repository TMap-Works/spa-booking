import {
  computeSlots,
  occupiedMinutesOf,
  type SlotShape,
  type StaffFreeTime,
  type StaffSlot,
} from '../availability.slots';
import type { UtcRange } from '../availability.time';

/**
 * Découpage des fenêtres libres en créneaux — les étapes 4 à 6 du moteur (#34).
 *
 * Tout est en UTC et sans fuseau : ce module ne convertit rien, il compare des
 * instants. Les cas de changement d'heure appartiennent à la **construction** des
 * fenêtres, donc à `availability.schedule.spec.ts` et à `dst-booking.spec.ts` ;
 * ici, une heure est un nombre de millisecondes et rien d'autre.
 *
 * Les trois cas que le ticket nomme explicitement ont leur `describe` :
 * chevauchements, coupures méridiennes, journées partiellement occupées.
 */

/** `2026-08-24` est un lundi — la date de référence de tous les cas. */
const DAY = '2026-08-24';

/** Un instant, écrit comme on lit une horloge murale UTC. */
function at(time: string): Date {
  return new Date(`${DAY}T${time}:00.000Z`);
}

function range(startsAt: string, endsAt: string): UtcRange {
  return { startsAt: at(startsAt), endsAt: at(endsAt) };
}

/** Un soin d'une demi-heure, sans tampon, sur une grille au quart d'heure. */
const HALF_HOUR: SlotShape = {
  slotIntervalMinutes: 15,
  serviceDurationMinutes: 30,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
};

/** Les heures de début, en `HH:MM`, de ce que le calcul a rendu. */
function startTimes(slots: readonly StaffSlot[]): string[] {
  return slots.map((slot) => slot.startsAt.toISOString().slice(11, 16));
}

function slotsOf(
  free: Partial<StaffFreeTime> & Pick<StaffFreeTime, 'windows'>,
  shape: SlotShape = HALF_HOUR,
  notBefore: Date = at('00:00'),
): StaffSlot[] {
  return computeSlots({
    staff: [{ staffId: 'alice', busy: [], ...free }],
    shape,
    notBefore,
  });
}

describe('durée occupée', () => {
  it('additionne les deux tampons à la durée facturée', () => {
    expect(
      occupiedMinutesOf({
        slotIntervalMinutes: 15,
        serviceDurationMinutes: 60,
        bufferBeforeMinutes: 10,
        bufferAfterMinutes: 5,
      }),
    ).toBe(75);
  });

  it('vaut la seule durée du soin quand les tampons sont nuls', () => {
    expect(occupiedMinutesOf(HALF_HOUR)).toBe(30);
  });
});

describe('découpage par pas de créneau', () => {
  it('pose la grille à l’ouverture de la fenêtre, pas à minuit', () => {
    // La fenêtre ouvre à 09:10 : les créneaux suivent ce départ, ils ne
    // s'alignent pas sur les quarts d'heure de l'horloge.
    expect(startTimes(slotsOf({ windows: [range('09:10', '10:30')] }))).toEqual([
      '09:10',
      '09:25',
      '09:40',
      '09:55',
    ]);
  });

  it('respecte un pas différent du défaut', () => {
    const everyTwentyMinutes = { ...HALF_HOUR, slotIntervalMinutes: 20 };

    expect(startTimes(slotsOf({ windows: [range('09:00', '10:30')] }, everyTwentyMinutes))).toEqual([
      '09:00',
      '09:20',
      '09:40',
      '10:00',
    ]);
  });

  it('n’ouvre aucun créneau dans une fenêtre plus courte que le soin', () => {
    expect(slotsOf({ windows: [range('09:00', '09:20')] })).toEqual([]);
  });

  it('refuse un pas nul plutôt que de boucler indéfiniment', () => {
    expect(() => slotsOf({ windows: [range('09:00', '18:00')] }, { ...HALF_HOUR, slotIntervalMinutes: 0 })).toThrow(
      RangeError,
    );
  });

  it('refuse une durée de prestation nulle ou un tampon négatif', () => {
    const windows = [range('09:00', '18:00')];

    expect(() => slotsOf({ windows }, { ...HALF_HOUR, serviceDurationMinutes: 0 })).toThrow(RangeError);
    expect(() => slotsOf({ windows }, { ...HALF_HOUR, bufferAfterMinutes: -5 })).toThrow(RangeError);
  });
});

describe('la durée occupée doit tenir entièrement', () => {
  it('arrête la grille assez tôt pour que le soin finisse dans la fenêtre', () => {
    // 09:00–10:00, soin de 30 min, pas de 15 : le dernier départ est 09:30.
    expect(startTimes(slotsOf({ windows: [range('09:00', '10:00')] }))).toEqual([
      '09:00',
      '09:15',
      '09:30',
    ]);
  });

  it('compte les tampons dans ce qui doit tenir, sans les montrer', () => {
    const withBuffers: SlotShape = {
      slotIntervalMinutes: 15,
      serviceDurationMinutes: 30,
      bufferBeforeMinutes: 10,
      bufferAfterMinutes: 5,
    };

    // 45 minutes occupées dans une fenêtre de 09:00 à 10:00 : deux départs
    // possibles, à 09:00 et 09:15 — le troisième (09:30) déborderait à 10:15.
    const slots = slotsOf({ windows: [range('09:00', '10:00')] }, withBuffers);

    expect(slots).toHaveLength(2);
    // La cliente est reçue dix minutes après le début de l'occupation, et son
    // créneau ne dure que le soin.
    expect(slots[0]?.startsAt).toEqual(at('09:10'));
    expect(slots[0]?.endsAt).toEqual(at('09:40'));
    expect(slots[1]?.startsAt).toEqual(at('09:25'));
    expect(slots[1]?.endsAt).toEqual(at('09:55'));
  });

  it('rend un créneau dont la durée est exactement celle du soin', () => {
    const [slot] = slotsOf(
      { windows: [range('09:00', '10:00')] },
      { slotIntervalMinutes: 60, serviceDurationMinutes: 20, bufferBeforeMinutes: 20, bufferAfterMinutes: 20 },
    );

    expect(slot).toBeDefined();
    expect((slot as StaffSlot).endsAt.getTime() - (slot as StaffSlot).startsAt.getTime()).toBe(20 * 60_000);
  });
});

describe('coupure méridienne', () => {
  it('repart de l’ouverture de l’après-midi, et n’enjambe pas la pause', () => {
    const slots = startTimes(
      slotsOf({ windows: [range('09:00', '12:00'), range('14:00', '16:00')] }),
    );

    // Rien entre 11:30 et 14:00 : un soin de 30 min ne peut pas commencer à
    // 11:45, il déborderait sur la pause. L'après-midi rouvre sa propre grille.
    expect(slots).toContain('11:30');
    expect(slots).not.toContain('11:45');
    expect(slots).toContain('14:00');
    expect(slots[slots.length - 1]).toBe('15:30');
  });

  it('repart bien de l’ouverture, même quand la pause ne tombe pas sur la grille', () => {
    const slots = startTimes(
      slotsOf({ windows: [range('09:00', '12:00'), range('13:50', '15:00')] }),
    );

    // 13:50 n'est sur aucune grille issue de 09:00 : c'est bien l'ouverture de
    // l'après-midi qui sert d'origine. Le dernier départ est 14:20 — 14:35
    // finirait à 15:05, hors de la fenêtre.
    expect(slots.slice(-4)).toEqual(['11:30', '13:50', '14:05', '14:20']);
    expect(slots.slice(0, 2)).toEqual(['09:00', '09:15']);
  });

  it('traite deux plages adjacentes comme une seule journée continue', () => {
    // `09:00–12:00` puis `12:00–18:00` décrivent une journée continue. Un soin de
    // 30 minutes doit pouvoir commencer à 11:45, à cheval sur la jointure — deux
    // grilles séparées le lui interdiraient.
    const slots = startTimes(
      slotsOf({ windows: [range('09:00', '12:00'), range('12:00', '13:00')] }),
    );

    expect(slots).toContain('11:45');
    expect(slots[slots.length - 1]).toBe('12:30');
  });
});

describe('journée partiellement occupée', () => {
  it('retire les départs que le rendez-vous chevauche, sans décaler la grille', () => {
    // Rendez-vous de 10:00 à 11:00 dans une journée 09:00–12:00.
    const slots = startTimes(
      slotsOf({ windows: [range('09:00', '12:00')], busy: [range('10:00', '11:00')] }),
    );

    // 09:30 tient (finit à 10:00, borne exclue) ; 09:45 déborderait sur le
    // rendez-vous. La reprise est à 11:00 pile, sur la grille du matin.
    expect(slots).toEqual(['09:00', '09:15', '09:30', '11:00', '11:15', '11:30']);
  });

  it('garde la grille du matin après un rendez-vous qui finit hors grille', () => {
    // Le rendez-vous finit à 10:50, qui n'est pas une position de grille : la
    // reprise se fait à 11:00, et non à 10:50.
    const slots = startTimes(
      slotsOf({ windows: [range('09:00', '12:00')], busy: [range('10:00', '10:50')] }),
    );

    expect(slots).not.toContain('10:50');
    expect(slots).toContain('11:00');
  });

  it('ne rend aucun créneau quand un congé recouvre la journée entière', () => {
    expect(
      slotsOf({ windows: [range('09:00', '18:00')], busy: [range('08:00', '19:00')] }),
    ).toEqual([]);
  });

  it('empêche le créneau suivant de mordre sur le tampon du précédent', () => {
    // Le rendez-vous occupe 10:00–11:00 tampons compris. Un soin de 30 minutes
    // avec dix minutes de préparation ne peut donc pas être *occupé* avant 11:00,
    // et la cliente n'est reçue qu'à 11:10.
    const withBuffer = { ...HALF_HOUR, bufferBeforeMinutes: 10 };
    const slots = slotsOf(
      { windows: [range('09:00', '12:00')], busy: [range('10:00', '11:00')] },
      withBuffer,
    );

    const afterTheGap = slots.filter((slot) => slot.startsAt.getTime() >= at('10:00').getTime());

    expect(afterTheGap[0]?.startsAt).toEqual(at('11:10'));
  });
});

describe('chevauchements', () => {
  it('fusionne deux absences qui se recouvrent avant de soustraire', () => {
    const merged = startTimes(
      slotsOf({
        windows: [range('09:00', '13:00')],
        busy: [range('10:00', '11:30'), range('11:00', '12:00')],
      }),
    );

    // L'union vaut 10:00–12:00 : rien ne doit apparaître à l'intérieur, et la
    // reprise est à 12:00.
    expect(merged).toEqual(['09:00', '09:15', '09:30', '12:00', '12:15', '12:30']);
  });

  it('ne dépend pas de l’ordre dans lequel les absences arrivent', () => {
    const windows = [range('09:00', '13:00')];
    const first = range('11:00', '12:00');
    const second = range('10:00', '11:30');

    expect(startTimes(slotsOf({ windows, busy: [first, second] }))).toEqual(
      startTimes(slotsOf({ windows, busy: [second, first] })),
    );
  });

  it('laisse le créneau qui commence exactement à la fin d’une absence', () => {
    // Borne haute exclue : une absence « jusqu'à 10:00 » ne bloque pas 10:00.
    expect(
      startTimes(slotsOf({ windows: [range('10:00', '10:30')], busy: [range('09:00', '10:00')] })),
    ).toEqual(['10:00']);
  });

  it('recolle deux absences adjacentes plutôt que d’ouvrir un créneau vide entre elles', () => {
    expect(
      slotsOf({
        windows: [range('09:00', '10:00')],
        busy: [range('09:00', '09:30'), range('09:30', '10:00')],
      }),
    ).toEqual([]);
  });
});

describe('passé et délai minimum de réservation', () => {
  it('écarte les créneaux dont l’occupation commence avant le seuil', () => {
    const slots = startTimes(
      slotsOf({ windows: [range('09:00', '11:00')] }, HALF_HOUR, at('09:40')),
    );

    // 09:45 est la première position de grille au-delà de 09:40.
    expect(slots[0]).toBe('09:45');
  });

  it('garde un créneau qui commence exactement au seuil', () => {
    expect(startTimes(slotsOf({ windows: [range('09:00', '10:00')] }, HALF_HOUR, at('09:15')))[0]).toBe(
      '09:15',
    );
  });

  it('juge le seuil sur le début de l’occupation, pas sur l’heure affichée', () => {
    // Préparation de dix minutes : le créneau affiché à 09:10 est occupé dès
    // 09:00, donc écarté par un seuil à 09:05 — la cabine ne peut plus être
    // préparée à temps.
    const withBuffer = { ...HALF_HOUR, bufferBeforeMinutes: 10 };
    const slots = slotsOf({ windows: [range('09:00', '11:00')] }, withBuffer, at('09:05'));

    expect(slots[0]?.startsAt).toEqual(at('09:25'));
  });

  it('vide la journée quand le seuil la dépasse', () => {
    expect(slotsOf({ windows: [range('09:00', '18:00')] }, HALF_HOUR, at('23:00'))).toEqual([]);
  });
});

describe('plusieurs praticiens', () => {
  const shared: StaffFreeTime[] = [
    { staffId: 'zoe', windows: [range('09:00', '10:00')], busy: [] },
    { staffId: 'alice', windows: [range('09:00', '10:00')], busy: [range('09:00', '09:30')] },
  ];

  it('rend les créneaux de tous les candidats, sans les fondre', () => {
    const slots = computeSlots({ staff: shared, shape: HALF_HOUR, notBefore: at('00:00') });

    // Zoé est libre à 09:00, 09:15 et 09:30 ; Alice seulement à 09:30.
    expect(slots).toHaveLength(4);
    expect(slots.filter((slot) => slot.staffId === 'alice')).toHaveLength(1);
  });

  it('trie par instant puis par praticien, pour un ordre stable', () => {
    const slots = computeSlots({ staff: shared, shape: HALF_HOUR, notBefore: at('00:00') });

    expect(slots.map((slot) => `${slot.startsAt.toISOString().slice(11, 16)} ${slot.staffId}`)).toEqual([
      '09:00 zoe',
      '09:15 zoe',
      '09:30 alice',
      '09:30 zoe',
    ]);
  });

  it('rend une liste vide quand aucun praticien ne travaille', () => {
    expect(computeSlots({ staff: [], shape: HALF_HOUR, notBefore: at('00:00') })).toEqual([]);
  });
});
