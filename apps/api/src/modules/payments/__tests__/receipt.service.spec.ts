import { NotFoundError } from '../../../common/errors';
import { receiptNumberOf, toSaleReceiptDto } from '../dto/receipt.dto';
import type { ReceiptRepository, ReceiptRow } from '../receipt.repository';
import { refundsOf, ReceiptService, taxBreakdownOf } from '../receipt.service';

/**
 * La composition du ticket de caisse — #818, cinquième et sixième critères.
 *
 * Ce qui se prouve ici : que la pièce **restitue** ce que la base porte, sans
 * rien recalculer de ce que la cliente doit, et que les trois dérivations
 * légitimes — la ventilation de la taxe, la monnaie rendue, le rang des avoirs —
 * donnent la bonne valeur. Le reste — la suite sans trou — ne se prouve que
 * contre un vrai PostgreSQL (`test/pos-receipt.concurrency-spec.ts`).
 */

const EUR = 'EUR';
const SALE_ID = '6a7f1f52-3f1e-4b19-9c0a-1d4e2f5b6c7d';

function issuer(overrides: Partial<ReceiptRow['tenant']> = {}): ReceiptRow['tenant'] {
  return {
    name: 'Barber Tana',
    slug: 'barber-tana',
    legalName: null,
    legalIdType: null,
    legalId: null,
    vatNumber: null,
    addressLine1: null,
    addressLine2: null,
    postalCode: null,
    city: null,
    countryCode: null,
    contactEmail: null,
    contactPhone: null,
    receiptFooter: null,
    receiptPrefix: 'TIC',
    timezone: 'Europe/Paris',
    defaultLocale: 'fr',
    ...overrides,
  };
}

/** Le ticket de 65,00 € à 20 % — celui qui met la ventilation à l'épreuve. */
function row(overrides: Partial<ReceiptRow> = {}): ReceiptRow {
  return {
    id: SALE_ID,
    receiptNumber: 123,
    settledAt: new Date('2026-09-17T09:30:00.000Z'),
    createdAt: new Date('2026-09-17T09:00:00.000Z'),
    currency: EUR,
    subtotalAmountMinor: 5417,
    taxAmountMinor: 1083,
    taxRateBps: 2000,
    tipAmountMinor: 0,
    totalAmountMinor: 6500,
    tenant: issuer(),
    cashier: { firstName: 'Camille', lastName: 'Roux' },
    appointment: null,
    items: [
      {
        position: 0,
        kind: 'SERVICE',
        label: 'Soin éclat 45 min',
        quantity: 1,
        unitAmountMinor: 6500,
        lineAmountMinor: 6500,
        currency: EUR,
      },
    ],
    payments: [],
    ...overrides,
  };
}

function serviceFor(value: ReceiptRow | null): ReceiptService {
  const repository = {
    findReceiptBySaleId: () => Promise.resolve(value),
  } as unknown as ReceiptRepository;

  return new ReceiptService(repository);
}

describe('ReceiptService — la pièce comptable', () => {
  it('restitue les montants figés du ticket, sans rien recalculer', async () => {
    const receipt = await serviceFor(row()).bySaleId(SALE_ID);

    expect({
      subtotal: receipt.subtotal,
      taxTotal: receipt.taxTotal,
      tip: receipt.tip,
      total: receipt.total,
    }).toEqual({
      subtotal: { amountMinor: 5417, currency: EUR },
      taxTotal: { amountMinor: 1083, currency: EUR },
      tip: { amountMinor: 0, currency: EUR },
      total: { amountMinor: 6500, currency: EUR },
    });
  });

  it('nomme le caissier, et laisse cliente et praticien nuls sur une vente retail', async () => {
    const receipt = await serviceFor(row()).bySaleId(SALE_ID);

    expect(receipt.cashier).toEqual({ displayName: 'Camille Roux' });
    expect(receipt.client).toBeNull();
    expect(receipt.practitioner).toBeNull();
  });

  it('nomme la cliente et le praticien d’une vente adossée à un rendez-vous', async () => {
    const receipt = await serviceFor(
      row({
        appointment: {
          client: { firstName: 'Alice', lastName: 'Martin' },
          staff: { displayName: 'Camille' },
        },
      }),
    ).bySaleId(SALE_ID);

    expect(receipt.client).toEqual({ displayName: 'Alice Martin' });
    expect(receipt.practitioner).toEqual({ displayName: 'Camille' });
  });

  it('lève `NotFoundError` sur un ticket inconnu — ou du salon voisin', async () => {
    // Les deux refus sont **indiscernables** : la lecture est scopée, elle n'a
    // simplement rien rendu (tenant-isolation §4).
    await expect(serviceFor(null).bySaleId(SALE_ID)).rejects.toBeInstanceOf(NotFoundError);
  });
});

