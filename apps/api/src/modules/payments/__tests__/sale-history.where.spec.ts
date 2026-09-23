import { SETTLED_PAYMENT_STATUSES } from '../payments.types';
import { saleWhere } from '../pos.repository';
import type { SaleHistoryFilter } from '../pos.types';

/**
 * Le `where` de l'historique des ventes — #834, sixième critère, et #1027,
 * deuxième point.
 *
 * Ce qui se prouve ici et nulle part ailleurs sans une base : que les deux
 * critères de règlement — le **moyen** et la fenêtre de **capture** — tombent
 * dans une seule condition d'existence. Deux `some` séparés se laisseraient
 * satisfaire par deux encaissements différents, et la relève du terminal
 * ramènerait un ticket que le relevé du terminal ne porte pas.
 *
 * La fonction est pure : un filtre entre, un `where` de Prisma sort. Aucune
 * base n'est montée, et c'est ce qui permet de lire la forme exacte du prédicat.
 */

const PAGE = { page: 1, pageSize: 20 } as const;
const filterOf = (overrides: Partial<SaleHistoryFilter> = {}): SaleHistoryFilter => ({
  ...PAGE,
  ...overrides,
});

const DAY = {
  from: new Date('2026-09-17T22:00:00.000Z'),
  to: new Date('2026-09-18T22:00:00.000Z'),
} as const;

describe('saleWhere — les critères du ticket', () => {
  it('n’ajoute aucune clé pour un critère absent', () => {
    // Un `where` qui ne porte que ce qui filtre réellement se lit — et se
    // journalise — sans avoir à déduire ce qui est actif.
    expect(saleWhere(filterOf())).toEqual({});
  });

  it('borne l’ouverture du ticket, borne haute exclue', () => {
    expect(saleWhere(filterOf({ from: DAY.from, to: DAY.to }))).toEqual({
      createdAt: { gte: DAY.from, lt: DAY.to },
    });
  });
});

describe('saleWhere — la relève du règlement', () => {
  it('filtre le moyen sur le couple de colonnes, et non sur `method` seul', () => {
    expect(saleWhere(filterOf({ mean: 'CARD_TERMINAL' })).payments).toEqual({
      some: { status: { in: [...SETTLED_PAYMENT_STATUSES] }, method: 'CARD', cardChannel: 'TERMINAL' },
    });
  });

  /**
   * **#1027, deuxième point.** La fenêtre de capture ne s'ajoute pas à côté du
   * moyen : elle s'ajoute **dedans**. Un ticket réglé en espèces le 18 et au
   * terminal le 17 ne doit pas ressortir sous « terminal, journée du 18 ».
   */
  it('pose le moyen et la fenêtre de capture sur le même encaissement', () => {
    const where = saleWhere(filterOf({ mean: 'CARD_TERMINAL', settledWithin: DAY }));

    expect(where.payments).toEqual({
      some: {
        status: { in: [...SETTLED_PAYMENT_STATUSES] },
        method: 'CARD',
        cardChannel: 'TERMINAL',
        capturedAt: { gte: DAY.from, lt: DAY.to },
      },
    });
  });

  /**
   * La fenêtre de capture est **indépendante** de celle de l'ouverture : c'est
   * tout l'objet du deuxième point. Un ticket ouvert le 17 à 23 h 55 et réglé le
   * 18 à 00 h 05 figure sur le relevé du 18, et la requête du 18 doit le rendre.
   */
  it('ne confond pas la fenêtre de capture avec celle de l’ouverture', () => {
    const where = saleWhere(filterOf({ settledWithin: DAY }));

    expect(where.createdAt).toBeUndefined();
    expect(where.payments).toEqual({
      some: {
        status: { in: [...SETTLED_PAYMENT_STATUSES] },
        capturedAt: { gte: DAY.from, lt: DAY.to },
      },
    });
  });

  it('cumule les deux fenêtres quand les deux sont demandées', () => {
    const opened = { from: new Date('2026-09-01T00:00:00.000Z') } as const;
    const where = saleWhere(filterOf({ from: opened.from, settledWithin: DAY }));

    expect(where.createdAt).toEqual({ gte: opened.from });
    expect(where.payments).toEqual({
      some: {
        status: { in: [...SETTLED_PAYMENT_STATUSES] },
        capturedAt: { gte: DAY.from, lt: DAY.to },
      },
    });
  });

  /**
   * Sans moyen demandé, seuls les encaissements **aboutis** entrent dans la
   * fenêtre : une intention en vol n'a rien capturé, et une carte refusée n'est
   * pas un règlement. Un ticket qui apparaîtrait sur une relève pour une
   * tentative avortée ferait chercher au comptoir une ligne qui n'existe pas.
   */
  it('n’ouvre la fenêtre de capture qu’aux encaissements aboutis', () => {
    const where = saleWhere(filterOf({ settledWithin: { from: DAY.from } }));

    expect(where.payments).toEqual({
      some: { status: { in: [...SETTLED_PAYMENT_STATUSES] }, capturedAt: { gte: DAY.from } },
    });
  });

  /**
   * `CARD_ONLINE` accepte le canal `STRIPE` **et le canal nul** — les lignes
   * antérieures à #834 que la migration n'a pas reprises. Le `OR` reste à sa
   * place une fois la fenêtre ajoutée.
   */
  it('garde le repli du canal nul sous une fenêtre de capture', () => {
    const where = saleWhere(filterOf({ mean: 'CARD_ONLINE', settledWithin: DAY }));

    expect(where.payments).toEqual({
      some: {
        status: { in: [...SETTLED_PAYMENT_STATUSES] },
        method: 'CARD',
        OR: [{ cardChannel: 'STRIPE' }, { cardChannel: null }],
        capturedAt: { gte: DAY.from, lt: DAY.to },
      },
    });
  });
});
