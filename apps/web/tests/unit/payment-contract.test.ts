import { describe, expect, it } from 'vitest';

import { paymentTransactionSchema, saleSummarySchema } from '@/lib/admin/payment-contract';

/**
 * Les réponses d'encaissement, telles qu'elles franchissent la frontière (#59,
 * reprises par #835).
 *
 * Le point vérifié ici n'est pas que Zod sait valider un objet : c'est que
 * **rien de ce que ces schémas ne déclarent pas ne survit à la lecture**. C'est
 * la forme que prend la frontière PCI dans le sens entrant — un champ de carte
 * qu'une API mal réglée émettrait n'atteindrait ni un composant ni un journal
 * du front (payments-stripe §1).
 */

const TRANSACTION = {
  id: 'cccccccc-0000-4000-8000-000000000003',
  appointmentId: 'bbbbbbbb-0000-4000-8000-000000000002',
  amount: { amountMinor: 3500, currency: 'EUR' },
  refunded: { amountMinor: 0, currency: 'EUR' },
  method: 'CASH',
  status: 'SUCCEEDED',
  providerPaymentIntentId: null,
  providerChargeId: null,
  capturedAt: '2026-09-05T09:30:00.000Z',
  createdAt: '2026-09-05T09:30:00.000Z',
};

describe('l’encaissement inscrit', () => {
  it('normalise le moyen et le statut', () => {
    const parsed = paymentTransactionSchema.parse(TRANSACTION);

    expect(parsed.method).toBe('cash');
    expect(parsed.status).toBe('succeeded');
  });

  it('accepte un instant de capture nul — l’API émet `null`, pas une absence', () => {
    const parsed = paymentTransactionSchema.parse({ ...TRANSACTION, capturedAt: null });

    expect(parsed.capturedAt).toBeNull();
  });

  it('ne porte ni référence de prestataire, ni donnée de carte', () => {
    // Les références Stripe servent le rapprochement, au seuil `MANAGER`. Le
    // comptoir encaisse ; son ticket n'a pas à les porter.
    const parsed = paymentTransactionSchema.parse({ ...TRANSACTION, last4: '4242' });

    expect(parsed).not.toHaveProperty('providerPaymentIntentId');
    expect(parsed).not.toHaveProperty('providerChargeId');
    expect(parsed).not.toHaveProperty('last4');
  });
});

describe('le ticket de caisse, tel que le comptoir le relit', () => {
  const SALE = {
    id: 'dddddddd-0000-4000-8000-000000000004',
    appointmentId: 'bbbbbbbb-0000-4000-8000-000000000002',
    cashierUserId: 'eeeeeeee-0000-4000-8000-000000000005',
    subtotal: { amountMinor: 7800, currency: 'EUR' },
    tax: { amountMinor: 0, currency: 'EUR' },
    tip: { amountMinor: 0, currency: 'EUR' },
    total: { amountMinor: 7800, currency: 'EUR' },
    settled: { amountMinor: 5000, currency: 'EUR' },
    remaining: { amountMinor: 2800, currency: 'EUR' },
    settledAt: null,
    createdAt: '2026-09-05T09:30:00.000Z',
  };

  it('porte le reste dû que le serveur calcule, et non une soustraction du front', () => {
    // C'est ce champ, et lui seul, qui fait descendre l'écran jusqu'à zéro au
    // cours d'un règlement mixte (#835, quatrième critère).
    const parsed = saleSummarySchema.parse(SALE);

    expect(parsed.settled.amountMinor).toBe(5000);
    expect(parsed.remaining.amountMinor).toBe(2800);
    expect(parsed.settledAt).toBeNull();
  });

  it('refuse un reste dû négatif — la base l’interdit, le contrat aussi', () => {
    expect(
      saleSummarySchema.safeParse({
        ...SALE,
        remaining: { amountMinor: -100, currency: 'EUR' },
      }).success,
    ).toBe(false);
  });

  it('retire tout champ que l’API ajouterait, données de carte comprises', () => {
    const parsed = saleSummarySchema.parse({ ...SALE, last4: '4242', brand: 'visa' });

    expect(parsed).not.toHaveProperty('last4');
    expect(parsed).not.toHaveProperty('brand');
  });
});