describe('La ventilation de la taxe — cinquième critère', () => {
  it('porte le taux **figé sur le ticket**, et non celui déduit des montants', () => {
    // La raison d'être de `sales.tax_rate_bps` : 1083 / 5417 rend 19,99 %, et
    // une pièce comptable ne peut pas annoncer un taux faux d'un point de base.
    expect(taxBreakdownOf(row())).toEqual([
      {
        rateBps: 2000,
        base: { amountMinor: 5417, currency: EUR },
        tax: { amountMinor: 1083, currency: EUR },
      },
    ]);
  });

  it('ne rend aucune ligne quand il n’y a pas de taxe', () => {
    // « 0,00 € à 0 % » sur le reçu d'un salon non assujetti serait une ligne qui
    // ne veut rien dire.
    expect(taxBreakdownOf(row({ taxAmountMinor: 0, taxRateBps: 0 }))).toEqual([]);
  });
});

describe('Les règlements — moyen, montant, monnaie rendue', () => {
  const settlement = (overrides: Partial<ReceiptRow['payments'][number]> = {}) => ({
    method: 'CASH',
    cardChannel: null,
    amountMinor: 6500,
    currency: EUR,
    tenderedAmountMinor: null,
    terminalReference: null,
    capturedAt: new Date('2026-09-17T09:30:00.000Z'),
    refunds: [],
    ...overrides,
  });

  it('déduit la monnaie du billet tendu, sans jamais l’encaisser', async () => {
    const receipt = await serviceFor(
      row({ payments: [settlement({ tenderedAmountMinor: 10_000 })] }),
    ).bySaleId(SALE_ID);

    expect(receipt.settlements).toEqual([
      {
        method: 'CASH',
        cardChannel: null,
        amount: { amountMinor: 6500, currency: EUR },
        tendered: { amountMinor: 10_000, currency: EUR },
        change: { amountMinor: 3500, currency: EUR },
        terminalReference: null,
        capturedAt: new Date('2026-09-17T09:30:00.000Z'),
      },
    ]);
  });

  it('ne parle ni de billet ni de monnaie sur un passage au terminal', async () => {
    const receipt = await serviceFor(
      row({ payments: [settlement({ method: 'CARD', cardChannel: 'TERMINAL' })] }),
    ).bySaleId(SALE_ID);

    expect(receipt.settlements[0]).toMatchObject({ method: 'CARD', tendered: null, change: null });
  });

  /**
   * **#1027, premier point.** Le canal est recopié tel que la colonne le porte,
   * sans repli : c'est lui qui distingue le TPE du salon de l'intention du
   * tunnel public, et le reçu ne peut pas libeller sa ligne sans lui. Une carte
   * antérieure à #834 porte un canal nul, et se lit telle quelle.
   */
  it('porte le canal de la carte, canal nul compris', async () => {
    const terminal = await serviceFor(
      row({ payments: [settlement({ method: 'CARD', cardChannel: 'TERMINAL' })] }),
    ).bySaleId(SALE_ID);
    const online = await serviceFor(
      row({ payments: [settlement({ method: 'CARD', cardChannel: 'STRIPE' })] }),
    ).bySaleId(SALE_ID);
    const legacy = await serviceFor(
      row({ payments: [settlement({ method: 'CARD' })] }),
    ).bySaleId(SALE_ID);

    expect(terminal.settlements[0]?.cardChannel).toBe('TERMINAL');
    expect(online.settlements[0]?.cardChannel).toBe('STRIPE');
    expect(legacy.settlements[0]?.cardChannel).toBeNull();
  });

  it('omet les deux clés du reçu servi plutôt que de rendre `null`', async () => {
    const receipt = await serviceFor(
      row({ payments: [settlement({ method: 'CARD', cardChannel: 'STRIPE' })] }),
    ).bySaleId(SALE_ID);

    // Le canal, lui, est **toujours** servi — `null` compris : le contrat le
    // déclare facultatif pour rester additif, l'API ne l'omet jamais.
    expect(toSaleReceiptDto(receipt).settlements[0]).toEqual({
      method: 'CARD',
      cardChannel: 'STRIPE',
      amount: { amountMinor: 6500, currency: EUR },
      capturedAt: '2026-09-17T09:30:00.000Z',
    });
  });
});

