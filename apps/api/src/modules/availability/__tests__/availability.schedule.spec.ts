import {
  END_OF_DAY_LOCAL_TIME,
  eachCalendarDate,
  firstOverlap,
  isIsoWeekday,
  isoWeekdayOf,
  localTimeToMinutes,
  minutesToLocalTime,
  workingWindows,
  type IsoWeekday,
  type ScheduleRange,
} from '../availability.schedule';
import { TenantClockService } from '../tenant-clock.service';

/**
 * Horaires récurrents — le calcul, sans base ni HTTP (#32).
 *
 * L'horloge utilisée est le **vrai** `TenantClockService` : il n'a aucune
 * dépendance, et le simuler reviendrait à prouver le calcul contre une
 * conversion qui n'est pas celle qui tournera. Ce sont les deux ensemble qui
 * doivent traverser un changement d'heure sans décaler l'agenda.
 */

const clock = new TenantClockService();

const PARIS = 'Europe/Paris';

/** Une plage, en minutes, pour ne pas recompter à chaque cas. */
function range(weekday: IsoWeekday, startsAt: string, endsAt: string): ScheduleRange {
  return {
    weekday,
    startMinute: localTimeToMinutes(startsAt),
    endMinute: localTimeToMinutes(endsAt),
  };
}

describe('jours de semaine ISO', () => {
  it('numérote lundi 1 et dimanche 7', () => {
    // 2026-08-24 est un lundi ; le 30, un dimanche.
    expect(isoWeekdayOf('2026-08-24')).toBe(1);
    expect(isoWeekdayOf('2026-08-30')).toBe(7);
  });

  it('reconnaît 1 à 7, et rien d’autre', () => {
    expect([0, 8, 1.5, Number.NaN].filter(isIsoWeekday)).toEqual([]);
    expect([1, 7].filter(isIsoWeekday)).toEqual([1, 7]);
  });

  it('refuse une date mal formée plutôt que de produire un NaN', () => {
    expect(() => isoWeekdayOf('24/08/2026')).toThrow(RangeError);
  });
});

describe('heures murales et minutes', () => {
  it('fait l’aller-retour sans perte', () => {
    for (const time of ['00:00', '09:00', '12:30', '23:59']) {
      expect(minutesToLocalTime(localTimeToMinutes(time))).toBe(time);
    }
  });

  it('compte minuit de fin pour 1440 minutes', () => {
    expect(localTimeToMinutes(END_OF_DAY_LOCAL_TIME)).toBe(1440);
    expect(minutesToLocalTime(1440)).toBe(END_OF_DAY_LOCAL_TIME);
  });

  it('refuse une heure hors de l’horloge', () => {
    expect(() => localTimeToMinutes('25:00')).toThrow(RangeError);
    expect(() => minutesToLocalTime(1441)).toThrow(RangeError);
  });
});

describe('recouvrement d’une semaine de travail', () => {
  it('laisse passer une coupure méridienne', () => {
    expect(firstOverlap([range(2, '09:00', '12:00'), range(2, '14:00', '18:00')])).toBeNull();
  });

  it('laisse passer deux plages adjacentes — la borne haute est exclue', () => {
    expect(firstOverlap([range(2, '09:00', '12:00'), range(2, '12:00', '18:00')])).toBeNull();
  });

  it('ne confond pas deux jours différents', () => {
    expect(firstOverlap([range(2, '09:00', '18:00'), range(3, '09:00', '18:00')])).toBeNull();
  });

  it('nomme les deux plages fautives', () => {
    const clash = firstOverlap([range(2, '09:00', '13:00'), range(2, '12:00', '18:00')]);

    // Le couple, et non un booléen : le message d'erreur doit dire lesquelles
    // des vingt-huit plages possibles se marchent dessus.
    expect(clash?.left.startMinute).toBe(540);
    expect(clash?.right.startMinute).toBe(720);
  });
});

describe('parcours des dates civiles', () => {
  it('rend les bornes comprises', () => {
    expect(eachCalendarDate('2026-08-24', '2026-08-26')).toEqual([
      '2026-08-24',
      '2026-08-25',
      '2026-08-26',
    ]);
  });

  it('traverse une fin de mois et une année bissextile', () => {
    expect(eachCalendarDate('2028-02-28', '2028-03-01')).toEqual([
      '2028-02-28',
      '2028-02-29',
      '2028-03-01',
    ]);
  });

  it('traverse un changement d’heure sans sauter ni répéter un jour', () => {
    // Le 29 mars 2026 ne dure que 23 heures en Europe : une itération qui
    // ajouterait 24 heures à un instant local sauterait le 30.
    expect(eachCalendarDate('2026-03-28', '2026-03-30')).toEqual([
      '2026-03-28',
      '2026-03-29',
      '2026-03-30',
    ]);
  });

  it('rend un seul jour quand les bornes coïncident', () => {
    expect(eachCalendarDate('2026-08-24', '2026-08-24')).toEqual(['2026-08-24']);
  });
});

