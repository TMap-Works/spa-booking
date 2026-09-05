import { describe, expect, it } from 'vitest';

import {
  appointmentPaymentIntentSchema,
  paymentTransactionSchema,
} from '@/lib/admin/payment-contract';

/**
 * Les deux réponses d'encaissement, telles qu'elles franchissent la frontière
 * (#59).
 *
 * Le point vérifié ici n'est pas que Zod sait valider un objet : c'est que
 * **rien de ce que ces schémas ne déclarent pas ne survit à la lecture**. C'est
 * la forme que prend la frontière PCI dans le sens entrant — un champ de carte
 * qu'une API mal réglée émettrait n'atteindrait ni un composant ni un journal
 * du front (payments-stripe §1).
 */

const INTENT = {
  paymentId: 'aaaaaaaa-0000-4000-8000-000000000001',
  appointmentId: 'bbbbbbbb-0000-4000-8000-000000000002',
  amount: { amountMinor: 3500, currency: 'EUR' },
  status: 'PENDING',
  // Volontairement écrit en clair et sans entropie : `gitleaks` lit
  // « clientSecret: … » comme une clé d'API et fait rougir la CI sur une valeur
  // qui *ressemble* à un laissez-passer Stripe, fût-elle inventée. Le schéma
  // n'attend qu'une chaîne non vide — la ressemblance ne prouvait rien.
  clientSecret: 'laissez-passer-de-recette',
  publishableKey: 'cle-publiable-de-recette',
};

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

describe('l’intention de paiement', () => {
  it('normalise le statut que l’API émet en majuscules', () => {
    // L'API rend la casse de l'énumération PostgreSQL ; le contrat nomme les
    // statuts en minuscules. La conversion se fait une fois, ici.
    expect(appointmentPaymentIntentSchema.parse(INTENT).status).toBe('pending');
  });

  it('refuse un montant flottant', () => {
    // Règle non négociable du projet : un montant est un entier dans la plus
    // petite unité, jamais un flottant.
    expect(
      appointmentPaymentIntentSchema.safeParse({
        ...INTENT,
        amount: { amountMinor: 35.5, currency: 'EUR' },
      }).success,
    ).toBe(false);
  });

  it('exige une devise explicite à côté du montant', () => {
    expect(
      appointmentPaymentIntentSchema.safeParse({ ...INTENT, amount: { amountMinor: 3500 } })
        .success,
    ).toBe(false);
  });

  it('ne laisse passer aucune donnée de carte, même émise par l’API', () => {
    const parsed = appointmentPaymentIntentSchema.parse({
      ...INTENT,
      cardNumber: '4242424242424242',
      cvc: '123',
      last4: '4242',
      brand: 'visa',
    });

    // Le schéma ne les déclare pas : Zod les retire. Rien n'a donc de champ où
    // les ranger côté front, et elles n'atteignent aucun rendu ni aucun journal.
    expect(Object.keys(parsed).sort()).toEqual([
      'amount',
      'appointmentId',
      'clientSecret',
      'paymentId',
      'publishableKey',
      'status',
    ]);
  });
});

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