describe('Les avoirs — sixième critère', () => {
  const refund = (id: string, at: string, amountMinor: number) => ({
    id,
    amountMinor,
    currency: EUR,
    reason: 'Prestation écourtée',
    createdAt: new Date(at),
  });

  it('range les avoirs de **tous** les encaissements dans un ordre unique', () => {
    // Les remboursements vivent sous les encaissements ; une pièce de caisse les
    // porte tous ensemble, et c'est leur ordre qui donne son rang à chacun.
    const payments = [
      {
        method: 'CASH',
        cardChannel: null,
        amountMinor: 5000,
        currency: EUR,
        tenderedAmountMinor: null,
        terminalReference: null,
        capturedAt: null,
        refunds: [refund('b', '2026-09-17T11:00:00.000Z', 500)],
      },
      {
        method: 'CARD',
        cardChannel: null,
        amountMinor: 1500,
        currency: EUR,
        tenderedAmountMinor: null,
        terminalReference: null,
        capturedAt: null,
        refunds: [refund('a', '2026-09-17T10:00:00.000Z', 300)],
      },
    ];

    expect(refundsOf(payments).map((entry) => ({ rank: entry.rank, at: entry.issuedAt }))).toEqual([
      { rank: 1, at: new Date('2026-09-17T10:00:00.000Z') },
      { rank: 2, at: new Date('2026-09-17T11:00:00.000Z') },
    ]);
  });

  it('départage deux avoirs du même instant par leur identifiant, pour un rang stable', () => {
    const payments = [
      {
        method: 'CASH',
        cardChannel: null,
        amountMinor: 5000,
        currency: EUR,
        tenderedAmountMinor: null,
        terminalReference: null,
        capturedAt: null,
        refunds: [
          refund('b', '2026-09-17T10:00:00.000Z', 300),
          refund('a', '2026-09-17T10:00:00.000Z', 200),
        ],
      },
    ];

    expect(refundsOf(payments).map((entry) => entry.amount.amountMinor)).toEqual([200, 300]);
  });

  it('la vente **garde** son numéro, et chaque avoir cite celui-ci', async () => {
    const receipt = await serviceFor(
      row({
        payments: [
          {
            method: 'CASH',
            cardChannel: null,
            amountMinor: 6500,
            currency: EUR,
            tenderedAmountMinor: null,
            terminalReference: null,
            capturedAt: null,
            refunds: [
              refund('a', '2026-09-17T10:00:00.000Z', 1000),
              refund('b', '2026-09-17T11:00:00.000Z', 500),
            ],
          },
        ],
      }),
    ).bySaleId(SALE_ID);

    const dto = toSaleReceiptDto(receipt);

    expect(dto.number).toBe('TIC-2026-000123');
    expect(dto.refunds.map((entry) => ({ number: entry.number, origin: entry.origin }))).toEqual([
      { number: 'TIC-2026-000123-R1', origin: 'TIC-2026-000123' },
      { number: 'TIC-2026-000123-R2', origin: 'TIC-2026-000123' },
    ]);
  });
});

describe('Le numéro affiché — deuxième critère', () => {
  it('compose préfixe, année de la pièce et rang', async () => {
    expect(receiptNumberOf(await serviceFor(row()).bySaleId(SALE_ID))).toBe('TIC-2026-000123');
  });

  it('lit l’année **dans le fuseau du salon**, jamais sur l’instant brut', async () => {
    // 00 h 05 le 1er janvier à Paris, c'est 23 h 05 le 31 décembre en UTC :
    // lire l'année sur l'instant aurait daté la pièce de l'exercice précédent.
    const receipt = await serviceFor(
      row({ settledAt: new Date('2026-12-31T23:05:00.000Z') }),
    ).bySaleId(SALE_ID);

    expect(receiptNumberOf(receipt)).toBe('TIC-2027-000123');
  });

  it('suit le préfixe de l’établissement', async () => {
    const receipt = await serviceFor(
      row({ tenant: issuer({ receiptPrefix: 'BT2026' }) }),
    ).bySaleId(SALE_ID);

    expect(receiptNumberOf(receipt)).toBe('BT2026-2026-000123');
  });

  it('ne rend aucun numéro tant que le ticket n’est pas clos — c’est un proforma', async () => {
    // Le rang est pris à la clôture, dans la transaction qui pose `settled_at` :
    // en attribuer un ici percerait la suite à chaque consultation.
    const receipt = await serviceFor(row({ receiptNumber: null, settledAt: null })).bySaleId(
      SALE_ID,
    );

    expect(receiptNumberOf(receipt)).toBeNull();
    expect(toSaleReceiptDto(receipt).number).toBeNull();
  });
});

