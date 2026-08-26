import { type Linter, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';

import tenantPlugin from '../index';

/**
 * Les deux gardes de #169, éprouvées sur du code qui ressemble à celui qu'elles
 * surveillent : un repository Nest et des appels de SQL brut Prisma.
 *
 * Chaque règle porte au moins un cas passant et un cas fautif — c'est le
 * quatrième critère d'acceptation du ticket. Les cas fautifs sont écrits sous la
 * forme exacte de la fuite qu'ils préviennent : une requête brute sans filtre
 * tenant, et une dérogation au scoping qui se cache derrière un nom anodin.
 */
const ruleTester = new RuleTester({
  languageOptions: {
    // `RuleTester` type le parseur par la forme minimale de `Linter.Parser` ;
    // celui de typescript-eslint expose `parseForESLint` et satisfait le
    // contrat, mais pas la déclaration nominale. La conversion est ici, une
    // fois, plutôt qu'à chaque cas de test.
    parser: tseslint.parser as unknown as Linter.Parser,
    parserOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
});

const rawSqlTenantFilter = tenantPlugin.rules['raw-sql-tenant-filter'];
const unscopedPrismaName = tenantPlugin.rules['unscoped-prisma-name'];

ruleTester.run('tenant/raw-sql-tenant-filter', rawSqlTenantFilter, {
  valid: [
    {
      name: 'gabarit paramétré portant son propre filtre tenant',
      code: [
        'async function overlapping(prisma: Client, tenantId: string, staffId: string) {',
        '  return prisma.$queryRaw`SELECT id FROM appointments',
        '    WHERE tenant_id = ${tenantId} AND staff_id = ${staffId}`;',
        '}',
      ].join('\n'),
    },
    {
      name: 'variante « unsafe », filtre tenant écrit dans la chaîne',
      code: "prisma.$executeRawUnsafe('UPDATE appointments SET status = $1 WHERE tenant_id = $2', status, tenantId);",
    },
    {
      name: 'fragment Prisma.sql imbriqué, filtre tenant lisible au site d’appel',
      code: 'prisma.$queryRaw(Prisma.sql`SELECT count(*) FROM services WHERE tenant_id = ${tenantId}`);',
    },
    {
      name: 'une opération de modèle ordinaire ne concerne pas la règle',
      code: 'prisma.appointment.findMany({ where: { staffId } });',
    },
    {
      name: 'une méthode homonyme sur un autre objet non plus',
      code: 'logger.$queryRawCount({ label: "sans tenant" });',
    },
  ],
  invalid: [
    {
      name: 'gabarit sans filtre tenant — la fuite que la règle prévient',
      code: 'prisma.$queryRaw`SELECT id FROM appointments WHERE starts_at > ${from}`;',
      errors: [{ messageId: 'missingTenantFilter' }],
    },
    {
      name: 'variante « unsafe » sans filtre tenant',
      code: "prisma.$executeRaw`DELETE FROM appointments WHERE id = ${id}`;",
      errors: [{ messageId: 'missingTenantFilter' }],
    },
    {
      name: 'SQL construit ailleurs : illisible, donc refusé',
      code: 'prisma.$executeRawUnsafe(buildStatement(filters));',
      errors: [{ messageId: 'opaqueSql' }],
    },
    {
      name: 'accès calculé — la forme indirecte ne contourne pas la garde',
      code: "prisma['$queryRawUnsafe'](statement);",
      errors: [{ messageId: 'opaqueSql' }],
    },
    {
      name: 'un littéral de valeur liée ne se fait pas passer pour le SQL',
      code: "prisma.$queryRawUnsafe(buildReportQuery(columns), 'tenant_id');",
      errors: [{ messageId: 'opaqueSql' }],
    },
    {
      name: 'un tenant_id qui n’est que dans un commentaire ne désarme pas la garde',
      code: [
        'prisma.$queryRaw`SELECT id FROM appointments',
        '  -- pas de tenant_id ici : agrégat interne',
        '  WHERE starts_at > ${from}`;',
      ].join('\n'),
      errors: [{ messageId: 'missingTenantFilter' }],
    },
    {
      name: 'commentaire de bloc, même verdict',
      code: 'prisma.$executeRawUnsafe("DELETE FROM appointments /* tenant_id */ WHERE id = $1", id);',
      errors: [{ messageId: 'missingTenantFilter' }],
    },
  ],
});

ruleTester.run('tenant/unscoped-prisma-name', unscopedPrismaName, {
  valid: [
    {
      name: 'la dérogation porte le nom que prisma-clients.ts annonce',
      code: [
        'class IdentityRepository {',
        '  public constructor(',
        '    @Inject(PRISMA_UNSCOPED) private readonly prismaUnscoped: UnscopedPrismaClient,',
        '  ) {}',
        '}',
      ].join('\n'),
    },
    {
      name: 'le client scopé est le chemin normal : aucun nom imposé',
      code: [
        'class CatalogRepository {',
        '  public constructor(@Inject(PRISMA) private readonly prisma: ScopedPrismaClient) {}',
        '}',
      ].join('\n'),
    },
    {
      name: 'symbole importé sous forme qualifiée, nom conforme',
      code: [
        'class ReminderScanner {',
        '  public constructor(',
        '    @Inject(clients.PRISMA_UNSCOPED) private readonly prismaUnscoped: UnscopedPrismaClient,',
        '  ) {}',
        '}',
      ].join('\n'),
    },
    {
      name: 'fabrique sans décorateur, paramètre correctement nommé',
      code: [
        'const provider = {',
        '  provide: REMINDER_SCANNER,',
        '  useFactory: (prismaUnscoped: UnscopedPrismaClient) => new ReminderScanner(prismaUnscoped),',
        '  inject: [PRISMA_UNSCOPED],',
        '};',
      ].join('\n'),
    },
    {
      name: 'fabrique dont aucun paramètre ne reçoit le client non scopé',
      code: [
        'const provider = {',
        '  provide: PRISMA,',
        '  useFactory: createScopedPrismaClient,',
        '  inject: [PrismaService],',
        '};',
      ].join('\n'),
    },
  ],
  invalid: [
    {
      name: 'paramètre-propriété au nom anodin — la dérogation devient invisible',
      code: [
        'class IdentityRepository {',
        '  public constructor(',
        '    @Inject(PRISMA_UNSCOPED) private readonly db: UnscopedPrismaClient,',
        '  ) {}',
        '}',
      ].join('\n'),
      errors: [{ messageId: 'wrongName', data: { required: 'prismaUnscoped', actual: 'db' } }],
    },
    {
      name: 'propriété de classe injectée sous un autre nom',
      code: [
        'class ReportingRepository {',
        '  @Inject(PRISMA_UNSCOPED)',
        '  private readonly database!: UnscopedPrismaClient;',
        '}',
      ].join('\n'),
      errors: [{ messageId: 'wrongName' }],
    },
    {
      name: 'symbole qualifié, nom non conforme',
      code: [
        'class ReminderScanner {',
        '  public constructor(',
        '    @Inject(clients.PRISMA_UNSCOPED) private readonly prisma: UnscopedPrismaClient,',
        '  ) {}',
        '}',
      ].join('\n'),
      errors: [{ messageId: 'wrongName' }],
    },
    {
      name: 'fabrique sans décorateur — la forme `inject` ne contourne pas la garde',
      code: [
        'const provider = {',
        '  provide: REMINDER_SCANNER,',
        '  useFactory: (config: AppConfigService, db: UnscopedPrismaClient) =>',
        '    new ReminderScanner(config, db),',
        '  inject: [AppConfigService, PRISMA_UNSCOPED],',
        '};',
      ].join('\n'),
      errors: [{ messageId: 'wrongName', data: { required: 'prismaUnscoped', actual: 'db' } }],
    },
  ],
});
