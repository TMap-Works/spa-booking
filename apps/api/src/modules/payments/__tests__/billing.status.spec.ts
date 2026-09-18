import { billingStatusFromStripe } from '../billing/billing.status';

/** La traduction du statut Stripe d'un abonnement en statut de salon — ADR 0016. */
describe('billingStatusFromStripe', () => {
  it.each([
    ['trialing', 'trialing'],
    ['active', 'active'],
    ['past_due', 'past_due'],
    ['incomplete', 'pending'],
    ['incomplete_expired', 'canceled'],
    ['canceled', 'canceled'],
    ['unpaid', 'canceled'],
    ['paused', 'canceled'],
  ])('traduit « %s » en « %s »', (stripe, salon) => {
    expect(billingStatusFromStripe(stripe)).toBe(salon);
  });

  it('ne décide rien sur un statut inconnu', () => {
    expect(billingStatusFromStripe('something_new')).toBeNull();
  });
});
