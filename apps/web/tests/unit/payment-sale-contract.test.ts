import { describe, expect, it } from 'vitest';

import {
  productSchema,
  salePageSchema,
  saleSchema,
  saleSummarySchema,
} from '@/lib/admin/payment-contract';

/**
 * Le rayon et le ticket de caisse, tels qu'ils franchissent la frontière (#61).
 *
 * Comme pour les deux réponses d'encaissement de #59, le point vérifié n'est pas
 * que Zod sait valider un objet : c'est que **rien de ce que ces schémas ne
 * déclarent pas ne survit à la lecture**, et qu'un montant ne se sépare jamais
 * de sa devise. Ce sont les deux propriétés de forme sur lesquelles repose tout
 * le reste de l'écran de caisse.
 */

const PRODUCT = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001',
  sku: 'SH-01',
  name: 'Shampoing hydratant 250 ml',
  priceAmountMinor: 1850,
  currency: 'EUR',
  isActive: true,
};

const SALE_ITEM = {
  id: 'bbbbbbbb-0000-4000-8000-000000000002',
  kind: 'PRODUCT',
  serviceId: null,
  productId: PRODUCT.id,
  label: 'Shampoing hydratant 250 ml',
  quantity: 2,
  unitAmount: { amountMinor: 1850, currency: 'EUR' },
  lineAmount: { amountMinor: 3700, currency: 'EUR' },
  position: 0,
};

const SALE = {
  id: 'cccccccc-0000-4000-8000-000000000003',
  appointmentId: null,
  cashierUserId: 'dddddddd-0000-4000-8000-000000000004',
  subtotal: { amountMinor: 3700, currency: 'EUR' },
  tax: { amountMinor: 740, currency: 'EUR' },
  tip: { amountMinor: 0, currency: 'EUR' },
  total: { amountMinor: 4440, currency: 'EUR' },
  items: [SALE_ITEM],
  createdAt: '2026-09-06T09:30:00.000Z',
};

describe('un article du rayon', () => {
  it('recompose le montant et sa devise en un seul objet', () => {
    // L'API les sert à plat. Deux champs indépendants sont deux champs qu'un
    // composant peut lire séparément — c'est comme cela qu'un prix finit par
    // s'afficher sans devise.
    const parsed = productSchema.parse(PRODUCT);

    expect(parsed.price).toEqual({ amountMinor: 1850, currency: 'EUR' });
    expect(parsed).not.toHaveProperty('priceAmountMinor');
    expect(parsed).not.toHaveProperty('currency');
  });

  it('refuse un prix flottant', () => {
    // Règle non négociable du projet : un montant est un entier dans la plus
    // petite unité monétaire, jamais un flottant.
    expect(productSchema.safeParse({ ...PRODUCT, priceAmountMinor: 18.5 }).success).toBe(false);
  });

  it('refuse un prix négatif', () => {
    expect(productSchema.safeParse({ ...PRODUCT, priceAmountMinor: -1 }).success).toBe(false);
  });

  it('accepte un article retiré du rayon', () => {
    // Un ticket ouvert avant le retrait doit pouvoir expliquer pourquoi le
    // serveur refuse maintenant.
    expect(productSchema.parse({ ...PRODUCT, isActive: false }).isActive).toBe(false);
  });
});

