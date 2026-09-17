import { planSaleBackfill, type OrphanPaymentFacts } from '../pos.sale-backfill';

/**
 * La reprise des encaissements d'avant #817, partie **décision** — septième
 * critère.
 *
 * La partie pure est exercée ici ; l'écriture, elle, l'est contre un vrai
 * PostgreSQL (`test/pos-settlement.concurrency-spec.ts`) — un plan juste ne
 * prouve pas qu'une transaction écrit ce qu'il dit.
 *
 * Le jeu de cas reprend le constat de l'issue, relevé sur `spa_dev` :
 * onze ventes sans encaissement chez Barber Tana, et chez Spa Lumière une vente
 * de 106,80 € adossée à un paiement de 65,00 € qui ne se connaissaient pas.
 */

const APPOINTMENT = '5f2f4a1e-1c2b-4d3e-8f4a-9b0c1d2e3f40';
const SALE = 'a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d';

function facts(overrides: Partial<OrphanPaymentFacts> = {}): OrphanPaymentFacts {
  return {
    appointmentId: APPOINTMENT,
    existingSaleId: null,
    amountMinor: 6500,
    captured: true,
    ...overrides,
  };
}

describe('planSaleBackfill — ce qu’on fait d’un encaissement sans vente', () => {
  it('crée la vente manquante d’un encaissement qui n’en a aucune', () => {
    expect(planSaleBackfill(facts())).toEqual({ action: 'create' });
  });

  it('crée aussi celle d’un encaissement sans rendez-vous', () => {
    expect(planSaleBackfill(facts({ appointmentId: null }))).toEqual({ action: 'create' });
  });

  it('rattache plutôt que de créer quand le rendez-vous a déjà son ticket', () => {
    // Le cas de Spa Lumière : la vente de 106,80 € et l'encaissement de 65,00 €
    // portent le même rendez-vous. En créer une seconde doublerait le revenu du
    // jour dès que le reporting lit les ventes réglées (sixième critère).
    expect(planSaleBackfill(facts({ existingSaleId: SALE }))).toEqual({
      action: 'attach',
      saleId: SALE,
    });
  });

  it('n’invente aucune pièce pour un encaissement qui n’a rien capturé', () => {
    // Une intention abandonnée ou une carte refusée n'a pas de recette derrière
    // elle. Lui fabriquer une vente ferait apparaître un chiffre d'affaires que
    // personne n'a encaissé — exactement le défaut que l'issue reproche à
    // l'existant, mais dans l'autre sens.
    expect(planSaleBackfill(facts({ captured: false }))).toEqual({
      action: 'skip',
      reason: 'non-capturé',
    });
  });

  it('ne rattache pas davantage un encaissement non capturé à une vente existante', () => {
    // L'ordre des règles compte : « non capturé » l'emporte sur « une vente
    // existe ». Rattacher ferait avancer le compte du ticket d'une somme qui
    // n'a jamais été prise, et le rendrait impossible à régler pour de bon.
    expect(planSaleBackfill(facts({ captured: false, existingSaleId: SALE }))).toEqual({
      action: 'skip',
      reason: 'non-capturé',
    });
  });

  it('est indifférent au montant — il ne décide pas, il n’est que recopié', () => {
    for (const amountMinor of [1, 6500, 2_147_483_647]) {
      expect(planSaleBackfill(facts({ amountMinor }))).toEqual({ action: 'create' });
    }
  });
});
