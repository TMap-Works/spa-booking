/**
 * Horaires récurrents du personnel — la part **contrat** de #32.
 *
 * Ce qui se prouve ici est ce qu'un front et une API doivent lire de la même
 * façon : la numérotation des jours, la forme d'une plage, et le fait qu'une
 * semaine de travail ne se recouvre pas. Le calcul des fenêtres en UTC, lui,
 * n'est pas du contrat — il demande un fuseau et vit dans le module
 * `availability` de l'API.
 */

import {
  closingDaysSchema,
  END_OF_DAY_LOCAL_TIME,
  isoWeekdayOf,
  isoWeekdaySchema,
  MAX_STAFF_SCHEDULE_ENTRIES,
  scheduleEndToMinutes,
  setClosingDaysRequestSchema,
  setStaffScheduleRequestSchema,
  staffScheduleEntriesOverlap,
  staffScheduleEntrySchema,
  staffScheduleSchema,
  type StaffScheduleEntry,
} from '../schemas/availability';

/** Une plage bien formée, dont chaque cas ne modifie que ce qui l'intéresse. */
function entry(patch: Partial<StaffScheduleEntry> = {}): StaffScheduleEntry {
  return { weekday: 2, startsAt: '09:00', endsAt: '12:00', ...patch };
}

describe('jour de semaine ISO', () => {
  it('accepte 1 (lundi) à 7 (dimanche)', () => {
    for (const weekday of [1, 2, 3, 4, 5, 6, 7]) {
      expect(isoWeekdaySchema.parse(weekday)).toBe(weekday);
    }
  });

  it('refuse le 0-dimanche de Date.getDay', () => {
    // `0` est *falsy* : le praticien du dimanche disparaîtrait au premier
    // `weekday ?? défaut`. La numérotation ISO n'a pas ce piège.
    expect(isoWeekdaySchema.safeParse(0).success).toBe(false);
    expect(isoWeekdaySchema.safeParse(8).success).toBe(false);
    expect(isoWeekdaySchema.safeParse(1.5).success).toBe(false);
  });

  it('lit le jour d’une date civile, dimanche compris', () => {
    // 2026-08-24 est un lundi ; le 30, un dimanche.
    expect(isoWeekdayOf('2026-08-24')).toBe(1);
    expect(isoWeekdayOf('2026-08-29')).toBe(6);
    expect(isoWeekdayOf('2026-08-30')).toBe(7);
  });

  it('ne dépend d’aucun fuseau — une date civile en est déjà une', () => {
    // Le 29 mars 2026 est le jour du passage à l'heure d'été en Europe : la
    // journée ne dure que 23 heures, et reste un dimanche.
    expect(isoWeekdayOf('2026-03-29')).toBe(7);
  });

  it('refuse une date qui n’existe pas au calendrier', () => {
    expect(() => isoWeekdayOf('2026-02-31')).toThrow();
  });
});

describe('plage de travail', () => {
  it('accepte une plage en heure murale', () => {
    expect(staffScheduleEntrySchema.parse(entry())).toEqual(entry());
  });

  it('refuse une fin antérieure ou égale au début', () => {
    expect(staffScheduleEntrySchema.safeParse(entry({ endsAt: '09:00' })).success).toBe(false);
    expect(staffScheduleEntrySchema.safeParse(entry({ endsAt: '08:00' })).success).toBe(false);
  });

  it('refuse une heure hors de l’horloge', () => {
    expect(staffScheduleEntrySchema.safeParse(entry({ startsAt: '25:00' })).success).toBe(false);
    expect(staffScheduleEntrySchema.safeParse(entry({ startsAt: '09:60' })).success).toBe(false);
  });

  it('refuse un champ non déclaré — dont un tenantId glissé dans le corps', () => {
    const injected = { ...entry(), tenantId: '11111111-1111-4111-8111-111111111111' };

    expect(staffScheduleEntrySchema.safeParse(injected).success).toBe(false);
  });

  it('admet minuit comme borne de fin, jamais comme borne de début', () => {
    expect(
      staffScheduleEntrySchema.safeParse(entry({ startsAt: '18:00', endsAt: END_OF_DAY_LOCAL_TIME }))
        .success,
    ).toBe(true);
    expect(
      staffScheduleEntrySchema.safeParse(entry({ startsAt: END_OF_DAY_LOCAL_TIME })).success,
    ).toBe(false);
  });

  it('compte minuit de fin pour 1440 minutes', () => {
    expect(scheduleEndToMinutes(END_OF_DAY_LOCAL_TIME)).toBe(1440);
    expect(scheduleEndToMinutes('12:30')).toBe(750);
  });
});

describe('semaine de travail', () => {
  it('accepte deux plages dans la même journée — la coupure méridienne', () => {
    const request = {
      entries: [entry(), entry({ startsAt: '14:00', endsAt: '18:00' })],
    };

    expect(setStaffScheduleRequestSchema.parse(request).entries).toHaveLength(2);
  });

  it('accepte deux plages adjacentes — la borne haute est exclue', () => {
    const request = { entries: [entry(), entry({ startsAt: '12:00', endsAt: '18:00' })] };

    expect(setStaffScheduleRequestSchema.safeParse(request).success).toBe(true);
  });

  it('refuse deux plages du même jour qui se recouvrent', () => {
    const request = { entries: [entry(), entry({ startsAt: '11:00', endsAt: '15:00' })] };

    expect(setStaffScheduleRequestSchema.safeParse(request).success).toBe(false);
  });

  it('ne confond pas deux jours différents', () => {
    // Mêmes heures, jours différents : aucun recouvrement.
    expect(staffScheduleEntriesOverlap([entry({ weekday: 2 }), entry({ weekday: 3 })])).toBe(false);
  });

  it('accepte une semaine vide — un praticien qui ne prend plus de rendez-vous', () => {
    expect(setStaffScheduleRequestSchema.parse({ entries: [] }).entries).toEqual([]);
  });

  it('borne le nombre de plages d’une semaine', () => {
    const entries = Array.from({ length: MAX_STAFF_SCHEDULE_ENTRIES + 1 }, (_, index) => ({
      weekday: ((index % 7) + 1) as StaffScheduleEntry['weekday'],
      startsAt: '09:00',
      endsAt: '10:00',
    }));

    expect(setStaffScheduleRequestSchema.safeParse({ entries }).success).toBe(false);
  });

  it('rend le fuseau qui donne leur sens aux heures murales', () => {
    const schedule = {
      staffId: '33333333-3333-4333-8333-333333333333',
      timezone: 'Europe/Paris',
      entries: [entry()],
    };

    expect(staffScheduleSchema.parse(schedule).timezone).toBe('Europe/Paris');
  });
});

describe('jours de fermeture', () => {
  it('accepte une liste de jours ISO', () => {
    expect(setClosingDaysRequestSchema.parse({ weekdays: [7, 1] }).weekdays).toEqual([7, 1]);
    expect(closingDaysSchema.parse({ weekdays: [] }).weekdays).toEqual([]);
  });

  it('refuse un jour déclaré deux fois', () => {
    expect(setClosingDaysRequestSchema.safeParse({ weekdays: [7, 7] }).success).toBe(false);
  });

  it('refuse un jour hors de la semaine', () => {
    expect(setClosingDaysRequestSchema.safeParse({ weekdays: [0] }).success).toBe(false);
  });
});