describe('une ligne de ticket', () => {
  it('garde la nature dans la casse où l’API l’émet et l’attend', () => {
    // C'est aussi le `kind` envoyé dans `POST /sales` : le normaliser ici
    // obligerait à le remajusculer à l'aller, et un aller-retour qui traverse
    // deux formes de la même valeur est l'endroit où l'une finit oubliée.
    expect(saleSchema.parse(SALE).items[0]?.kind).toBe('PRODUCT');
  });

  it('accepte les natures que seul le serveur compose', () => {
    // `TAX` et `TIP` sont des lignes de reçu, jamais des colonnes du ticket
    // (payments-stripe §5).
    for (const kind of ['SERVICE', 'TAX', 'TIP']) {
      expect(
        saleSchema.safeParse({ ...SALE, items: [{ ...SALE_ITEM, kind }] }).success,
      ).toBe(true);
    }

    expect(
      saleSchema.safeParse({ ...SALE, items: [{ ...SALE_ITEM, kind: 'REMISE' }] }).success,
    ).toBe(false);
  });

  it('accepte des références nulles — l’API émet `null`, pas une absence', () => {
    const parsed = saleSchema.parse(SALE);

    expect(parsed.items[0]?.serviceId).toBeNull();
    expect(parsed.items[0]?.productId).toBe(PRODUCT.id);
  });

  it('lit le montant de ligne du serveur plutôt que de le recalculer', () => {
    // Le schéma n'impose pas `unitAmount × quantity` : cette égalité est
    // vérifiée par une contrainte de la base, et la revérifier ici n'ajouterait
    // qu'un second chiffre susceptible de diverger du premier.
    const parsed = saleSchema.parse({
      ...SALE,
      items: [{ ...SALE_ITEM, lineAmount: { amountMinor: 3600, currency: 'EUR' } }],
    });

    expect(parsed.items[0]?.lineAmount.amountMinor).toBe(3600);
  });
});

describe('le ticket', () => {
  it('porte les quatre montants du serveur, chacun avec sa devise', () => {
    const parsed = saleSchema.parse(SALE);

    for (const amount of [parsed.subtotal, parsed.tax, parsed.tip, parsed.total]) {
      expect(amount.currency).toBe('EUR');
      expect(Number.isInteger(amount.amountMinor)).toBe(true);
    }
  });

  it('ne laisse survivre aucun champ que le contrat ne déclare pas', () => {
    // Même propriété de forme que pour l'encaissement : si l'API se mettait à
    // émettre une donnée de carte, elle n'atteindrait ni un composant ni un
    // journal du front (payments-stripe §1).
    const parsed = saleSchema.parse({ ...SALE, tenantId: 'x', last4: '4242', brand: 'visa' });

    expect(Object.keys(parsed).sort()).toEqual([
      'appointmentId',
      'cashierUserId',
      'createdAt',
      'id',
      'items',
      'subtotal',
      'tax',
      'tip',
      'total',
    ]);
  });

  it('accepte une vente retail autonome comme un ticket rattaché', () => {
    expect(saleSchema.parse(SALE).appointmentId).toBeNull();
    expect(
      saleSchema.parse({ ...SALE, appointmentId: 'eeeeeeee-0000-4000-8000-000000000005' })
        .appointmentId,
    ).toBe('eeeeeeee-0000-4000-8000-000000000005');
  });

  it('exige un instant UTC de composition', () => {
    expect(saleSchema.safeParse({ ...SALE, createdAt: '2026-09-06 09:30' }).success).toBe(false);
  });

  it('rend un en-tête sans ses lignes sur l’historique', () => {
    // `GET /sales` ne sert pas les lignes : une page de cinquante tickets de dix
    // lignes en ferait transiter cinq cents qu'aucun tableau n'affiche.
    expect(saleSummarySchema.parse(SALE)).not.toHaveProperty('items');
  });
});

describe('une page d’historique', () => {
  const PAGE = { items: [SALE], page: 1, pageSize: 20, totalItems: 1, totalPages: 1 };

  it('accepte `0` page sur un ensemble vide', () => {
    // « page 1 sur 0 » est ce que le contrat annonce ; « 1 sur 1 » ferait croire
    // à une page qu'on n'a pas su charger.
    const parsed = salePageSchema.parse({ ...PAGE, items: [], totalItems: 0, totalPages: 0 });

    expect(parsed.totalPages).toBe(0);
    expect(parsed.items).toEqual([]);
  });

  it('écarte les lignes que l’API n’aurait pas dû joindre', () => {
    expect(salePageSchema.parse(PAGE).items[0]).not.toHaveProperty('items');
  });

  it('refuse une page zéro — la numérotation commence à 1', () => {
    expect(salePageSchema.safeParse({ ...PAGE, page: 0 }).success).toBe(false);
  });
});
