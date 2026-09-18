import {
  SIGNUP_WEEKS,
  mondayOf,
  overviewWindow,
  recurringRevenue,
  signupWeeks,
} from '../platform-overview';

/**
 * Les calculs de la vue d'ensemble — semaines d'ouvertures et revenu récurrent.
 */
describe('mondayOf', () => {
  it('ramène un instant au lundi 00:00 UTC de sa semaine', () => {
    // Le 18/09/2026 est un vendredi.
    expect(mondayOf(new Date('2026-09-18T15:42:00.000Z')).toISOString()).toBe(
      '2026-09-14T00:00:00.000Z',
    );
  });

  it('laisse un lundi à lui-même, et range un dimanche dans la semaine qui finit', () => {
    expect(mondayOf(new Date('2026-09-14T00:00:00.000Z')).toISOString()).toBe(
      '2026-09-14T00:00:00.000Z',
    );
    expect(mondayOf(new Date('2026-09-20T23:59:59.000Z')).toISOString()).toBe(
      '2026-09-14T00:00:00.000Z',
    );
  });
});

describe('signupWeeks', () => {
  const now = new Date('2026-09-18T12:00:00.000Z');

  it('rend douze semaines, la plus ancienne d’abord, vides comprises', () => {
    const weeks = signupWeeks([], now);

    expect(weeks).toHaveLength(SIGNUP_WEEKS);
    expect(weeks[0]?.weekStart).toBe('2026-06-29');
    expect(weeks[SIGNUP_WEEKS - 1]?.weekStart).toBe('2026-09-14');
    expect(weeks.every((week) => week.console === 0 && week.signup === 0)).toBe(true);
  });

  it('range chaque ouverture dans sa semaine, selon son origine', () => {
    const weeks = signupWeeks(
      [
        { createdAt: new Date('2026-09-15T09:00:00.000Z'), origin: 'signup' },
        { createdAt: new Date('2026-09-17T09:00:00.000Z'), origin: 'signup' },
        { createdAt: new Date('2026-09-16T09:00:00.000Z'), origin: 'console' },
        { createdAt: new Date('2026-07-01T09:00:00.000Z'), origin: 'console' },
      ],
      now,
    );

    expect(weeks[SIGNUP_WEEKS - 1]).toEqual({ weekStart: '2026-09-14', console: 1, signup: 2 });
    expect(weeks[0]).toEqual({ weekStart: '2026-06-29', console: 1, signup: 0 });
  });

  it('ne compte pas un salon antérieur à la console — seed ou jeu d’essai', () => {
    const weeks = signupWeeks(
      [{ createdAt: new Date('2026-09-15T09:00:00.000Z'), origin: 'legacy' }],
      now,
    );

    expect(weeks.reduce((sum, week) => sum + week.console + week.signup, 0)).toBe(0);
  });

  it('ignore une ouverture hors de la fenêtre plutôt que de la ranger ailleurs', () => {
    const weeks = signupWeeks(
      [{ createdAt: new Date('2026-01-05T09:00:00.000Z'), origin: 'console' }],
      now,
    );

    expect(weeks.reduce((sum, week) => sum + week.console + week.signup, 0)).toBe(0);
  });
});

describe('overviewWindow', () => {
  it('borne les essais à sept jours, les ouvertures à douze semaines, l’activité à trente jours', () => {
    const window = overviewWindow(new Date('2026-09-18T12:00:00.000Z'));

    expect(window.trialHorizon.toISOString()).toBe('2026-09-25T12:00:00.000Z');
    expect(window.openingsSince.toISOString()).toBe('2026-06-29T00:00:00.000Z');
    expect(window.activitySince.toISOString()).toBe('2026-08-19T12:00:00.000Z');
  });
});

describe('recurringRevenue', () => {
  it('multiplie des entiers au tarif de l’offre — les impayés à part', () => {
    const revenue = recurringRevenue({
      managed: 4,
      pending: 2,
      trialing: 3,
      active: 10,
      past_due: 1,
      canceled: 5,
    });

    expect(revenue.monthlyRecurring).toEqual({ amountMinor: 29_000, currency: 'EUR' });
    expect(revenue.atRisk).toEqual({ amountMinor: 2_900, currency: 'EUR' });
    expect(revenue.inTrial).toEqual({ amountMinor: 8_700, currency: 'EUR' });
  });
});
