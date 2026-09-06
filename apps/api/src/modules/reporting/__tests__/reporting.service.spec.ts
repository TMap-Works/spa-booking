import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import { asReportingRepository, FakeReportingRepository } from './reporting.doubles';
import { foldRevenueTotals, noShowRate, ReportingService } from '../reporting.service';
import { ReportWindowInvalidError, ReportWindowTooWideError } from '../reporting.errors';
import type { DailyRevenueRow, ReportWindow } from '../reporting.types';

/**
 * Les règles que `ReportingService` décide — et elles seules.
 *
 * Le dépôt est un double : ce qui est éprouvé ici, c'est ce que le service
 * ajoute au SQL, pas le SQL lui-même. Les trois choses en question sont les
 * seules discutables du module, et chacune se trompe silencieusement si
 * personne ne la garde :
 *
 * 1. la **validité d'une fenêtre** — un rapport sur une fenêtre inversée rendrait
 *    zéro, indiscernable d'un salon sans activité ;
 * 2. le **dénominateur du taux de no-show** — le choix le plus contestable du
 *    ticket, et celui qu'un écran ne peut pas rattraper s'il est faux ;
 * 3. le **cumul du revenu** — un total qui ne serait pas celui des lignes
 *    affichées est un chiffre d'affaires qu'on ne peut pas rapprocher.
 *
 * Le 404 sur établissement disparu s'y ajoute : c'est la seule réponse qui
 * n'apprenne rien (tenant-isolation §4).
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const AUTRE_TENANT = '22222222-2222-4222-8222-222222222222';

const SEPTEMBRE: ReportWindow = {
  from: new Date('2026-09-01T00:00:00Z'),
  to: new Date('2026-10-01T00:00:00Z'),
};

function serviceWith(repository: FakeReportingRepository): ReportingService {
  return new ReportingService(asReportingRepository(repository));
}

function seeded(): FakeReportingRepository {
  const repository = new FakeReportingRepository();
  repository.seedTenant(TENANT);
  repository.seedTenant(AUTRE_TENANT, 'Pacific/Tahiti');

  return repository;
}

describe('ReportingService — la fenêtre', () => {
  it('refuse une fenêtre inversée en 422, sans rien lire', async () => {
    const repository = seeded();

    await expect(
      runWithTenant(TENANT, async () =>
        serviceWith(repository).dailyRevenue({ from: SEPTEMBRE.to, to: SEPTEMBRE.from }),
      ),
    ).rejects.toBeInstanceOf(ReportWindowInvalidError);
  });

  it('refuse une fenêtre vide — la borne haute est exclue', async () => {
    const repository = seeded();
    const instant = new Date('2026-09-01T00:00:00Z');

    await expect(
      runWithTenant(TENANT, async () =>
        serviceWith(repository).noShows({ from: instant, to: instant }),
      ),
    ).rejects.toBeInstanceOf(ReportWindowInvalidError);
  });

  it('refuse une fenêtre de plus d’un an, et dit de combien', async () => {
    const repository = seeded();

    const rejected = runWithTenant(TENANT, async () =>
      serviceWith(repository).appointmentVolume(
        { from: new Date('2020-01-01T00:00:00Z'), to: new Date('2026-01-01T00:00:00Z') },
        'day',
      ),
    );

    await expect(rejected).rejects.toBeInstanceOf(ReportWindowTooWideError);
    await expect(rejected).rejects.toMatchObject({ details: { maxDays: 366 } });
  });

  it('accepte exactement 366 jours — une année bissextile demandée bout à bout', async () => {
    const repository = seeded();

    const report = await runWithTenant(TENANT, async () =>
      serviceWith(repository).noShows({
        from: new Date('2028-01-01T00:00:00Z'),
        to: new Date('2029-01-01T00:00:00Z'),
      }),
    );

    expect(report.total).toBe(0);
  });
});

describe('ReportingService — l’établissement', () => {
  it('rend 404 quand le fuseau du tenant est introuvable', async () => {
    const repository = new FakeReportingRepository();

    await expect(
      runWithTenant(TENANT, async () => serviceWith(repository).dailyRevenue(SEPTEMBRE)),
    ).rejects.toBeInstanceOf(NotFoundError);
  });

  it('rend le fuseau du salon avec le rapport, pour que l’écran ne le suppose pas', async () => {
    const repository = seeded();

    const report = await runWithTenant(AUTRE_TENANT, async () =>
      serviceWith(repository).dailyRevenue(SEPTEMBRE),
    );

    expect(report.timeZone).toBe('Pacific/Tahiti');
  });

  it('refuse de lire hors de toute portée de tenant', async () => {
    const repository = seeded();

    await expect(serviceWith(repository).noShows(SEPTEMBRE)).rejects.toThrow(
      /portée de tenant/u,
    );
  });
});

describe('ReportingService — le revenu', () => {
  it('cumule par moyen de paiement et par devise, jamais entre devises', async () => {
    const repository = seeded();
    repository.seedPayment(payment({ date: '2026-09-01', method: 'CARD', amountMinor: 10_000 }));
    repository.seedPayment(payment({ date: '2026-09-02', method: 'CARD', amountMinor: 5_000 }));
    repository.seedPayment(payment({ date: '2026-09-02', method: 'CASH', amountMinor: 2_000 }));
    repository.seedPayment(
      payment({ date: '2026-09-02', method: 'CARD', amountMinor: 900, currency: 'USD' }),
    );

    const report = await runWithTenant(TENANT, async () =>
      serviceWith(repository).dailyRevenue(SEPTEMBRE),
    );

    expect(report.totals).toHaveLength(3);
    expect(report.totals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ method: 'CARD', currency: 'EUR', netAmountMinor: 15_000 }),
        expect.objectContaining({ method: 'CASH', currency: 'EUR', netAmountMinor: 2_000 }),
        expect.objectContaining({ method: 'CARD', currency: 'USD', netAmountMinor: 900 }),
      ]),
    );
  });

  it('retranche les remboursements du net, sans faire disparaître la vente', async () => {
    const repository = seeded();
    repository.seedPayment(
      payment({
        date: '2026-09-01',
        method: 'CARD',
        amountMinor: 10_000,
        refundedAmountMinor: 4_000,
        status: 'PARTIALLY_REFUNDED',
      }),
    );

    const report = await runWithTenant(TENANT, async () =>
      serviceWith(repository).dailyRevenue(SEPTEMBRE),
    );

    expect(report.days).toHaveLength(1);
    expect(report.days[0]).toMatchObject({
      transactions: 1,
      grossAmountMinor: 10_000,
      refundedAmountMinor: 4_000,
      netAmountMinor: 6_000,
    });
  });

  it('ne montre que les jours où il y a eu une recette', async () => {
    const repository = seeded();
    repository.seedPayment(payment({ date: '2026-09-15', method: 'CASH', amountMinor: 3_000 }));

    const report = await runWithTenant(TENANT, async () =>
      serviceWith(repository).dailyRevenue(SEPTEMBRE),
    );

    expect(report.days.map((day) => day.date)).toEqual(['2026-09-15']);
  });
});

describe('ReportingService — le volume', () => {
  it('somme les groupes plutôt que de recompter, sur les trois axes', async () => {
    const repository = seeded();
    repository.seedAppointment(appointment({ date: '2026-09-01', status: 'COMPLETED' }));
    repository.seedAppointment(
      appointment({
        date: '2026-09-02',
        status: 'NO_SHOW',
        staffId: 'staff-b',
        staffName: 'Basile',
      }),
    );

    const service = serviceWith(repository);

    for (const axis of ['day', 'staff', 'service'] as const) {
      const report = await runWithTenant(TENANT, async () =>
        service.appointmentVolume(SEPTEMBRE, axis),
      );

      expect(report.groupBy).toBe(axis);
      expect(report.total).toBe(2);
    }
  });

  it('rend les cinq statuts sur chaque groupe, à zéro le cas échéant', async () => {
    const repository = seeded();
    repository.seedAppointment(appointment({ date: '2026-09-01', status: 'CANCELLED' }));

    const report = await runWithTenant(TENANT, async () =>
      serviceWith(repository).appointmentVolume(SEPTEMBRE, 'day'),
    );

    expect(report.rows[0]?.byStatus).toEqual({
      PENDING: 0,
      CONFIRMED: 0,
      COMPLETED: 0,
      CANCELLED: 1,
      NO_SHOW: 0,
    });
  });

  it('porte le nom public du groupe sur `staff` et `service`, `null` sur `day`', async () => {
    const repository = seeded();
    repository.seedAppointment(appointment({ date: '2026-09-01', status: 'COMPLETED' }));
    const service = serviceWith(repository);

    const byDay = await runWithTenant(TENANT, async () =>
      service.appointmentVolume(SEPTEMBRE, 'day'),
    );
    const byStaff = await runWithTenant(TENANT, async () =>
      service.appointmentVolume(SEPTEMBRE, 'staff'),
    );
    const byService = await runWithTenant(TENANT, async () =>
      service.appointmentVolume(SEPTEMBRE, 'service'),
    );

    expect(byDay.rows[0]?.label).toBeNull();
    expect(byStaff.rows[0]?.label).toBe('Camille');
    expect(byService.rows[0]?.label).toBe('Massage 60 min');
  });
});

describe('ReportingService — les no-shows', () => {
  it('compte, et divise par les rendez-vous arrivés à échéance', async () => {
    const repository = seeded();
    for (let index = 0; index < 9; index += 1) {
      repository.seedAppointment(appointment({ date: '2026-09-01', status: 'COMPLETED' }));
    }
    repository.seedAppointment(appointment({ date: '2026-09-02', status: 'NO_SHOW' }));

    const report = await runWithTenant(TENANT, async () =>
      serviceWith(repository).noShows(SEPTEMBRE),
    );

    expect(report).toMatchObject({ noShows: 1, honored: 9, total: 10, rate: 0.1 });
  });

  it('exclut les annulations du dénominateur — le créneau a été rendu', async () => {
    const repository = seeded();
    repository.seedAppointment(appointment({ date: '2026-09-01', status: 'COMPLETED' }));
    repository.seedAppointment(appointment({ date: '2026-09-02', status: 'NO_SHOW' }));
    for (let index = 0; index < 8; index += 1) {
      repository.seedAppointment(appointment({ date: '2026-09-03', status: 'CANCELLED' }));
    }

    const report = await runWithTenant(TENANT, async () =>
      serviceWith(repository).noShows(SEPTEMBRE),
    );

    // 1 / (1 + 1), et non 1 / 10 : huit annulations ne diluent pas le taux.
    expect(report).toMatchObject({ cancelled: 8, rate: 0.5 });
  });

  it('exclut les rendez-vous à venir — ils n’ont pas encore été jugés', async () => {
    const repository = seeded();
    repository.seedAppointment(appointment({ date: '2026-09-20', status: 'CONFIRMED' }));
    repository.seedAppointment(appointment({ date: '2026-09-21', status: 'PENDING' }));

    const report = await runWithTenant(TENANT, async () =>
      serviceWith(repository).noShows(SEPTEMBRE),
    );

    expect(report).toMatchObject({ pending: 2, total: 2, rate: null });
  });
});

describe('noShowRate', () => {
  it('rend `null` — et non zéro — quand personne n’était attendu', () => {
    expect(noShowRate(0, 0)).toBeNull();
  });

  it('arrondit au point de base, sans laisser passer un flottant bavard', () => {
    // 1 / 3 = 0.3333333333333333 : c'est cette forme-là qui ne doit pas
    // traverser le contrat.
    expect(noShowRate(1, 2)).toBe(0.3333);
  });

  it('rend 1 quand personne n’est venu', () => {
    expect(noShowRate(4, 0)).toBe(1);
  });
});

describe('foldRevenueTotals', () => {
  it('rend une liste vide sur une fenêtre sans recette', () => {
    expect(foldRevenueTotals([])).toEqual([]);
  });

  it('ne mélange jamais deux devises sous le même moyen de paiement', () => {
    const days: DailyRevenueRow[] = [
      revenueRow({ currency: 'EUR', grossAmountMinor: 100 }),
      revenueRow({ currency: 'CHF', grossAmountMinor: 200 }),
    ];

    expect(foldRevenueTotals(days)).toHaveLength(2);
  });
});

function payment(overrides: {
  date: string;
  method: 'CARD' | 'CASH';
  amountMinor: number;
  refundedAmountMinor?: number;
  currency?: string;
  status?: string;
}): Parameters<FakeReportingRepository['seedPayment']>[0] {
  return {
    tenantId: TENANT,
    date: overrides.date,
    capturedAt: new Date(`${overrides.date}T12:00:00Z`),
    method: overrides.method,
    currency: overrides.currency ?? 'EUR',
    status: overrides.status ?? 'SUCCEEDED',
    amountMinor: overrides.amountMinor,
    refundedAmountMinor: overrides.refundedAmountMinor ?? 0,
  };
}

function appointment(overrides: {
  date: string;
  status: 'PENDING' | 'CONFIRMED' | 'COMPLETED' | 'CANCELLED' | 'NO_SHOW';
  staffId?: string;
  staffName?: string;
}): Parameters<FakeReportingRepository['seedAppointment']>[0] {
  return {
    tenantId: TENANT,
    date: overrides.date,
    startsAt: new Date(`${overrides.date}T10:00:00Z`),
    status: overrides.status,
    staffId: overrides.staffId ?? 'staff-a',
    staffName: overrides.staffName ?? 'Camille',
    serviceId: 'service-a',
    serviceName: 'Massage 60 min',
  };
}

function revenueRow(overrides: { currency: string; grossAmountMinor: number }): DailyRevenueRow {
  return {
    date: '2026-09-01',
    method: 'CARD',
    currency: overrides.currency,
    transactions: 1,
    grossAmountMinor: overrides.grossAmountMinor,
    refundedAmountMinor: 0,
    netAmountMinor: overrides.grossAmountMinor,
  };
}
