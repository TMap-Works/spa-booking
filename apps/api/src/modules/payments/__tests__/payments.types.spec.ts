import {
  PaymentCardChannel as PrismaPaymentCardChannel,
  PaymentMethod as PrismaPaymentMethod,
  PaymentStatus as PrismaPaymentStatus,
  RefundStatus as PrismaRefundStatus,
} from '@prisma/client';

import {
  COUNTER_SETTLEMENT_MEANS,
  PAYMENT_CARD_CHANNELS,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  REFUND_STATUSES,
  RESERVING_REFUND_STATUSES,
  SETTLEMENT_MEANS,
  counterSettlementOf,
  settlementMeanOf,
  storedSettlementOf,
} from '../payments.types';

/**
 * Le **témoin** du vocabulaire d'encaissement : les listes que le service et le
 * contrôleur manipulent disent-elles la même chose que les colonnes ?
 *
 * `payments.types.ts` déclare ces libellés à la main plutôt que de les importer
 * du client généré, pour la raison qui vaut dans `appointment-status.ts` et
 * `identity/roles.ts` : ce fichier est lu par des couches auxquelles api-module
 * §2 interdit de connaître Prisma, et une machine sans `prisma generate`
 * verrait sinon échouer des suites qui ne parlent pas du schéma.
 *
 * Le prix de ce choix est la dérive possible, et c'est cette suite qui la
 * rattrape : un sixième statut ajouté à l'énumération PostgreSQL sans être
 * inscrit ici y rougit immédiatement — avant qu'une lecture ne le découvre en
 * production, où il arriverait comme une valeur que le typage jure impossible.
 *
 * L'import de `@prisma/client` est ici et **seulement ici**, comme dans
 * `roles.spec.ts`.
 */
describe('payments — vocabulaire et colonnes', () => {
  it('énumère les deux moyens d’encaissement du CDC §1.4', () => {
    expect(PAYMENT_METHODS).toEqual(['CARD', 'CASH']);
  });

  it('reprend `enum PaymentMethod` du schéma, dans l’ordre de déclaration', () => {
    expect([...PAYMENT_METHODS]).toEqual(Object.values(PrismaPaymentMethod));
  });

  /**
   * **#834 n'a pas touché à `PaymentMethod`**, et cette assertion est ce qui le
   * dit : l'ADR 0014 a écarté la valeur `CARD_TERMINAL` au profit d'un canal,
   * précisément pour ne pas changer en silence le sens du filtre `CARD` chez les
   * consommateurs qui le lisent — la ventilation du revenu, le libellé du reçu,
   * le rapprochement du back-office.
   */
  it('n’a pas gagné de troisième moyen avec le TPE — ADR 0014', () => {
    expect([...PAYMENT_METHODS]).toEqual(['CARD', 'CASH']);
  });

  it('reprend `enum PaymentCardChannel` du schéma, dans l’ordre de déclaration', () => {
    expect([...PAYMENT_CARD_CHANNELS]).toEqual(Object.values(PrismaPaymentCardChannel));
  });

  it('reprend `enum PaymentStatus` du schéma, dans l’ordre de déclaration', () => {
    // L'ordre compte : PostgreSQL ordonne un `enum` par sa déclaration, et un
    // `orderBy: { status: 'asc' }` sur un futur historique des ventes suivrait
    // celui-là.
    expect([...PAYMENT_STATUSES]).toEqual(Object.values(PrismaPaymentStatus));
  });

  it('distingue les deux statuts de remboursement — total et partiel', () => {
    // Le cumul des remboursements ne peut jamais dépasser le montant capturé
    // (payments-stripe §6) : les deux statuts sont ce qui rend la distinction
    // lisible en base avant même que #63 ne l'exploite.
    expect(PAYMENT_STATUSES).toContain('REFUNDED');
    expect(PAYMENT_STATUSES).toContain('PARTIALLY_REFUNDED');
  });

  it('reprend `enum RefundStatus` du schéma, dans l’ordre de déclaration', () => {
    expect([...REFUND_STATUSES]).toEqual(Object.values(PrismaRefundStatus));
  });

  it('réserve son montant dès la demande inscrite, et le relâche au refus', () => {
    // C'est ce partage qui tient le deuxième critère de #63 en présence de
    // concurrence : `PENDING` engage la somme pendant que l'ordre est en vol,
    // `FAILED` la rend de nouveau remboursable. Une liste qui n'inclurait pas
    // `PENDING` laisserait deux comptoirs rendre deux fois le même argent.
    expect(RESERVING_REFUND_STATUSES).toEqual(['PENDING', 'SUCCEEDED']);
    expect(RESERVING_REFUND_STATUSES).not.toContain('FAILED');
    // Et chaque valeur réservante est bien un statut du schéma.
    for (const status of RESERVING_REFUND_STATUSES) {
      expect(REFUND_STATUSES).toContain(status);
    }
  });
});

