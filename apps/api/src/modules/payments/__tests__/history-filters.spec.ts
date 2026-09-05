import { validate } from 'class-validator';

import {
  ListPaymentsQueryDto,
  toPaymentHistoryFilter,
} from '../dto/cash-payment.dto';
import { ListSalesQueryDto, toSaleHistoryFilter } from '../dto/sale.dto';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE,
  MAX_PAGE_SIZE,
  isOffsetDateTime,
} from '../dto/validation';

/**
 * La frontière HTTP des deux historiques de #62.
 *
 * Ce que cette suite couvre, et que les suites de service ne peuvent pas
 * atteindre — elles reçoivent déjà des `Date` :
 *
 * - **la lecture des bornes** : une date-heure sans offset est refusée, une date
 *   civile inexistante aussi. Les deux traverseraient sinon la frontière pour
 *   être normalisées en silence, et déplaceraient la fenêtre d'un jour de caisse ;
 * - **la conversion** en instant, faite une fois et à un seul endroit ;
 * - **l'absence de critère**, qui ne doit pas devenir un critère `undefined` :
 *   `exactOptionalPropertyTypes` distingue les deux, et le `where` de Prisma s'en
 *   sert ;
 * - **les défauts de pagination**, appliqués une fois.
 */

const assign = <T extends object>(dto: T, values: Partial<T>): T => Object.assign(dto, values);

describe('la lecture d’une borne de fenêtre', () => {
  it.each([
    '2026-09-01T00:00:00Z',
    '2026-09-01T00:00:00+02:00',
    '2026-09-01T00:00Z',
    '2026-09-01T00:00:00.123456789Z',
  ])('accepte « %s » — offset explicite, instant réel', (value) => {
    expect(isOffsetDateTime(value)).toBe(true);
  });

  it.each([
    ['2026-09-01T00:00:00', 'sans offset : le serveur devrait deviner un fuseau'],
    ['2026-02-31T10:00:00Z', 'date civile inexistante, que `Date.parse` ramènerait au 3 mars'],
    ['2026-09-01T24:00:00Z', '`24:00` n’existe pas en RFC 3339'],
    ['2026-09-01', 'une date nue n’est pas un instant'],
    ['hier', 'ce n’est pas une date'],
  ])('refuse « %s » — %s', (value) => {
    expect(isOffsetDateTime(value)).toBe(false);
  });

  it('refuse la borne au niveau du DTO, en nommant le champ', async () => {
    const dto = assign(new ListPaymentsQueryDto(), { from: '2026-09-01T00:00:00' });

    const errors = await validate(dto);

    expect(errors.map((error) => error.property)).toEqual(['from']);
  });
});

describe('toPaymentHistoryFilter', () => {
  it('convertit les bornes en instants, une fois', () => {
    const filter = toPaymentHistoryFilter(
      assign(new ListPaymentsQueryDto(), {
        from: '2026-09-01T00:00:00+02:00',
        to: '2026-09-02T00:00:00+02:00',
      }),
    );

    expect(filter.from?.toISOString()).toBe('2026-08-31T22:00:00.000Z');
    expect(filter.to?.toISOString()).toBe('2026-09-01T22:00:00.000Z');
  });

  it('n’ajoute aucune clé pour un critère absent', () => {
    const filter = toPaymentHistoryFilter(new ListPaymentsQueryDto());

    // Ni `from: undefined`, ni `method: undefined` : porté jusqu'au `where` de
    // Prisma, un tel champ s'y lirait comme un filtre à composer.
    expect(Object.keys(filter).sort()).toEqual(['page', 'pageSize']);
  });

  it('applique les défauts de pagination', () => {
    const filter = toPaymentHistoryFilter(new ListPaymentsQueryDto());

    expect(filter).toMatchObject({ page: 1, pageSize: DEFAULT_PAGE_SIZE });
  });

  it('reporte les critères présents', () => {
    const filter = toPaymentHistoryFilter(
      assign(new ListPaymentsQueryDto(), { method: 'CASH', status: 'SUCCEEDED', pageSize: 5 }),
    );

    expect(filter).toMatchObject({ method: 'CASH', status: 'SUCCEEDED', page: 1, pageSize: 5 });
  });
});

describe('toSaleHistoryFilter', () => {
  it('n’ajoute aucune clé pour un critère absent', () => {
    const filter = toSaleHistoryFilter(new ListSalesQueryDto());

    expect(Object.keys(filter).sort()).toEqual(['page', 'pageSize']);
  });

  it('reporte l’opérateur et le rendez-vous', () => {
    const cashierUserId = '33333333-3333-4333-8333-333333333333';
    const appointmentId = '55555555-5555-4555-8555-555555555555';

    const filter = toSaleHistoryFilter(
      assign(new ListSalesQueryDto(), { cashierUserId, appointmentId }),
    );

    expect(filter).toMatchObject({ cashierUserId, appointmentId });
  });
});

describe('les plafonds de pagination sont ceux du serveur', () => {
  it('refuse une taille de page au-delà du plafond', async () => {
    const dto = assign(new ListSalesQueryDto(), { pageSize: MAX_PAGE_SIZE + 1 });

    const errors = await validate(dto);

    // Sans ce plafond, `?pageSize=100000` est un déni de service à une requête.
    expect(errors.map((error) => error.property)).toEqual(['pageSize']);
  });

  it('refuse un numéro de page dont le décalage cesserait d’être exact', async () => {
    const dto = assign(new ListPaymentsQueryDto(), { page: MAX_PAGE + 1 });

    const errors = await validate(dto);

    // `@IsInt()` ne juge pas la magnitude : `?page=1e30` sortirait sinon en 500
    // du pilote PostgreSQL, là où le contrat annonce un 400 nommant le champ.
    expect(errors.map((error) => error.property)).toEqual(['page']);
  });
});