describe('fenêtres de travail', () => {
  const closedNothing = new Set<IsoWeekday>();

  it('convertit une heure murale en instants, hiver et été, sans décalage figé', () => {
    // Le lundi 09:00–12:00 vaut 08:00Z en janvier et 07:00Z en juillet. C'est la
    // même ligne en base : rien n'a été stocké de l'offset.
    const ranges = [range(1, '09:00', '12:00')];

    const winter = workingWindows(clock, {
      ranges,
      closedWeekdays: closedNothing,
      timeZone: PARIS,
      from: '2026-01-05',
      to: '2026-01-05',
    });
    const summer = workingWindows(clock, {
      ranges,
      closedWeekdays: closedNothing,
      timeZone: PARIS,
      from: '2026-07-06',
      to: '2026-07-06',
    });

    expect(winter[0]?.startsAt.toISOString()).toBe('2026-01-05T08:00:00.000Z');
    expect(summer[0]?.startsAt.toISOString()).toBe('2026-07-06T07:00:00.000Z');
  });

  it('rend deux fenêtres pour une journée à coupure méridienne', () => {
    const windows = workingWindows(clock, {
      ranges: [range(2, '14:00', '18:00'), range(2, '09:00', '12:00')],
      closedWeekdays: closedNothing,
      timeZone: PARIS,
      from: '2026-08-25',
      to: '2026-08-25',
    });

    expect(windows).toHaveLength(2);
    // Triées par instant de début, quel que soit l'ordre venu de la base.
    expect(windows.map((window) => window.startsAt.toISOString())).toEqual([
      '2026-08-25T07:00:00.000Z',
      '2026-08-25T12:00:00.000Z',
    ]);
  });

  it('ne produit aucune fenêtre un jour de fermeture de l’établissement', () => {
    const windows = workingWindows(clock, {
      ranges: [range(7, '09:00', '18:00')],
      closedWeekdays: new Set<IsoWeekday>([7]),
      timeZone: PARIS,
      from: '2026-08-30',
      to: '2026-08-30',
    });

    expect(windows).toEqual([]);
  });

  it('n’ouvre pas un jour où le praticien n’a aucune plage', () => {
    const windows = workingWindows(clock, {
      ranges: [range(1, '09:00', '18:00')],
      closedWeekdays: closedNothing,
      timeZone: PARIS,
      from: '2026-08-25',
      to: '2026-08-26',
    });

    expect(windows).toEqual([]);
  });

  it('raccourcit d’une heure la journée du passage à l’heure d’été', () => {
    // 2026-03-29, l'horloge saute 02:00 → 03:00 : une journée 00:00–24:00 ne
    // dure que 23 heures. Un calcul en « début + 1440 minutes » en aurait rendu
    // 24, et aurait proposé une heure de créneaux qui n'existe pas.
    const [window] = workingWindows(clock, {
      ranges: [range(7, '00:00', END_OF_DAY_LOCAL_TIME)],
      closedWeekdays: closedNothing,
      timeZone: PARIS,
      from: '2026-03-29',
      to: '2026-03-29',
    });

    const hours = ((window?.endsAt.getTime() ?? 0) - (window?.startsAt.getTime() ?? 0)) / 3_600_000;

    expect(hours).toBe(23);
  });

  it('allonge d’une heure la journée du retour à l’heure d’hiver', () => {
    // 2026-10-25, l'horloge recule 03:00 → 02:00 : la journée dure 25 heures.
    const [window] = workingWindows(clock, {
      ranges: [range(7, '00:00', END_OF_DAY_LOCAL_TIME)],
      closedWeekdays: closedNothing,
      timeZone: PARIS,
      from: '2026-10-25',
      to: '2026-10-25',
    });

    const hours = ((window?.endsAt.getTime() ?? 0) - (window?.startsAt.getTime() ?? 0)) / 3_600_000;

    expect(hours).toBe(25);
  });

  it('écarte une plage entièrement contenue dans le trou d’horloge', () => {
    // 02:00–03:00 le 29 mars à Paris : une heure qui n'a pas eu lieu. Les deux
    // bornes se résolvent au même instant ; la rendre proposerait un créneau
    // vide.
    const windows = workingWindows(clock, {
      ranges: [range(7, '02:00', '03:00')],
      closedWeekdays: closedNothing,
      timeZone: PARIS,
      from: '2026-03-29',
      to: '2026-03-29',
    });

    expect(windows).toEqual([]);
  });

  it('rapporte la fenêtre au calendrier du tenant, pas à celui de la machine', () => {
    // Kiritimati est à UTC+14 : le lundi 09:00 local y vaut le dimanche 19:00Z.
    // Un calcul qui aurait lu le jour de semaine depuis l'instant UTC aurait
    // rangé cette fenêtre au dimanche, et l'aurait donc écartée.
    const windows = workingWindows(clock, {
      ranges: [range(1, '09:00', '12:00')],
      closedWeekdays: new Set<IsoWeekday>([7]),
      timeZone: 'Pacific/Kiritimati',
      from: '2026-08-24',
      to: '2026-08-24',
    });

    expect(windows).toHaveLength(1);
    expect(windows[0]?.startsAt.toISOString()).toBe('2026-08-23T19:00:00.000Z');
    expect(windows[0]?.weekday).toBe(1);
  });

  it('refuse un fuseau inconnu par l’horloge, jamais en silence', () => {
    expect(() =>
      workingWindows(clock, {
        ranges: [range(1, '09:00', '12:00')],
        closedWeekdays: closedNothing,
        timeZone: 'Europe/Atlantis',
        from: '2026-08-24',
        to: '2026-08-24',
      }),
    ).toThrow();
  });
});
