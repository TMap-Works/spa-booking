import { type Linter, RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';

import tenantPlugin from '../index';

/**
 * Les trois gardes du scoping (#169, durcies et complétées par #268), éprouvées
 * sur du code qui ressemble à celui qu'elles surveillent : un repository Nest,
 * des appels de SQL brut Prisma, un import de `pg`.
 *
 * Chaque règle porte au moins un cas passant et un cas fautif. Les cas fautifs
 * sont écrits sous la forme exacte de la fuite qu'ils préviennent : une requête
 * brute sans filtre tenant, un `tenant_id` qui ne filtre rien, une dérogation au
 * scoping cachée derrière un nom anodin, un second pool PostgreSQL.
 *
 * Les cas passants de `raw-sql-tenant-filter` comptent autant que les fautifs :
 * ils bornent le durcissement de #268. Le moteur de disponibilité (#31) écrit du
 * SQL brut légitime en ce moment même, et un faux positif y coûterait plus cher
 * qu'un faux négatif que la revue rattrape.
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
const servicePoolConfinement = tenantPlugin.rules['service-pool-confinement'];
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
    // Les trois formes légitimes que #268 nomme explicitement, et que le
    // durcissement de la position ne doit pas rejeter.
    {
      name: 'jointure USING (tenant_id) — l’égalité est implicite',
      code: [
        'prisma.$queryRaw`SELECT a.id FROM appointments a',
        '  JOIN staff s USING (tenant_id, staff_id)',
        '  WHERE a.starts_at > ${from}`;',
      ].join('\n'),
    },
    {
      name: 'jointure ON a.tenant_id = b.tenant_id — colonnes qualifiées',
      code: [
        'prisma.$queryRaw`SELECT a.id FROM appointments a',
        '  JOIN services s ON a.tenant_id = s.tenant_id AND a.service_id = s.id',
        '  WHERE a.starts_at > ${from}`;',
      ].join('\n'),
    },
    {
      name: 'INSERT INTO … (tenant_id, …) — la colonne est portée, jamais comparée',
      code: [
        'prisma.$executeRaw`INSERT INTO appointments (tenant_id, id, starts_at)',
        '  VALUES (${tenantId}, ${id}, ${startsAt})`;',
      ].join('\n'),
    },
    {
      name: 'transtypage tenant_id::text = $1',
      code: "prisma.$queryRawUnsafe('SELECT id FROM appointments WHERE tenant_id::text = $1', tenantId);",
    },
    {
      name: 'identifiant entre guillemets doubles',
      code: 'prisma.$queryRaw`SELECT id FROM appointments WHERE "tenant_id" = ${tenantId}`;',
    },
    {
      name: 'la valeur à gauche de la comparaison',
      code: 'prisma.$queryRaw`SELECT id FROM appointments a WHERE ${tenantId} = a.tenant_id`;',
    },
    {
      name: 'tenant_id IN (…) — comparaison d’appartenance',
      code: 'prisma.$queryRaw`SELECT id FROM appointments WHERE tenant_id IN (${Prisma.join(ids)})`;',
    },
    {
      name: 'contrainte d’exclusion anti-double-réservation : tenant_id WITH = (ADR 0002)',
      code: [
        'prisma.$executeRawUnsafe(`ALTER TABLE appointments',
        '  ADD CONSTRAINT appointments_no_overlap',
        '  EXCLUDE USING gist (tenant_id WITH =, staff_id WITH =, during WITH &&)',
        '  WHERE (status <> \'cancelled\')`);',
      ].join('\n'),
    },
    {
      name: 'colonne parenthésée, et comparaison de n-uplet sur la clé composite',
      code: 'prisma.$queryRaw`SELECT id FROM appointments WHERE (tenant_id, id) = (${tenantId}, ${id})`;',
    },
    {
      name: 'tenant_id IS NOT DISTINCT FROM $1 — la négation de IS NULL ne l’emporte pas',
      code: 'prisma.$queryRaw`SELECT id FROM appointments WHERE tenant_id IS NOT DISTINCT FROM ${tenantId}`;',
    },
    {
      name: 'la colonne et son opérateur séparés par une interpolation littérale',
      // Le tri des fragments sur leur position dans le source est ce qui garde
      // `tenant_id` et `=` voisins : l'ordre des clés de l'AST place les
      // `expressions` avant les `quasis` et les aurait dissociés.
      code: "prisma.$queryRawUnsafe(`SELECT id FROM appointments WHERE tenant_id ${'='} $1`, tenantId);",
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
    // Le durcissement de #268 : la colonne est là, mais elle ne filtre rien.
    {
      name: 'projeté et groupé, jamais filtré — la fuite que #268 ferme',
      code: 'prisma.$queryRaw`SELECT tenant_id, count(*) FROM appointments GROUP BY tenant_id`;',
      errors: [{ messageId: 'tenantNotFiltering' }],
    },
    {
      name: 'trié sur tenant_id : un tri n’est pas un prédicat',
      code: 'prisma.$queryRaw`SELECT id FROM appointments ORDER BY tenant_id, starts_at`;',
      errors: [{ messageId: 'tenantNotFiltering' }],
    },
    {
      name: 'simplement projeté, avec un filtre qui porte sur autre chose',
      code: 'prisma.$queryRaw`SELECT id, tenant_id FROM appointments WHERE starts_at > ${from}`;',
      errors: [{ messageId: 'tenantNotFiltering' }],
    },
    {
      // `tenant_id` est `NOT NULL` : ce prédicat est toujours vrai et lit tous
      // les établissements, tout en ayant la forme d'une comparaison.
      name: 'tenant_id IS NOT NULL — un prédicat qui ne borne rien',
      code: 'prisma.$queryRaw`SELECT id FROM appointments WHERE tenant_id IS NOT NULL`;',
      errors: [{ messageId: 'tenantNotFiltering' }],
    },
  ],
});

ruleTester.run('tenant/service-pool-confinement', servicePoolConfinement, {
  valid: [
    {
      name: 'le propriétaire du pool a le droit d’importer pg',
      filename: 'src/infrastructure/database/database.connection.ts',
      code: "import { Pool } from 'pg';",
    },
    {
      name: 'le chemin absolu en séparateurs Windows est reconnu de la même façon',
      filename: 'D:\\repo\\apps\\api\\src\\infrastructure\\database\\database.connection.ts',
      code: "import { Pool } from 'pg';",
    },
    {
      name: 'un repository importe le client Prisma scopé, pas pg',
      filename: 'src/modules/catalog/catalog.repository.ts',
      code: "import { PRISMA } from '../../infrastructure/database/prisma-clients';",
    },
    {
      name: 'un module dont le nom commence par pg n’est pas pg',
      filename: 'src/modules/catalog/catalog.repository.ts',
      code: "import { render } from 'pgfmt';",
    },
  ],
  invalid: [
    {
      name: 'un repository ouvre son propre pool — le second chemin que la règle ferme',
      filename: 'src/modules/appointments/appointments.repository.ts',
      code: "import { Pool } from 'pg';",
      errors: [{ messageId: 'poolOutsideOwner', data: { module: 'pg' } }],
    },
    {
      name: 'un import de type ne fait pas exception',
      filename: 'src/modules/availability/availability.repository.ts',
      code: "import type { PoolClient } from 'pg';",
      errors: [{ messageId: 'poolOutsideOwner' }],
    },
    {
      name: 'réexporter le module reviendrait à le déplacer sans le confiner',
      filename: 'src/infrastructure/database/pool.ts',
      code: "export { Pool } from 'pg';",
      errors: [{ messageId: 'poolOutsideOwner' }],
    },
    {
      name: 'pg-pool est la même porte sous un autre nom',
      filename: 'src/modules/reporting/reporting.repository.ts',
      code: "import Pool from 'pg-pool';",
      errors: [{ messageId: 'poolOutsideOwner', data: { module: 'pg-pool' } }],
    },
    {
      name: 'require ne contourne pas la garde',
      filename: 'src/modules/crm/crm.repository.ts',
      code: "const { Pool } = require('pg');",
      errors: [{ messageId: 'poolOutsideOwner' }],
    },
    {
      name: 'un sous-chemin du paquet est le même paquet',
      filename: 'src/modules/crm/crm.repository.ts',
      code: "import { Client } from 'pg/lib/client';",
      errors: [{ messageId: 'poolOutsideOwner', data: { module: 'pg/lib/client' } }],
    },
    {
      name: 'la forme `import … = require(…)` non plus',
      filename: 'src/modules/crm/crm.repository.ts',
      code: "import pg = require('pg');",
      errors: [{ messageId: 'poolOutsideOwner' }],
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
