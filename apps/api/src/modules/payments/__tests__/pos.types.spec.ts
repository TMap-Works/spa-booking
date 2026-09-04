import { SaleItemKind as PrismaSaleItemKind } from '@prisma/client';

import { CATALOG_ITEM_KINDS, SALE_ITEM_KINDS } from '../pos.types';

/**
 * Le **témoin** du vocabulaire du POS : la liste que le service et le contrôleur
 * manipulent dit-elle la même chose que la colonne ?
 *
 * Même régime, et même justification, que `payments.types.spec.ts` :
 * `pos.types.ts` déclare ces libellés à la main parce qu'api-module §2 interdit
 * à ses lecteurs de connaître Prisma, et c'est cette suite qui rattrape la
 * dérive. L'import de `@prisma/client` est ici et seulement ici.
 */
describe('POS — vocabulaire et colonnes', () => {
  it('énumère les quatre natures de ligne de #60', () => {
    expect(SALE_ITEM_KINDS).toEqual(['SERVICE', 'PRODUCT', 'TAX', 'TIP']);
  });

  it('reprend `enum SaleItemKind` du schéma, dans l’ordre de déclaration', () => {
    // L'ordre compte : PostgreSQL ordonne un `enum` par sa déclaration, et un
    // `orderBy: { kind: 'asc' }` le suivrait.
    expect([...SALE_ITEM_KINDS]).toEqual(Object.values(PrismaSaleItemKind));
  });

  it('distingue taxes et pourboires des articles — cinquième critère de #60', () => {
    // « Taxes et pourboires en lignes distinctes » : deux natures à part
    // entière, jamais des colonnes fondues dans le prix (payments-stripe §5).
    expect(SALE_ITEM_KINDS).toContain('TAX');
    expect(SALE_ITEM_KINDS).toContain('TIP');
  });

  it('ne rend référençables au catalogue que les deux natures qui ont un article', () => {
    // C'est cette partition qui porte « le total est recalculé côté serveur » :
    // seules ces deux-là ont un prix à relire, les deux autres sont composées.
    expect(CATALOG_ITEM_KINDS).toEqual(['SERVICE', 'PRODUCT']);
    for (const kind of CATALOG_ITEM_KINDS) {
      expect(SALE_ITEM_KINDS).toContain(kind);
    }
  });
});
