import { describe, expect, it } from 'vitest';

import {
  formatReceiptPhone,
  formatTaxRate,
  issuerAddressLines,
  legalIdLine,
  settlementLabel,
  soldLines,
  taxTableRows,
} from '@/lib/admin/receipt-ticket';
import { formatTicketDateTime } from '@/lib/format';

/**
 * La mise en forme du ticket de caisse — ce qui se décide sans DOM.
 */
describe('le ticket de caisse', () => {
  // L'espace du « % » français est **insécable** (U+00A0) : c'est `Intl` qui la
  // pose, et un taux ne se coupe pas en fin de ligne sur un rouleau de 80 mm.
  it('écrit un taux en points de base comme un pourcentage français', () => {
    expect(formatTaxRate(2000)).toBe('20 %');
    expect(formatTaxRate(550)).toBe('5,5 %');
    expect(formatTaxRate(210)).toBe('2,1 %');
    expect(formatTaxRate(0)).toBe('0 %');
  });

  // …et l'anglais n'en met pas du tout : « 20% », collé.
  it('écrit le même taux à l’anglaise quand la session est en anglais', () => {
    expect(formatTaxRate(2000, { locale: 'en', countryCode: 'US' })).toBe('20%');
    expect(formatTaxRate(550, { locale: 'en', countryCode: 'US' })).toBe('5.5%');
  });

  it('présente la TVA comme une grande surface : taux, HT, TVA, TTC', () => {
    const [row] = taxTableRows([
      {
        rateBps: 2000,
        base: { amountMinor: 5417, currency: 'EUR' },
        tax: { amountMinor: 1083, currency: 'EUR' },
      },
    ]);

    expect(row?.rate).toBe('20 %');
    expect(row?.total).toEqual({ amountMinor: 6500, currency: 'EUR' });
  });

  it('nomme l’identifiant légal par sa nature — SIRET, NIF, STAT', () => {
    expect(legalIdLine({ name: 'Barber Tana', legalIdType: 'NIF', legalId: '3000123456' })).toBe(
      'NIF 3000123456',
    );
    expect(legalIdLine({ name: 'Barber Tana' })).toBeNull();
  });

  it('écrit l’adresse dans l’ordre d’une enveloppe, sans ligne vide', () => {
    expect(
      issuerAddressLines({
        name: 'Maison Lotus',
        address: { line1: '12 rue des Lilas', postalCode: '75011', city: 'Paris', country: 'FR' },
      }),
    ).toEqual(['12 rue des Lilas', '75011 Paris']);
  });

  it('ne compte pas la taxe ni le pourboire parmi les articles vendus', () => {
    const money = { amountMinor: 100, currency: 'EUR' };
    const line = { quantity: 1, unitPrice: money, total: money, label: 'x' };

    expect(
      soldLines([
        { ...line, position: 0, kind: 'SERVICE' },
        { ...line, position: 1, kind: 'PRODUCT' },
        { ...line, position: 2, kind: 'TAX' },
        { ...line, position: 3, kind: 'TIP' },
      ]).map((sold) => sold.kind),
    ).toEqual(['SERVICE', 'PRODUCT']);
  });

  it('horodate dans le fuseau du salon, au format court d’un rouleau', () => {
    expect(formatTicketDateTime('2026-09-05T07:05:00.000Z', 'Indian/Antananarivo')).toBe(
      '05/09/2026 10:05',
    );
  });

  it('écrit le téléphone comme dans le pays, pas en E.164', () => {
    expect(formatReceiptPhone('+33142000000')).toBe('01 42 00 00 00');
    expect(formatReceiptPhone('+261341234567')).toBe('034 12 345 67');
    expect(formatReceiptPhone('+14155550100')).toBe('+14155550100');
  });

  /**
   * Le libellé d'un règlement — #1217.
   *
   * Les trois lignes de la table de l'issue sont figées ici, et avec elles la
   * seule chose qui compte au rapprochement : de quel relevé la ligne se
   * rapproche. Ce sont les mots que `formatSettlementMethod` imprime sur le PDF
   * (`apps/api/.../receipt-pdf/receipt-pdf.format.ts`) — l'écran et le papier
   * sont la même pièce.
   */
  describe('le libellé d’un règlement', () => {
    it('nomme le tuyau de la carte, et non le seul moyen', () => {
      expect(settlementLabel({ method: 'CARD', cardChannel: 'TERMINAL' })).toBe(
        'Carte bancaire (TPE)',
      );
      expect(settlementLabel({ method: 'CARD', cardChannel: 'STRIPE' })).toBe(
        'Carte bancaire (en ligne)',
      );
      expect(settlementLabel({ method: 'CASH', cardChannel: null })).toBe('Espèces');
    });

    /*
     * Un canal nul ne peut être qu'une carte antérieure à #834 : le TPE
     * n'existait pas alors. L'imprimer « TPE » inventerait un passage au
     * terminal, et enverrait le rapprochement sur le mauvais relevé.
     */
    it('imprime une carte sans canal comme une carte en ligne, jamais comme un TPE', () => {
      expect(settlementLabel({ method: 'CARD', cardChannel: null })).toBe(
        'Carte bancaire (en ligne)',
      );
      expect(settlementLabel({ method: 'CARD' })).toBe('Carte bancaire (en ligne)');
    });

    it('n’accole la référence qu’au canal TERMINAL', () => {
      expect(
        settlementLabel({ method: 'CARD', cardChannel: 'TERMINAL', terminalReference: 'A1B2C3' }),
      ).toBe('Carte bancaire (TPE) — réf. A1B2C3');
      expect(
        settlementLabel({ method: 'CARD', cardChannel: 'STRIPE', terminalReference: 'A1B2C3' }),
      ).toBe('Carte bancaire (en ligne)');
    });

    /*
     * `terminalReference` est **omise** par le contrat quand la colonne est
     * nulle, là où l'API la porte en `string | null` : les deux formes, et la
     * référence blanche, n'ont rien à accoler.
     */
    it('ne laisse pas un tiret orphelin quand la référence manque ou est blanche', () => {
      expect(settlementLabel({ method: 'CARD', cardChannel: 'TERMINAL' })).toBe(
        'Carte bancaire (TPE)',
      );
      expect(
        settlementLabel({ method: 'CARD', cardChannel: 'TERMINAL', terminalReference: '   ' }),
      ).toBe('Carte bancaire (TPE)');
    });

    /* Les mots viennent du catalogue : le produit sert l'anglais par défaut. */
    it('dit les mêmes trois choses en anglais', () => {
      expect(settlementLabel({ method: 'CASH' }, 'en')).toBe('Cash');
      expect(settlementLabel({ method: 'CARD', cardChannel: 'TERMINAL' }, 'en')).toBe(
        'Bank card (terminal)',
      );
      expect(settlementLabel({ method: 'CARD', cardChannel: 'STRIPE' }, 'en')).toBe(
        'Bank card (online)',
      );
      expect(
        settlementLabel({ method: 'CARD', cardChannel: 'TERMINAL', terminalReference: 'A1B2C3' }, 'en'),
      ).toBe('Bank card (terminal) — ref. A1B2C3');
    });

    /*
     * La frontière PCI tient par la forme : le libellé ne compose que le canal
     * et la référence d'opération du terminal — aucune marque, aucun porteur,
     * aucun chiffre de carte n'existe dans le contrat du reçu
     * (payments-stripe §1).
     *
     * C'est l'**égalité stricte** qui le prouve, et non une borne sur les
     * chiffres : une référence de TPE est le plus souvent numérique —
     * `A0000123` est l'exemple même du DTO —, et « aucun groupe de quatre
     * chiffres » confondrait un numéro d'opération légitime avec une donnée de
     * carte. La référence est reprise telle quelle, elle n'est pas masquée.
     */
    it('ne compose jamais autre chose que le canal et la référence d’opération', () => {
      expect(
        settlementLabel({
          method: 'CARD',
          cardChannel: 'TERMINAL',
          terminalReference: 'A0000123',
        }),
      ).toBe('Carte bancaire (TPE) — réf. A0000123');
    });

    /*
     * La référence est **recopiée**, jamais interprétée : `replaceAll` donne un
     * sens à `$&` dans une chaîne de remplacement, et le contrat ne borne pas la
     * forme en lecture (`z.string()` — une reprise de données peut en porter
     * n'importe quelle ponctuation). Le PDF, qui compose par littéral gabarit,
     * la recopie déjà telle quelle ; l'écran doit dire le même mot.
     */
    it('recopie la référence telle quelle, ponctuation comprise', () => {
      expect(
        settlementLabel({ method: 'CARD', cardChannel: 'TERMINAL', terminalReference: "A$&B$'C" }),
      ).toBe("Carte bancaire (TPE) — réf. A$&B$'C");
    });
  });
});
