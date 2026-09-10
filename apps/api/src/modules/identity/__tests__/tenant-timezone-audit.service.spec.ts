import type { StructuredLogger } from '../../../common/logging/structured-logger';
import {
  TenantTimezoneAuditRepository,
  type TenantTimeZoneRow,
} from '../tenant-timezone-audit.repository';
import {
  FALLBACK_TIME_ZONE,
  TenantTimezoneAuditService,
} from '../tenant-timezone-audit.service';

/**
 * Le rattrapage des fuseaux invalides déjà persistés (#604).
 *
 * Quatre propriétés se décident dans ce service, et elles sont toutes ici :
 *
 * 1. **ce qui est jugé invalide** — le verdict est celui d'ICU, le même prédicat
 *    que la garde d'entrée de `PATCH /api/v1/tenant` (#603). Les liens tzdata
 *    (`UTC`, `Etc/GMT+5`) sont valides : un rattrapage qui les basculerait
 *    casserait des établissements corrects ;
 * 2. **la bascule est conditionnée à la valeur relevée**, pour qu'un second
 *    démarrage simultané n'écrase pas ce que le premier — ou un gérant — vient
 *    d'écrire ;
 * 3. **chaque bascule est journalisée** avec la valeur refusée, le slug et le
 *    tenant : c'est la seule trace qui subsiste, la colonne ne la porte plus ;
 * 4. **le démarrage de l'API n'est ni retardé ni mis en échec** : le crochet
 *    d'amorçage rend la main avant le relevé, et le relevé capture tout.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

/** Le dépôt tel que ce service s'en sert — deux méthodes, pas une de plus. */
type AuditPort = Pick<TenantTimezoneAuditRepository, 'listTimeZones' | 'replaceTimeZone'>;

interface LoggedLine {
  level: 'warn' | 'debug' | 'error';
  message: string;
  meta: Record<string, unknown>;
}

interface Harness {
  service: TenantTimezoneAuditService;
  /** L'état des lignes après le passage — c'est ce que la base porterait. */
  stored: () => TenantTimeZoneRow[];
  lines: () => LoggedLine[];
  writes: () => { tenantId: string; expected: string; fallback: string }[];
}

/**
 * Un dépôt en mémoire qui reproduit la **propriété qui compte** : l'écriture est
 * conditionnée à la valeur relevée, exactement comme l'`updateMany` du vrai.
 * Un double qui écrirait sur la seule clé primaire ferait passer en vert le
 * défaut que cette condition existe pour empêcher.
 */
function harnessOver(
  rows: readonly TenantTimeZoneRow[],
  options: { readonly listFails?: Error; readonly stolenBy?: string } = {},
): Harness {
  const stored = rows.map((row) => ({ ...row }));
  const lines: LoggedLine[] = [];
  const writes: { tenantId: string; expected: string; fallback: string }[] = [];

  const port: AuditPort = {
    listTimeZones: jest.fn(async (): Promise<TenantTimeZoneRow[]> => {
      if (options.listFails !== undefined) {
        throw options.listFails;
      }
      // Une copie : le service ne doit pas muter ce que le dépôt lui rend.
      return stored.map((row) => ({ ...row }));
    }),
    replaceTimeZone: jest.fn(
      async (tenantId: string, expected: string, fallback: string): Promise<boolean> => {
        writes.push({ tenantId, expected, fallback });

        // La course : une autre instance a réparé la ligne entre le relevé et
        // l'écriture, la valeur attendue n'est plus celle de la colonne.
        if (options.stolenBy !== undefined) {
          const stolen = stored.find((row) => row.id === tenantId);
          if (stolen !== undefined) {
            stolen.timezone = options.stolenBy;
          }
        }

        const target = stored.find((row) => row.id === tenantId && row.timezone === expected);
        if (target === undefined) {
          return false;
        }
        target.timezone = fallback;
        return true;
      },
    ),
  };

  const logger = {
    warn: (message: unknown, ...params: unknown[]): void => {
      lines.push({ level: 'warn', message: String(message), meta: metaOf(params) });
    },
    debug: (message: unknown, ...params: unknown[]): void => {
      lines.push({ level: 'debug', message: String(message), meta: metaOf(params) });
    },
    error: (message: unknown, ...params: unknown[]): void => {
      lines.push({ level: 'error', message: String(message), meta: metaOf(params) });
    },
  } as unknown as StructuredLogger;

  return {
    service: new TenantTimezoneAuditService(
      port as unknown as TenantTimezoneAuditRepository,
      logger,
    ),
    stored: () => stored.map((row) => ({ ...row })),
    lines: () => lines,
    writes: () => writes,
  };
}

