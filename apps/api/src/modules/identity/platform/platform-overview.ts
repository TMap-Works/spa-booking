import {
  SUBSCRIPTION_PLAN,
  type Money,
  type PlatformSignupWeek,
  type PlatformTenantOrigin,
  type TenantBillingStatus,
} from '@spa/shared';

/**
 * Les calculs de la vue d'ensemble — ce qui se décide sans base, et se teste
 * donc sans elle.
 */

/** Le nombre de semaines d'ouvertures que le tableau de bord montre. */
export const SIGNUP_WEEKS = 12;

/** L'horizon des essais « qui se terminent bientôt ». */
export const TRIAL_HORIZON_DAYS = 7;

/** La fenêtre d'activité d'un salon. */
export const ACTIVITY_DAYS = 30;

const DAY_MS = 86_400_000;

/**
 * Le lundi 00:00 UTC de la semaine qui contient cet instant.
 *
 * En UTC et non dans un fuseau : la plateforme sert des salons de plusieurs
 * fuseaux, et l'éditeur lit une tendance, pas un agenda. Une ouverture faite le
 * dimanche à 23 h à Paris tombe dans la semaine suivante — c'est sans effet sur
 * une courbe de douze semaines.
 */
export function mondayOf(instant: Date): Date {
  const day = new Date(
    Date.UTC(instant.getUTCFullYear(), instant.getUTCMonth(), instant.getUTCDate()),
  );
  // `getUTCDay` : 0 = dimanche. On recule jusqu'au lundi.
  const offset = (day.getUTCDay() + 6) % 7;
  return new Date(day.getTime() - offset * DAY_MS);
}

/** Les bornes de lecture de la vue d'ensemble, calculées une fois. */
export function overviewWindow(now: Date): {
  readonly trialHorizon: Date;
  readonly openingsSince: Date;
  readonly activitySince: Date;
} {
  return {
    trialHorizon: new Date(now.getTime() + TRIAL_HORIZON_DAYS * DAY_MS),
    openingsSince: new Date(mondayOf(now).getTime() - (SIGNUP_WEEKS - 1) * 7 * DAY_MS),
    activitySince: new Date(now.getTime() - ACTIVITY_DAYS * DAY_MS),
  };
}

/**
 * Douze semaines d'ouvertures, la plus ancienne d'abord — **toutes** présentes,
 * y compris celles sans ouverture : une semaine vide est une information, et un
 * graphique qui la sauterait tasserait l'axe du temps.
 *
 * Un salon `legacy` (seed, jeu d'essai) n'est pas une ouverture : il n'est
 * compté dans aucune des deux séries.
 */
export function signupWeeks(
  openings: readonly { createdAt: Date; origin: PlatformTenantOrigin }[],
  now: Date,
): PlatformSignupWeek[] {
  const first = mondayOf(now).getTime() - (SIGNUP_WEEKS - 1) * 7 * DAY_MS;
  const weeks = Array.from({ length: SIGNUP_WEEKS }, (_, index) => ({
    weekStart: new Date(first + index * 7 * DAY_MS).toISOString().slice(0, 10),
    console: 0,
    signup: 0,
  }));

  for (const opening of openings) {
    if (opening.origin === 'legacy') {
      continue;
    }
    const index = Math.floor((mondayOf(opening.createdAt).getTime() - first) / (7 * DAY_MS));
    const week = weeks[index];
    if (week !== undefined) {
      week[opening.origin] += 1;
    }
  }

  return weeks;
}

/**
 * Le revenu récurrent de l'éditeur, au tarif unique de l'offre (ADR 0016).
 *
 * Un produit d'entiers — jamais de flottant sur de l'argent. `past_due` n'entre
 * pas dans le revenu acquis : un salon en impayé est un revenu **à risque**,
 * pas un revenu.
 */
export function recurringRevenue(byStatus: Readonly<Record<TenantBillingStatus, number>>): {
  readonly monthlyRecurring: Money;
  readonly atRisk: Money;
  readonly inTrial: Money;
} {
  const monthly = (count: number): Money => ({
    amountMinor: count * SUBSCRIPTION_PLAN.amountMinor,
    currency: SUBSCRIPTION_PLAN.currency,
  });

  return {
    monthlyRecurring: monthly(byStatus.active),
    atRisk: monthly(byStatus.past_due),
    inTrial: monthly(byStatus.trialing),
  };
}