describe('L’émetteur — identité légale et coordonnées', () => {
  it('porte les cinq champs saisis, et l’adresse d’un bloc', async () => {
    const receipt = await serviceFor(
      row({
        tenant: issuer({
          legalName: 'TANA COIFFURE SARL',
          legalIdType: 'SIRET',
          legalId: '73282932000074',
          vatNumber: 'FR40303265045',
          addressLine1: '12 rue des Lilas',
          postalCode: '75011',
          city: 'Paris',
          countryCode: 'FR',
          contactEmail: 'contact@barber-tana.test',
          receiptFooter: 'Merci de votre visite.',
        }),
      }),
    ).bySaleId(SALE_ID);

    expect(toSaleReceiptDto(receipt).issuer).toEqual({
      name: 'Barber Tana',
      legalName: 'TANA COIFFURE SARL',
      legalIdType: 'SIRET',
      legalId: '73282932000074',
      vatNumber: 'FR40303265045',
      address: { line1: '12 rue des Lilas', postalCode: '75011', city: 'Paris', country: 'FR' },
      contactEmail: 'contact@barber-tana.test',
      footer: 'Merci de votre visite.',
    });
  });

  it('sert le reçu d’un salon qui n’a rien saisi — la migration est additive', async () => {
    // Un établissement inscrit avant #818 n'a ni raison sociale, ni identifiant
    // d'entreprise : son reçu doit continuer d'être servi, avec les clés omises
    // plutôt que rendues nulles.
    expect(toSaleReceiptDto(await serviceFor(row()).bySaleId(SALE_ID)).issuer).toEqual({
      name: 'Barber Tana',
    });
  });

  /**
   * **#1230** — la langue de l'établissement est le repli de la langue du PDF.
   *
   * Elle est lue dans le domaine et **jamais servie** dans le reçu JSON : le
   * contrat partagé n'en porte pas, et un champ de plus dans la réponse serait
   * un champ que personne ne lit. Même régime que `slug`.
   */
  it('porte la langue de l’établissement dans le domaine, sans la servir', async () => {
    const receipt = await serviceFor(row({ tenant: issuer({ defaultLocale: 'en' }) })).bySaleId(
      SALE_ID,
    );

    expect(receipt.issuer.defaultLocale).toBe('en');
    expect(JSON.stringify(toSaleReceiptDto(receipt))).not.toContain('defaultLocale');
  });

  /**
   * La colonne est un `VARCHAR(5)` borné par une contrainte `CHECK`, ce que le
   * système de types ne voit pas. Une valeur posée hors de l'application — la
   * seule que la contrainte n'exclut pas — ne doit pas faire tomber l'impression
   * d'un ticket au comptoir : elle se replie sur la langue par défaut du système.
   */
  it('se replie sur la langue du système quand la colonne porte autre chose', async () => {
    const receipt = await serviceFor(row({ tenant: issuer({ defaultLocale: 'de' }) })).bySaleId(
      SALE_ID,
    );

    expect(receipt.issuer.defaultLocale).toBe('en');
  });

  it('n’expose pas une adresse incomplète — le triplet minimal ou rien', async () => {
    const receipt = await serviceFor(
      row({ tenant: issuer({ addressLine1: '12 rue des Lilas', postalCode: '75011' }) }),
    ).bySaleId(SALE_ID);

    expect(toSaleReceiptDto(receipt).issuer.address).toBeUndefined();
  });

  it('n’expose ni `tenantId` ni aucun identifiant de personne', async () => {
    const dto = toSaleReceiptDto(
      await serviceFor(
        row({
          appointment: {
            client: { firstName: 'Alice', lastName: 'Martin' },
            staff: { displayName: 'Camille' },
          },
        }),
      ).bySaleId(SALE_ID),
    );

    const serialized = JSON.stringify(dto);

    expect(serialized).not.toContain('tenantId');
    expect(serialized).not.toContain('cashierUserId');
    expect(Object.keys(dto.cashier)).toEqual(['displayName']);
  });
});
