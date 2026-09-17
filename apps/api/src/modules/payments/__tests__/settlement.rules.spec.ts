import { givesChange, planSettlement, remainingOf, type SaleBalance } from '../settlement.rules';

/**
 * L'arithmétique du règlement, centime par centime — #817.
 *
 * Elle est exercée ici parce qu'elle est **pure** : ni base, ni horloge, ni
 * contexte. Ce que cette suite ne prouve pas, et ne peut pas prouver, c'est la
 * concurrence — deux règlements simultanés de la même vente se jugent contre un
 * vrai PostgreSQL, dans `test/pos-settlement.concurrency-spec.ts`, parce que
 * l'invariant y est tenu par un verrou de ligne et une contrainte, pas par ce
 * fichier.
 *
 * Le ticket de référence est celui du quatrième critère : **78,00 €**, réglé
 * 50,00 € en espèces puis 28,00 € au terminal.
 */

const TICKET_MINOR = 7800;

/** Un ticket ouvert, du montant donné. */
function open(totalAmountMinor = TICKET_MINOR): SaleBalance {
  return { totalAmountMinor, settledAmountMinor: 0, settledAt: null };
}

/** Un ticket partiellement réglé. */
function partial(settledAmountMinor: number): SaleBalance {
  return { totalAmountMinor: TICKET_MINOR, settledAmountMinor, settledAt: null };
}

describe('planSettlement — ce qu’un règlement engage', () => {
  describe('le règlement en une fois', () => {
    it('règle tout le reste dû quand aucun montant n’est précisé', () => {
      expect(planSettlement(open(), { method: 'CASH' })).toEqual({
        outcome: 'apply',
        appliedAmountMinor: TICKET_MINOR,
        changeAmountMinor: 0,
        settlesSale: true,
      });
    });

    it('solde le ticket lorsque la part demandée épuise le reste dû', () => {
      expect(planSettlement(partial(5000), { method: 'CARD', amountMinor: 2800 })).toEqual({
        outcome: 'apply',
        appliedAmountMinor: 2800,
        changeAmountMinor: 0,
        settlesSale: true,
      });
    });
  });

  describe('le règlement mixte — le ticket de 78,00 € du quatrième critère', () => {
    it('laisse le ticket ouvert après le premier versement', () => {
      const first = planSettlement(open(), { method: 'CASH', amountMinor: 5000 });

      expect(first).toEqual({
        outcome: 'apply',
        appliedAmountMinor: 5000,
        changeAmountMinor: 0,
        settlesSale: false,
      });
    });

    it('le solde au second, par un autre moyen', () => {
      const second = planSettlement(partial(5000), { method: 'CARD', amountMinor: 2800 });

      expect(second).toMatchObject({ outcome: 'apply', settlesSale: true });
    });

    it('accepte autant de versements qu’il en faut, tant qu’ils ne dépassent pas', () => {
      // La propriété, et non l'exemple : quelle que soit la découpe, la somme
      // des parts engagées vaut exactement le total, et le dernier versement —
      // et lui seul — solde le ticket.
      let balance = open();
      let engaged = 0;
      const solde: boolean[] = [];

      for (const part of [1000, 2500, 300, 4000]) {
        const plan = planSettlement(balance, { method: 'CASH', amountMinor: part });

        if (plan.outcome !== 'apply') {
          throw new Error(`versement de ${part} refusé : ${plan.outcome}`);
        }

        engaged += plan.appliedAmountMinor;
        solde.push(plan.settlesSale);
        balance = { ...balance, settledAmountMinor: engaged };
      }

      expect({ engaged, solde }).toEqual({
        engaged: TICKET_MINOR,
        solde: [false, false, false, true],
      });
    });
  });

  describe('le dépassement', () => {
    it('refuse une part supérieure au reste dû, et dit ce qui restait', () => {
      expect(planSettlement(partial(5000), { method: 'CARD', amountMinor: 2801 })).toEqual({
        outcome: 'overpayment',
        remainingAmountMinor: 2800,
      });
    });

    it('refuse aussi en espèces lorsque la part est **désignée**', () => {
      // La monnaie ne se déduit pas d'une part : dire « je règle 100,00 € » sur
      // un ticket de 78,00 € est une erreur de saisie, pas un billet tendu.
      expect(planSettlement(open(), { method: 'CASH', amountMinor: 10_000 })).toEqual({
        outcome: 'overpayment',
        remainingAmountMinor: TICKET_MINOR,
      });
    });
  });

  describe('la monnaie rendue — l’exception des espèces', () => {
    it('n’engage que le reste dû et rend la différence', () => {
      expect(planSettlement(open(), { method: 'CASH', tenderedAmountMinor: 10_000 })).toEqual({
        outcome: 'apply',
        appliedAmountMinor: TICKET_MINOR,
        changeAmountMinor: 2200,
        settlesSale: true,
      });
    });

    it('n’est pas de la recette : l’excédent n’entre nulle part', () => {
      const plan = planSettlement(open(), { method: 'CASH', tenderedAmountMinor: 10_000 });

      if (plan.outcome !== 'apply') {
        throw new Error('le billet tendu aurait dû être accepté');
      }

      // Ce que la caisse encaisse plus ce qu'elle rend égale ce qu'elle a reçu.
      expect(plan.appliedAmountMinor + plan.changeAmountMinor).toBe(10_000);
      // Et ce qui s'inscrit en base ne dépasse jamais le ticket.
      expect(plan.appliedAmountMinor).toBeLessThanOrEqual(TICKET_MINOR);
    });

    it('un billet trop petit est un versement partiel, pas un refus', () => {
      expect(planSettlement(open(), { method: 'CASH', tenderedAmountMinor: 5000 })).toEqual({
        outcome: 'apply',
        appliedAmountMinor: 5000,
        changeAmountMinor: 0,
        settlesSale: false,
      });
    });

    it('ne rend la monnaie qu’en espèces', () => {
      expect(givesChange('CASH')).toBe(true);
      expect(givesChange('CARD')).toBe(false);
    });
  });

  describe('le ticket soldé — troisième critère', () => {
    const settledAt = new Date('2026-09-17T09:30:00.000Z');

    it('refuse un règlement de plus, et dit quand il a été soldé', () => {
      expect(
        planSettlement(
          { totalAmountMinor: TICKET_MINOR, settledAmountMinor: TICKET_MINOR, settledAt },
          { method: 'CASH' },
        ),
      ).toEqual({ outcome: 'already-settled', settledAt });
    });

    it('refuse aussi un ticket dont le reste dû est tombé à zéro sans date', () => {
      // Les deux disent la même chose — il n'y a plus rien à encaisser — et le
      // `CHECK` de la base ne les distingue pas davantage.
      expect(
        planSettlement(
          { totalAmountMinor: TICKET_MINOR, settledAmountMinor: TICKET_MINOR, settledAt: null },
          { method: 'CASH', tenderedAmountMinor: 10_000 },
        ),
      ).toEqual({ outcome: 'already-settled', settledAt: null });
    });
  });

  describe('remainingOf', () => {
    it('ne rend jamais un reste négatif', () => {
      // La base l'interdit déjà (`sales_settled_amount_minor_check`) ; la borne
      // est ici pour que la lecture dise la même chose que l'écriture.
      expect(
        remainingOf({ totalAmountMinor: 100, settledAmountMinor: 150, settledAt: null }),
      ).toBe(0);
    });
  });
});