/**
 * Le **moyen** — ce que la cliente a présenté *et* par quel tuyau — et sa
 * traduction dans les deux colonnes qui le portent (#834, ADR 0014).
 *
 * La propriété qui compte ici n'est pas l'exemple mais l'**aller-retour** : tout
 * moyen se traduit en un couple que `payments_card_channel_check` accepte, et
 * tout couple se relit comme le moyen dont il vient. Une conversion qui perdrait
 * le canal en route ferait passer un règlement au terminal pour une intention
 * Stripe — c'est-à-dire ferait chercher au comptoir, sur son relevé de fin de
 * journée, une ligne qui ne s'y trouve pas.
 */
describe('payments — le moyen et ses deux colonnes', () => {
  it('nomme les trois combinaisons légitimes, et elles seules', () => {
    expect(SETTLEMENT_MEANS).toEqual(['CASH', 'CARD_TERMINAL', 'CARD_ONLINE']);
  });

  it('n’en laisse que deux au comptoir — Stripe n’y est plus, premier critère', () => {
    expect(COUNTER_SETTLEMENT_MEANS).toEqual(['CASH', 'CARD_TERMINAL']);
    expect(COUNTER_SETTLEMENT_MEANS).not.toContain('CARD_ONLINE');
  });

  it.each([
    ['CASH', { method: 'CASH', cardChannel: null }],
    ['CARD_TERMINAL', { method: 'CARD', cardChannel: 'TERMINAL' }],
    ['CARD_ONLINE', { method: 'CARD', cardChannel: 'STRIPE' }],
  ] as const)('traduit « %s » dans les colonnes du schéma', (mean, expected) => {
    expect(storedSettlementOf(mean)).toEqual(expected);
  });

  it('relit chaque couple comme le moyen dont il vient', () => {
    for (const mean of SETTLEMENT_MEANS) {
      const stored = storedSettlementOf(mean);

      expect(settlementMeanOf(stored.method, stored.cardChannel)).toBe(mean);
    }
  });

  it('satisfait `payments_card_channel_check` pour les trois moyens', () => {
    // « Toute carte dit son tuyau, aucune espèce n'en porte » — l'équivalence
    // que la base impose. Une conversion qui la violerait ne se verrait qu'au
    // milieu d'une transaction de règlement, en production.
    for (const mean of SETTLEMENT_MEANS) {
      const stored = storedSettlementOf(mean);

      expect({ mean, coherent: (stored.method === 'CARD') === (stored.cardChannel !== null) }).toEqual({
        mean,
        coherent: true,
      });
    }
  });

  it('range toute carte de comptoir sur le terminal du salon — ADR 0014', () => {
    // C'est l'énoncé du premier critère de #834, rendu mécanique : le comptoir
    // n'a pas d'autre chemin pour une carte, donc le canal se déduit du moyen
    // sans qu'aucun corps de requête n'ait à le dire — ni à pouvoir dire le
    // contraire.
    expect(counterSettlementOf('CARD')).toEqual({ method: 'CARD', cardChannel: 'TERMINAL' });
    expect(counterSettlementOf('CASH')).toEqual({ method: 'CASH', cardChannel: null });
  });
});
