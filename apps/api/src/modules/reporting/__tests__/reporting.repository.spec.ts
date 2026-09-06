import { MissingTenantContextError, runWithTenant } from '../../../common/tenant';
import type { ScopedPrismaClient } from '../../../infrastructure/database/prisma-clients';
import { foldVolumeRows, ReportingRepository, type VolumeSqlRow } from '../reporting.repository';
import type { ReportWindow } from '../reporting.types';

/**
 * Ce que le dépôt garantit **avant** que PostgreSQL n'entre en scène.
 *
 * Le SQL brut ne repasse pas par l'extension de scoping : `$queryRaw` ne
 * traverse pas le pipeline `$allOperations`, et aucun `WHERE tenant_id = …` n'y
 * est injecté (ADR 0006). Chaque requête de ce module porte donc son prédicat
 * d'établissement à la main — et c'est exactement la sorte de garantie qu'un
 * refactor emporte sans le vouloir.
 *
 * Deux gardes existent déjà : la règle ESLint `tenant/raw-sql-tenant-filter`,
 * qui lit le littéral, et la suite d'isolation d'`apps/api/test`, qui interroge
 * l'application montée. Celle-ci comble ce qui reste entre les deux — que le
 * prédicat soit **lié à la valeur du contexte**, et non à une constante ou à un
 * paramètre d'appelant. Une requête qui écrirait `tenant_id = 'quelque chose'`
 * satisferait la règle ESLint sans borner quoi que ce soit.
 *
 * Le client Prisma est un double : ce qui est éprouvé ici est le texte émis et
 * les valeurs liées, pas le moteur.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

const SEPTEMBRE: ReportWindow = {
  from: new Date('2026-09-01T00:00:00Z'),
  to: new Date('2026-10-01T00:00:00Z'),
};

/** Un client réduit aux deux portes que le dépôt emprunte. */
function clientWith(rows: readonly unknown[] = []): {
  prisma: ScopedPrismaClient;
  sql: () => string[];
  values: () => unknown[][];
} {
  const sql: string[] = [];
  const values: unknown[][] = [];

  const queryRaw = jest.fn(async (strings: TemplateStringsArray, ...bound: unknown[]) => {
    sql.push(strings.join('?'));
    values.push(bound);
    return Promise.resolve(rows);
  });

  const prisma = {
    $queryRaw: queryRaw,
    tenant: { findFirst: jest.fn(async () => Promise.resolve({ timezone: 'Europe/Paris' })) },
  } as unknown as ScopedPrismaClient;

  return { prisma, sql: () => sql, values: () => values };
}

function repositoryWith(rows: readonly unknown[] = []): {
  repository: ReportingRepository;
  sql: () => string[];
  values: () => unknown[][];
} {
  const client = clientWith(rows);

  return {
    repository: new ReportingRepository(client.prisma),
    sql: client.sql,
    values: client.values,
  };
}

/** Une lecture du dépôt, nommée — le tableau d'entrée des deux suites `each`. */
type NamedRead = readonly [string, (repository: ReportingRepository) => Promise<unknown>];

/** Les cinq lectures que ce dépôt expose, toutes portées par du SQL brut. */
const ALL_READS: readonly NamedRead[] = [
  ['dailyRevenue', (repository) => repository.dailyRevenue(SEPTEMBRE, 'UTC')],
  ['appointmentVolume/day', (repository) => repository.appointmentVolume(SEPTEMBRE, 'UTC', 'day')],
  [
    'appointmentVolume/staff',
    (repository) => repository.appointmentVolume(SEPTEMBRE, 'UTC', 'staff'),
  ],
  [
    'appointmentVolume/service',
    (repository) => repository.appointmentVolume(SEPTEMBRE, 'UTC', 'service'),
  ],
  ['noShowCounts', (repository) => repository.noShowCounts(SEPTEMBRE)],
];