/** Les objets passés en paramètres variadiques, fusionnés — comme `splitLogParams`. */
function metaOf(params: readonly unknown[]): Record<string, unknown> {
  let meta: Record<string, unknown> = {};
  for (const param of params) {
    if (param !== null && typeof param === 'object' && !Array.isArray(param)) {
      meta = { ...meta, ...(param as Record<string, unknown>) };
    }
  }
  return meta;
}

describe('TenantTimezoneAuditService', () => {
  it('ne touche à rien quand tous les fuseaux sont résolus par ICU', async () => {
    const harness = harnessOver([
      { id: TENANT_A, slug: 'spa-lumiere', timezone: 'Europe/Paris' },
      { id: TENANT_B, slug: 'karibu-spa', timezone: 'Indian/Antananarivo' },
    ]);

    const report = await harness.service.audit();

    expect(report).toEqual({ scanned: 2, invalid: 0, repaired: 0, repairs: [] });
    expect(harness.writes()).toHaveLength(0);
    expect(harness.lines().filter((line) => line.level === 'warn')).toHaveLength(0);
  });

  // Le rattrapage doit refuser exactement ce que la garde d'entrée refuse.
  // `Intl.supportedValuesOf('timeZone')` ne liste que les identifiants
  // canoniques : s'y adosser basculerait sur UTC des établissements dont le
  // fuseau fonctionne parfaitement.
  it.each(['UTC', 'Etc/GMT+5', 'America/Argentina/Buenos_Aires'])(
    'tient « %s » pour valide — les liens tzdata ne sont pas des fuseaux cassés',
    async (timezone) => {
      const harness = harnessOver([{ id: TENANT_A, slug: 'spa-lumiere', timezone }]);

      const report = await harness.service.audit();

      expect(report.invalid).toBe(0);
      expect(harness.stored()[0]?.timezone).toBe(timezone);
    },
  );

  it('bascule un fuseau inconnu sur le repli et le journalise', async () => {
    const harness = harnessOver([
      { id: TENANT_A, slug: 'spa-lumiere', timezone: 'Pas/UnFuseau' },
      { id: TENANT_B, slug: 'karibu-spa', timezone: 'Indian/Antananarivo' },
    ]);

    const report = await harness.service.audit();

    expect(report.scanned).toBe(2);
    expect(report.invalid).toBe(1);
    expect(report.repaired).toBe(1);
    expect(report.repairs).toEqual([
      {
        tenantId: TENANT_A,
        slug: 'spa-lumiere',
        rejected: 'Pas/UnFuseau',
        fallback: FALLBACK_TIME_ZONE,
        repaired: true,
      },
    ]);

    // La colonne porte le repli ; le voisin valide n'a pas bougé.
    expect(harness.stored()).toEqual([
      { id: TENANT_A, slug: 'spa-lumiere', timezone: FALLBACK_TIME_ZONE },
      { id: TENANT_B, slug: 'karibu-spa', timezone: 'Indian/Antananarivo' },
    ]);
  });

  it('le repli est lui-même un fuseau qu’ICU résout', () => {
    // Une évidence à écrire une fois : un repli invalide rendrait le rattrapage
    // strictement inutile, et le défaut ne se verrait qu'au calcul de créneaux.
    expect(() => new Intl.DateTimeFormat('en-US', { timeZone: FALLBACK_TIME_ZONE })).not.toThrow();
  });

  it('journalise la valeur refusée, le slug et le tenant — la colonne ne les porte plus', async () => {
    const harness = harnessOver([{ id: TENANT_A, slug: 'spa-lumiere', timezone: 'Europe/Pais' }]);

    await harness.service.audit();

    const detail = harness.lines().find((line) => line.message.includes('Europe/Pais'));
    expect(detail?.level).toBe('warn');
    expect(detail?.meta).toEqual({
      tenantId: TENANT_A,
      slug: 'spa-lumiere',
      rejectedTimezone: 'Europe/Pais',
      fallbackTimezone: FALLBACK_TIME_ZONE,
    });

    // Une ligne de synthèse en plus du détail : c'est celle qu'une alarme suit.
    const synthese = harness
      .lines()
      .find((line) => line.level === 'warn' && line.meta['invalid'] === 1);
    expect(synthese?.meta).toEqual({ scanned: 1, invalid: 1, repaired: 1 });
  });

  it('n’écrase pas la valeur qu’une autre instance a posée entre le relevé et l’écriture', async () => {
    const harness = harnessOver(
      [{ id: TENANT_A, slug: 'spa-lumiere', timezone: 'Pas/UnFuseau' }],
      // Un gérant — ou une autre tâche ECS — écrit un fuseau valide juste avant.
      { stolenBy: 'Europe/Lisbon' },
    );

    const report = await harness.service.audit();

    expect(report.repaired).toBe(0);
    expect(report.repairs[0]?.repaired).toBe(false);
    // La bascule était conditionnée : la valeur fraîchement saisie survit.
    expect(harness.stored()[0]?.timezone).toBe('Europe/Lisbon');
    expect(harness.writes()).toEqual([
      { tenantId: TENANT_A, expected: 'Pas/UnFuseau', fallback: FALLBACK_TIME_ZONE },
    ]);
  });

  it('traite chaque ligne fautive, sans s’arrêter à la première', async () => {
    const harness = harnessOver([
      { id: TENANT_A, slug: 'spa-lumiere', timezone: 'Pas/UnFuseau' },
      { id: TENANT_B, slug: 'karibu-spa', timezone: 'GMT+3' },
    ]);

    const report = await harness.service.audit();

    expect(report.repaired).toBe(2);
    expect(harness.stored().map((row) => row.timezone)).toEqual([
      FALLBACK_TIME_ZONE,
      FALLBACK_TIME_ZONE,
    ]);
  });

  it('journalise et laisse démarrer l’API quand le relevé échoue', async () => {
    const harness = harnessOver([], { listFails: new Error('connexion refusée') });

    harness.service.onApplicationBootstrap();
    await expect(harness.service.onModuleDestroy()).resolves.toBeUndefined();

    const failure = harness.lines().find((line) => line.level === 'error');
    expect(failure?.message).toContain('Relevé des fuseaux horaires impossible');
  });

  it('rattrape depuis l’amorçage, sans qu’on ait à appeler `audit`', async () => {
    const harness = harnessOver([{ id: TENANT_A, slug: 'spa-lumiere', timezone: 'Pas/UnFuseau' }]);

    harness.service.onApplicationBootstrap();
    await harness.service.onModuleDestroy();

    expect(harness.stored()[0]?.timezone).toBe(FALLBACK_TIME_ZONE);
  });

  // Le crochet d'amorçage ne rend pas de promesse : Nest ne l'attend donc pas, et
  // une base injoignable ne retarde pas la mise en service de la tâche ECS.
  // C'est la contrepartie du choix de `PrismaService` de ne pas se connecter à
  // l'initialisation — voir `prisma.service.spec.ts`.
  it('ne bloque pas le démarrage : l’amorçage rend la main avant le relevé', () => {
    const harness = harnessOver([{ id: TENANT_A, slug: 'spa-lumiere', timezone: 'Pas/UnFuseau' }]);

    expect(harness.service.onApplicationBootstrap()).toBeUndefined();
    // Le relevé n'a pas encore eu lieu : la ligne porte toujours sa valeur.
    expect(harness.stored()[0]?.timezone).toBe('Pas/UnFuseau');
  });

  it('aucune requête ne survit à la fermeture — `onModuleDestroy` attend le balayage', async () => {
    const harness = harnessOver([{ id: TENANT_A, slug: 'spa-lumiere', timezone: 'Pas/UnFuseau' }]);

    harness.service.onApplicationBootstrap();
    await harness.service.onModuleDestroy();

    expect(harness.writes()).toHaveLength(1);
  });

  it('se ferme sans incident quand l’amorçage n’a jamais eu lieu', async () => {
    const harness = harnessOver([]);

    await expect(harness.service.onModuleDestroy()).resolves.toBeUndefined();
    expect(harness.writes()).toHaveLength(0);
  });
});