describe('ReportingRepository — le prédicat d’établissement', () => {
  it.each(ALL_READS)('%s : filtre sur `tenant_id`, avec la valeur du contexte', async (_, call) => {
    const { repository, sql, values } = repositoryWith();

    await runWithTenant(TENANT, async () => call(repository));

    expect(sql()).toHaveLength(1);
    expect(sql()[0]).toMatch(/tenant_id"?\s*=\s*\?/u);
    expect(values()[0]).toContain(TENANT);
  });

  it.each(ALL_READS)(
    '%s : refuse de lire hors de toute portée, plutôt que de tout lire',
    async (_, call) => {
      const { repository, sql } = repositoryWith();

      await expect(call(repository)).rejects.toBeInstanceOf(MissingTenantContextError);
      expect(sql()).toHaveLength(0);
    },
  );
});

describe('ReportingRepository — le revenu', () => {
  it('borne la fenêtre sur `captured_at`, jamais sur `created_at`', async () => {
    const { repository, sql } = repositoryWith();

    await runWithTenant(TENANT, async () => repository.dailyRevenue(SEPTEMBRE, 'Europe/Paris'));

    expect(sql()[0]).toContain('"captured_at" >= ?');
    expect(sql()[0]).toContain('"captured_at" < ?');
    expect(sql()[0]).not.toContain('created_at');
  });

  it('lie le fuseau plutôt que de le concaténer dans le SQL', async () => {
    const { repository, sql, values } = repositoryWith();

    await runWithTenant(TENANT, async () => repository.dailyRevenue(SEPTEMBRE, 'Pacific/Tahiti'));

    expect(values()[0]).toContain('Pacific/Tahiti');
    expect(sql()[0]).not.toContain('Pacific/Tahiti');
  });

  it('lie les trois statuts de recette, et eux seuls', async () => {
    const { repository, values } = repositoryWith();

    await runWithTenant(TENANT, async () => repository.dailyRevenue(SEPTEMBRE, 'UTC'));

    expect(values()[0]).toEqual(
      expect.arrayContaining(['SUCCEEDED', 'PARTIALLY_REFUNDED', 'REFUNDED']),
    );
    expect(values()[0]).not.toContain('PENDING');
    expect(values()[0]).not.toContain('FAILED');
  });

  it('transtype les paramètres de statut, jamais la colonne — sinon l’index tombe', async () => {
    const { repository, sql } = repositoryWith();

    await runWithTenant(TENANT, async () => repository.dailyRevenue(SEPTEMBRE, 'UTC'));

    // `"status"::text IN (…)` rend le même résultat, et rend
    // `payments (tenant_id, status, captured_at)` inutilisable : `status` cesse
    // d'être une borne de parcours, `captured_at` avec lui, et la requête balaie
    // tout l'historique du salon pour n'en garder qu'une fenêtre.
    expect(sql()[0]).not.toMatch(/"status"\s*::\s*text/u);
    expect(sql()[0]).toContain('"status" IN (');
    expect(sql()[0]).toContain('::"PaymentStatus"');
  });

  it('ramène les `bigint` de PostgreSQL en nombres, et dérive le net', async () => {
    const { repository } = repositoryWith([
      {
        bucket: '2026-09-03',
        method: 'CARD',
        currency: 'EUR',
        transactions: 3n,
        gross: 26_500n,
        refunded: 2_500n,
      },
    ]);

    const days = await runWithTenant(TENANT, async () => repository.dailyRevenue(SEPTEMBRE, 'UTC'));

    expect(days).toEqual([
      {
        date: '2026-09-03',
        method: 'CARD',
        currency: 'EUR',
        transactions: 3,
        grossAmountMinor: 26_500,
        refundedAmountMinor: 2_500,
        netAmountMinor: 24_000,
      },
    ]);
    // Un `BigInt` qui survivrait jusqu'ici ferait échouer la sérialisation de la
    // réponse HTTP, et seulement là.
    expect(() => JSON.stringify(days)).not.toThrow();
  });
});

describe('ReportingRepository — le volume', () => {
  it('joint `staff` sur le couple `(tenant_id, id)`, jamais sur l’identifiant seul', async () => {
    const { repository, sql } = repositoryWith();

    await runWithTenant(TENANT, async () => repository.appointmentVolume(SEPTEMBRE, 'UTC', 'staff'));

    expect(sql()[0]).toContain('JOIN "staff" s ON s."tenant_id" = a."tenant_id"');
  });

  it('joint `services` sur le couple `(tenant_id, id)`', async () => {
    const { repository, sql } = repositoryWith();

    await runWithTenant(TENANT, async () =>
      repository.appointmentVolume(SEPTEMBRE, 'UTC', 'service'),
    );

    expect(sql()[0]).toContain('JOIN "services" sv ON sv."tenant_id" = a."tenant_id"');
  });

  it('ne joint rien sur l’axe `day` — la clé se lit de la date elle-même', async () => {
    const { repository, sql } = repositoryWith();

    await runWithTenant(TENANT, async () => repository.appointmentVolume(SEPTEMBRE, 'UTC', 'day'));

    expect(sql()[0]).not.toContain('JOIN');
  });

  it('borne la fenêtre sur `starts_at` — la date du rendez-vous, pas celle de sa prise', async () => {
    const { repository, sql } = repositoryWith();

    await runWithTenant(TENANT, async () => repository.appointmentVolume(SEPTEMBRE, 'UTC', 'day'));

    expect(sql()[0]).toContain('"starts_at" >= ?');
    expect(sql()[0]).not.toContain('created_at');
  });
});

describe('ReportingRepository — les no-shows', () => {
  it('compte les cinq agrégats en un seul balayage', async () => {
    const { repository, sql } = repositoryWith([
      { noShows: 4n, honored: 118n, cancelled: 9n, pending: 33n, total: 164n },
    ]);

    const counts = await runWithTenant(TENANT, async () => repository.noShowCounts(SEPTEMBRE));

    expect(sql()).toHaveLength(1);
    expect(counts).toEqual({ noShows: 4, honored: 118, cancelled: 9, pending: 33, total: 164 });
  });

  it('rend cinq zéros plutôt que d’échouer si la base ne rend aucune ligne', async () => {
    const { repository } = repositoryWith([]);

    const counts = await runWithTenant(TENANT, async () => repository.noShowCounts(SEPTEMBRE));

    expect(counts).toEqual({ noShows: 0, honored: 0, cancelled: 0, pending: 0, total: 0 });
  });
});

describe('foldVolumeRows', () => {
  it('rend les cinq statuts sur chaque groupe, les absents à zéro', () => {
    expect(foldVolumeRows([row('2026-09-01', null, 'COMPLETED', 3n)])).toEqual([
      {
        key: '2026-09-01',
        label: null,
        total: 3,
        byStatus: { PENDING: 0, CONFIRMED: 0, COMPLETED: 3, CANCELLED: 0, NO_SHOW: 0 },
      },
    ]);
  });

  it('replie plusieurs statuts d’un même groupe en une ligne, et somme le total', () => {
    const folded = foldVolumeRows([
      row('staff-a', 'Camille', 'COMPLETED', 10n),
      row('staff-a', 'Camille', 'NO_SHOW', 2n),
    ]);

    expect(folded).toHaveLength(1);
    expect(folded[0]).toMatchObject({ key: 'staff-a', label: 'Camille', total: 12 });
  });

  it('préserve l’ordre du `ORDER BY` de la requête', () => {
    const folded = foldVolumeRows([
      row('2026-09-02', null, 'COMPLETED', 1n),
      row('2026-09-01', null, 'COMPLETED', 1n),
    ]);

    expect(folded.map((group) => group.key)).toEqual(['2026-09-02', '2026-09-01']);
  });

  it('ignore un statut que le contrat ne déclare pas, au lieu d’ajouter une clé', () => {
    const folded = foldVolumeRows([row('2026-09-01', null, 'RESCHEDULED', 5n)]);

    expect(Object.keys(folded[0]?.byStatus ?? {})).toEqual([
      'PENDING',
      'CONFIRMED',
      'COMPLETED',
      'CANCELLED',
      'NO_SHOW',
    ]);
    expect(folded[0]?.total).toBe(0);
  });

  it('rend une liste vide sur une fenêtre sans rendez-vous', () => {
    expect(foldVolumeRows([])).toEqual([]);
  });
});

function row(
  bucket: string,
  label: string | null,
  status: string,
  appointments: bigint,
): VolumeSqlRow {
  return { bucket, label, status, appointments };
}
