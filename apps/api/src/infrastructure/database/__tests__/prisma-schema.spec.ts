import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { MIGRATIONS_DIR, PRISMA_DIR, readMigrationSql } from './migration-sql';

/**
 * Le schéma comme objet de test.
 *
 * Les règles vérifiées ici ne sont pas des préférences de style : ce sont les
 * contraintes non négociables du projet (CLAUDE.md), et une seule table qui y
 * échappe suffit à ouvrir une fuite inter-tenant ou à fausser une somme d'argent.
 * Or aucune d'elles n'est vérifiable en TypeScript — Prisma acceptera toujours
 * un `tenant_id` nullable ou un prix en flottant.
 *
 * C'est le **SQL de migration** qui est relu, pas seulement `schema.prisma` :
 * c'est lui qui s'exécute sur PostgreSQL, et c'est donc lui qui décrit ce qui
 * existera vraiment. `schema.prisma` n'est interrogé que pour ce que le SQL ne
 * dit pas — la génération applicative des UUID.
 *
 * La lecture elle-même vit dans `./migration-sql` : `roles.spec.ts` relit le même
 * texte pour l'ordre du type `UserRole`, et deux lecteurs jumeaux finiraient par
 * asserter sur deux textes différents (#217).
 *
 * Le test est volontairement générique : il découvre les tables au lieu de les
 * énumérer. Une huitième table ajoutée demain sans `tenant_id` fera rougir cette
 * suite sans que personne ait pensé à l'y inscrire.
 */

/**
 * `tenants` est la seule table exemptée de `tenant_id` : elle *est* le tenant.
 * Toute autre exception se documente en ADR (tenant-isolation §1) — et se
 * traduit ici par une ligne ajoutée à cette liste, donc visible en revue.
 */
const TENANT_ROOT_TABLE = 'tenants';

/**
 * Les sept entités du CDC §2.4, plus la jonction N–N Service↔Staff et la table
 * de sessions du module `identity`.
 *
 * `refresh_tokens` n'est pas une huitième entité métier : c'est l'état qui rend
 * la déconnexion invalidante (#21). Un JWT signé ne se révoque pas — sans ligne
 * en base, « se déconnecter » se réduirait à effacer un cookie que l'attaquant
 * qui l'a volé n'effacera pas. Elle est inscrite ici pour la même raison que les
 * autres : que son `tenant_id`, ses index et ses clés composites soient relus
 * par cette suite comme ceux de n'importe quelle table métier.
 *
 * `service_categories` n'en est pas une neuvième : le CDC §2.4 nomme la
 * catégorie comme un attribut de la prestation, et elle l'était — une chaîne
 * libre recopiée dans `services.category`. #24 la normalise en table pour
 * qu'elle se crée, se renomme et se retire du catalogue en un geste plutôt
 * qu'une prestation à la fois. Même exigence qu'ailleurs, donc : `tenant_id`,
 * index préfixés, unique composite.
 *
 * `staff_schedules` et `tenant_closing_days` non plus ne sont pas des entités
 * nouvelles : le CDC §1.4 range les horaires du personnel dans la gestion du
 * personnel, et la fermeture de l'établissement dans son paramétrage. #32 les
 * pose en tables parce qu'un praticien a plusieurs plages par jour — la coupure
 * méridienne — et que rien de tout cela ne tient dans une colonne. Elles sont
 * inscrites ici pour la même raison que les autres : que leur `tenant_id`, leurs
 * index et leurs clés composites soient relus par cette suite.
 *
 * `tenant_opening_hours` est de la même famille que `tenant_closing_days` : le
 * CDC §1.4 range les horaires d'ouverture dans le paramétrage de
 * l'établissement, et #343 les pose en table parce qu'un salon ferme entre midi
 * et deux — il faut plusieurs plages par jour, ce qu'une colonne ne sait pas
 * dire. Elle n'entre pas dans le calcul des créneaux : elle décrit ce que la
 * vitrine publique affiche. Inscrite ici pour la même raison que les autres.
 *
 * `staff_time_off` complète les deux précédentes par leur envers : elles disent
 * quand le praticien travaille, elle dit quand il est absent. #33 la pose à part
 * plutôt qu'en colonne d'`appointments` — une absence n'a ni client, ni
 * prestation, ni prix, et un statut d'annulation n'aurait rien voulu dire — et
 * elle est soumise aux mêmes exigences que les autres.
 */
/*
 * `processed_webhook_events` n'est pas non plus une entité neuve du CDC : c'est
 * l'état qui rend le rejeu d'un webhook Stripe inoffensif (#58,
 * payments-stripe §3). Elle est inscrite ici pour la même raison que
 * `refresh_tokens` — que son `tenant_id`, ses index et son unique composite
 * soient relus par cette suite comme ceux de n'importe quelle table métier.
 * Le skill la décrit sans tenant ; ce schéma lui en donne un, parce que
 * tenant-isolation §1 n'admet d'exception que par ADR.
 *
 * `products`, `sales` et `sale_items` sont le POS de base du CDC §1.4
 * (« services + produits retail »), posé par #60. `sales` et `sale_items` sont
 * la « transaction » que le CDC §2.4 nomme déjà, éclatée en un en-tête et ses
 * lignes parce qu'un ticket regroupe plusieurs articles — ce qu'une ligne
 * unique ne sait pas dire. `products` est le rayon revendable : il donne au
 * prix d'un article une source côté serveur, sans laquelle « le total est
 * recalculé côté serveur » n'aurait rien à recalculer.
 *
 * Elles sont inscrites ici pour la même raison que les autres — que leur
 * `tenant_id`, leurs index, leurs uniques composites et les `CHECK` de leurs
 * montants soient relus par cette suite.
 */
const EXPECTED_TABLES = [
  'tenants',
  'users',
  'services',
  'service_categories',
  'staff',
  'service_staff',
  'staff_schedules',
  'tenant_closing_days',
  'tenant_opening_hours',
  'staff_time_off',
  'appointments',
  'payments',
  'products',
  'sales',
  'sale_items',
  'notifications',
  'refresh_tokens',
  'processed_webhook_events',
] as const;

interface Column {
  name: string;
  definition: string;
  type: string;
  nullable: boolean;
}

interface Table {
  name: string;
  columns: Column[];
}

interface Index {
  name: string;
  table: string;
  unique: boolean;
  columns: string[];
}

interface ForeignKey {
  table: string;
  column: string;
  referencedTable: string;
  referencedColumn: string;
}

interface CompositeForeignKey {
  table: string;
  columns: string[];
  referencedTable: string;
  referencedColumns: string[];
}

interface CheckConstraint {
  table: string;
  name: string;
  expression: string;
}

/**
 * Groupe capturant obligatoire d'une expression rationnelle.
 *
 * `noUncheckedIndexedAccess` type tout groupe en `string | undefined`, y compris
 * ceux qu'une correspondance réussie garantit. Échouer bruyamment ici vaut mieux
 * que semer des `!` : si le format du SQL généré change, on veut un message qui
 * nomme le motif, pas un `undefined` qui se propage jusqu'à une assertion
 * incompréhensible.
 */
function group(match: RegExpMatchArray, index: number): string {
  const value = match[index];
  if (value === undefined) {
    throw new Error(`groupe ${index} absent de la correspondance « ${match[0]} »`);
  }
  return value;
}

/** Une colonne, telle que son fragment de SQL la décrit. */
function toColumn(name: string, definition: string): Column {
  return {
    name,
    definition,
    type: definition
      .replace(/\s+(NOT NULL|NULL)\b.*$/, '')
      .replace(/\s+DEFAULT\b.*$/, '')
      .trim(),
    nullable: !/\bNOT NULL\b/.test(definition),
  };
}

function parseTables(sql: string): Table[] {
  const tables: Table[] = [];
  // Le motif accepte les majuscules **à dessein** : une relation N–N implicite
  // de Prisma produit `CREATE TABLE "_ServiceToStaff"`. Bornée aux minuscules,
  // l'expression ne reconnaissait pas cette table — elle disparaissait du
  // résultat, et le test censé l'interdire ne pouvait plus jamais rougir.
  const tablePattern = /CREATE TABLE "([A-Za-z_0-9]+)" \(([\s\S]*?)\n\);/g;

  for (const match of sql.matchAll(tablePattern)) {
    const columns: Column[] = [];

    for (const line of group(match, 2).split('\n')) {
      // Les lignes de contrainte (`CONSTRAINT "x_pkey" PRIMARY KEY …`) ne
      // commencent pas par un guillemet : elles sont écartées d'office.
      const parsed = /^\s*"([A-Za-z_0-9]+)"\s+(.+?),?\s*$/.exec(line);
      if (parsed === null) {
        continue;
      }
      columns.push(toColumn(group(parsed, 1), group(parsed, 2)));
    }

    tables.push({ name: group(match, 1), columns });
  }

  applyAddedColumns(sql, tables);

  return tables;
}

/**
 * Replie les colonnes ajoutées après coup dans la table qu'elles complètent.
 *
 * Sans cela, une colonne née d'une migration ultérieure — `ALTER TABLE …
 * ADD COLUMN`, la forme normale de toute évolution additive (api-module §6) —
 * n'existe tout simplement pas pour cette suite : elle échappe au contrôle du
 * type entier d'un montant, du `timestamptz` d'un instant, de l'UUID d'une clé
 * étrangère. Le défaut n'était pas seulement une lacune de couverture, il était
 * **bruyant du mauvais côté** : une clé étrangère posée sur une telle colonne
 * faisait échouer le contrôle des types d'identifiants sur « la table n'a pas de
 * colonne », c'est-à-dire sur le parseur et non sur le schéma.
 *
 * `ADD COLUMN` seulement : le retrait d'une colonne est déjà interdit par le
 * test d'additivité, et une redéfinition de type ne se lit pas comme un ajout.
 */
function applyAddedColumns(sql: string, tables: Table[]): void {
  // Un `ALTER TABLE` peut enchaîner plusieurs `ADD COLUMN` séparés par des
  // virgules jusqu'au point-virgule — c'est la forme que génère Prisma.
  const statements = /ALTER TABLE "([A-Za-z_0-9]+)"\s+(ADD COLUMN[^;]*);/g;

  for (const statement of sql.matchAll(statements)) {
    const owner = tables.find((candidate) => candidate.name === group(statement, 1));
    if (owner === undefined) {
      throw new Error(`« ${group(statement, 1)} » complétée avant d'être créée`);
    }

    for (const added of group(statement, 2).matchAll(
      /ADD COLUMN\s+"([A-Za-z_0-9]+)"\s+([^,]+?)\s*(?:,|$)/g,
    )) {
      owner.columns.push(toColumn(group(added, 1), group(added, 2)));
    }
  }
}

function parseIndexes(sql: string): Index[] {
  const indexes: Index[] = [];
  const pattern = /CREATE (UNIQUE )?INDEX "([^"]+)" ON "([A-Za-z_0-9]+)"\(([^)]*)\);/g;

  for (const match of sql.matchAll(pattern)) {
    indexes.push({
      name: group(match, 2),
      table: group(match, 3),
      unique: match[1] !== undefined,
      columns: [...group(match, 4).matchAll(/"([A-Za-z_0-9]+)"/g)].map((candidate) =>
        group(candidate, 1),
      ),
    });
  }

  return indexes;
}

function parseForeignKeys(sql: string): ForeignKey[] {
  const pattern =
    /ALTER TABLE "([A-Za-z_0-9]+)" ADD CONSTRAINT "[^"]+" FOREIGN KEY \("([A-Za-z_0-9]+)"\) REFERENCES "([A-Za-z_0-9]+)"\("([A-Za-z_0-9]+)"\)/g;

  return [...sql.matchAll(pattern)].map((match) => ({
    table: group(match, 1),
    column: group(match, 2),
    referencedTable: group(match, 3),
    referencedColumn: group(match, 4),
  }));
}

function quotedNames(list: string): string[] {
  return [...list.matchAll(/"([A-Za-z_0-9]+)"/g)].map((candidate) => group(candidate, 1));
}

/**
 * Clés étrangères **composites** — celles que Prisma ne génère pas et que la
 * migration pose à la main. Le motif exige au moins deux colonnes, ce qui le rend
 * disjoint de `parseForeignKeys` : aucune clé n'est lue deux fois.
 */
function parseCompositeForeignKeys(sql: string): CompositeForeignKey[] {
  const pattern =
    /ALTER TABLE "([A-Za-z_0-9]+)" ADD CONSTRAINT "[^"]+" FOREIGN KEY \(("[A-Za-z_0-9]+"(?:, "[A-Za-z_0-9]+")+)\) REFERENCES "([A-Za-z_0-9]+)"\(("[A-Za-z_0-9]+"(?:, "[A-Za-z_0-9]+")+)\)/g;

  return [...sql.matchAll(pattern)].map((match) => ({
    table: group(match, 1),
    columns: quotedNames(group(match, 2)),
    referencedTable: group(match, 3),
    referencedColumns: quotedNames(group(match, 4)),
  }));
}

/** Contraintes `CHECK` — inexprimables en Prisma, donc écrites en SQL brut. */
function parseCheckConstraints(sql: string): CheckConstraint[] {
  const pattern = /ALTER TABLE "([A-Za-z_0-9]+)" ADD CONSTRAINT "([^"]+)" CHECK \(([^;]*)\);/g;

  return [...sql.matchAll(pattern)].map((match) => ({
    table: group(match, 1),
    name: group(match, 2),
    expression: group(match, 3),
  }));
}

const sql = readMigrationSql();
const schema = readFileSync(join(PRISMA_DIR, 'schema.prisma'), 'utf8');
const tables = parseTables(sql);
const indexes = parseIndexes(sql);
const foreignKeys = parseForeignKeys(sql);
const compositeForeignKeys = parseCompositeForeignKeys(sql);
const checkConstraints = parseCheckConstraints(sql);
const businessTables = tables.filter((table) => table.name !== TENANT_ROOT_TABLE);

function lookupTable(name: string): Table {
  const found = tables.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`la migration ne crée aucune table « ${name} »`);
  }
  return found;
}

function column(table: Table, name: string): Column {
  const found = table.columns.find((candidate) => candidate.name === name);
  if (found === undefined) {
    throw new Error(`la table "${table.name}" n'a pas de colonne "${name}"`);
  }
  return found;
}

describe('Schéma Prisma — entités du CDC §2.4', () => {
  it('déclare les sept entités du CDC et la jonction Service↔Staff', () => {
    expect(tables.map((table) => table.name).sort()).toEqual([...EXPECTED_TABLES].sort());
  });

  it('déclare une table métier pour chaque relation N–N, jamais une jonction implicite', () => {
    // Une relation implicite de Prisma produit une table `_ServiceToStaff` sans
    // `tenant_id` : elle rendrait représentable l'affectation du praticien d'un
    // salon à la prestation d'un autre.
    expect(tables.filter((table) => table.name.startsWith('_'))).toEqual([]);
  });
});

describe('Schéma Prisma — isolation multi-tenant', () => {
  it('porte un `tenant_id` non nullable sur toute table métier', () => {
    for (const table of businessTables) {
      const tenantId = column(table, 'tenant_id');
      expect({ table: table.name, type: tenantId.type, nullable: tenantId.nullable }).toEqual({
        table: table.name,
        type: 'UUID',
        nullable: false,
      });
    }
  });

  it('rattache chaque `tenant_id` à `tenants` par une clé étrangère', () => {
    for (const table of businessTables) {
      expect(
        foreignKeys.find(
          (key) =>
            key.table === table.name &&
            key.column === 'tenant_id' &&
            key.referencedTable === TENANT_ROOT_TABLE &&
            key.referencedColumn === 'id',
        ),
      ).toBeDefined();
    }
  });

  it('déclare `tenantId` non optionnel dans chaque modèle sauf `Tenant`', () => {
    // Le SQL ne dit rien du typage Prisma : un `tenantId String?` produirait une
    // colonne nullable, mais un `tenantId String` mal `@map`é passerait inaperçu.
    const models = [...schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm)];
    expect(models.length).toBe(EXPECTED_TABLES.length);

    for (const model of models) {
      const body = group(model, 2);
      if (group(model, 1) === 'Tenant') {
        expect(body).not.toContain('tenantId');
        continue;
      }
      expect(body).toMatch(/^\s+tenantId\s+String\s+@map\("tenant_id"\)/m);
    }
  });

  it('préfixe de `tenant_id` tout index posé sur une table métier', () => {
    const offenders = indexes
      .filter((index) => index.table !== TENANT_ROOT_TABLE)
      .filter((index) => index.columns[0] !== 'tenant_id')
      .map((index) => `${index.name} (${index.columns.join(', ')})`);

    expect(offenders).toEqual([]);
  });

  it('rend composite avec `tenant_id` tout unique métier', () => {
    const uniques = indexes.filter(
      (index) => index.unique && index.table !== TENANT_ROOT_TABLE,
    );

    // Sans cette borne, le test passerait sur un schéma qui n'aurait plus aucun
    // unique — c'est-à-dire qui aurait perdu ses règles d'unicité métier.
    expect(uniques.length).toBeGreaterThan(0);

    for (const unique of uniques) {
      expect({ name: unique.name, columns: unique.columns }).toEqual({
        name: unique.name,
        columns: expect.arrayContaining(['tenant_id']),
      });
      expect(unique.columns.length).toBeGreaterThan(1);
    }
  });

  it("n'expose aucun identifiant séquentiel — tout est UUID", () => {
    expect(sql).not.toMatch(/\b(SERIAL|BIGSERIAL|SMALLSERIAL|IDENTITY)\b/i);

    for (const table of tables) {
      expect({ table: table.name, type: column(table, 'id').type }).toEqual({
        table: table.name,
        type: 'UUID',
      });
    }

    // Toute colonne de clé étrangère est elle aussi un UUID.
    for (const key of foreignKeys) {
      const owner = lookupTable(key.table);
      expect({ column: `${key.table}.${key.column}`, type: column(owner, key.column).type }).toEqual(
        { column: `${key.table}.${key.column}`, type: 'UUID' },
      );
    }
  });

  it('génère les identifiants en UUID v4 côté application', () => {
    // `uuid()` de Prisma produit une v4. Le SQL ne peut pas en témoigner : la
    // valeur est posée par le client, la colonne n'a pas de `DEFAULT`.
    const ids = [...schema.matchAll(/^\s+id\s+String\s+(.*)$/gm)].map((match) => group(match, 1));
    expect(ids.length).toBe(EXPECTED_TABLES.length);
    for (const id of ids) {
      expect(id).toContain('@default(uuid())');
      expect(id).toContain('@db.Uuid');
    }
  });
});

describe('Schéma Prisma — horodatage et fuseau', () => {
  it('date toute table métier de `created_at` et `updated_at` non nullables', () => {
    for (const table of tables) {
      for (const name of ['created_at', 'updated_at']) {
        const timestamp = column(table, name);
        expect({ column: `${table.name}.${name}`, nullable: timestamp.nullable }).toEqual({
          column: `${table.name}.${name}`,
          nullable: false,
        });
      }
    }
  });

  it("n'accepte aucun instant sans fuseau", () => {
    // `TIMESTAMP` sans `TZ` stocke une heure murale : deux salons dans deux
    // fuseaux liraient la même ligne à deux instants différents.
    for (const table of tables) {
      for (const candidate of table.columns) {
        if (!/\b(TIMESTAMP|DATE|TIME)\b/i.test(candidate.type)) {
          continue;
        }
        expect({
          column: `${table.name}.${candidate.name}`,
          type: candidate.type.replace(/\(\d+\)/, ''),
        }).toEqual({ column: `${table.name}.${candidate.name}`, type: 'TIMESTAMPTZ' });
      }
    }
  });

  it('exige un fuseau IANA sur chaque établissement, sans valeur par défaut', () => {
    const timezone = column(lookupTable(TENANT_ROOT_TABLE), 'timezone');

    expect(timezone.nullable).toBe(false);
    // Un défaut silencieux décalerait tout un agenda : le fuseau se déclare à la
    // création de l'établissement, ou l'insertion échoue.
    expect(timezone.definition).not.toMatch(/\bDEFAULT\b/i);
  });
});

describe('Schéma Prisma — montants', () => {
  it("n'emploie aucun type flottant, nulle part", () => {
    expect(sql).not.toMatch(/\b(DOUBLE PRECISION|REAL|FLOAT\d*|NUMERIC|DECIMAL|MONEY)\b/i);
  });

  it('stocke chaque montant en entier, accompagné de son code devise', () => {
    const amounts = tables.flatMap((table) =>
      table.columns
        // Sans le trait de tête : `endsWith('_amount_minor')` manquait
        // `payments.amount_minor`, la colonne de montant principale du schéma.
        .filter((candidate) => candidate.name.endsWith('amount_minor'))
        .map((candidate) => ({ table, candidate })),
    );

    expect(amounts.length).toBeGreaterThan(0);

    for (const { table, candidate } of amounts) {
      expect({ column: `${table.name}.${candidate.name}`, type: candidate.type }).toEqual({
        column: `${table.name}.${candidate.name}`,
        type: 'INTEGER',
      });

      // Un montant sans devise n'est pas un montant. La devise vit dans la même
      // table, en ISO 4217 sur trois caractères.
      const currency = table.columns.find(
        (other) => other.name === 'currency' || other.name.endsWith('_currency'),
      );
      expect({ table: table.name, currency: currency?.type }).toEqual({
        table: table.name,
        currency: 'CHAR(3)',
      });
    }
  });
});

describe('Schéma Prisma — migration', () => {
  it('est purement additive', () => {
    // Une migration destructive rejouée sur la recette ou la production
    // détruirait des données sans retour possible. La suppression d'une colonne
    // se fait en deux déploiements (api-module §6), jamais dans la migration qui
    // cesse de la lire.
    expect(sql).not.toMatch(/\b(DROP\s+(TABLE|COLUMN|TYPE|INDEX|CONSTRAINT)|TRUNCATE|DELETE FROM)\b/i);
  });

  it('verrouille le connecteur sur PostgreSQL', () => {
    const lock = readFileSync(join(MIGRATIONS_DIR, 'migration_lock.toml'), 'utf8');
    expect(lock).toContain('provider = "postgresql"');
  });
});

describe('Schéma Prisma — conformité PCI', () => {
  it("ne prévoit aucune colonne susceptible de porter une donnée de carte", () => {
    // La tokenisation se fait côté client vers Stripe : le serveur ne conserve
    // que des références opaques. Une colonne « card_number » ou « cvv » ferait
    // basculer le périmètre PCI de SAQ A à SAQ D.
    const forbidden = /\b(card_number|pan|cvv|cvc|card_holder|expiry|expiration_date|card_expiry)\b/i;
    for (const table of tables) {
      for (const candidate of table.columns) {
        expect({ column: `${table.name}.${candidate.name}`, forbidden: forbidden.test(candidate.name) }).toEqual({
          column: `${table.name}.${candidate.name}`,
          forbidden: false,
        });
      }
    }
  });
});

describe('Schéma Prisma — ce que Prisma ne sait pas exprimer', () => {
  it('double toute référence entre tables métier d’une clé composite avec `tenant_id`', () => {
    // Une clé mono-colonne `service_id → services(id)` est muette sur le tenant :
    // elle laisse rattacher la ligne d'un salon à celle d'un autre — le praticien
    // du salon A affecté à la prestation du salon B, un rendez-vous du salon A
    // pointant le compte client du salon B. Porter `tenant_id` sur la table est
    // nécessaire, il n'est pas suffisant.
    const missing = foreignKeys
      .filter((key) => key.referencedTable !== TENANT_ROOT_TABLE)
      .filter(
        (key) =>
          !compositeForeignKeys.some(
            (composite) =>
              composite.table === key.table &&
              composite.columns.join() === ['tenant_id', key.column].join() &&
              composite.referencedTable === key.referencedTable &&
              composite.referencedColumns.join() === ['tenant_id', 'id'].join(),
          ),
      )
      .map((key) => `${key.table}.${key.column} → ${key.referencedTable}.${key.referencedColumn}`);

    expect(missing).toEqual([]);
  });

  it('adosse chaque clé composite à un unique `(tenant_id, id)` sur la table visée', () => {
    // PostgreSQL refuse une clé étrangère dont la cible n'est couverte par aucun
    // index unique : sans eux, ce n'est pas un test qui rougit, c'est la migration
    // qui ne s'applique pas.
    expect(compositeForeignKeys.length).toBeGreaterThan(0);

    for (const composite of compositeForeignKeys) {
      const reference = `${composite.table} → ${composite.referencedTable}`;
      const covered = indexes.some(
        (index) =>
          index.unique &&
          index.table === composite.referencedTable &&
          index.columns.join() === composite.referencedColumns.join(),
      );

      expect({ reference, covered }).toEqual({ reference, covered: true });
    }
  });

  it('borne chaque montant par une contrainte `CHECK`', () => {
    // Un encaissement négatif ou un remboursement supérieur à ce qui a été
    // encaissé ne fait pas planter : il fausse silencieusement le reporting, donc
    // le « mesurer » de la boucle de valeur.
    const amounts = tables.flatMap((table) =>
      table.columns
        .filter((candidate) => candidate.name.endsWith('amount_minor'))
        .map((candidate) => ({ table, candidate })),
    );

    expect(amounts.length).toBeGreaterThan(0);

    for (const { table, candidate } of amounts) {
      const name = `${table.name}.${candidate.name}`;
      const guarded = checkConstraints.some(
        (check) => check.table === table.name && check.expression.includes(`"${candidate.name}"`),
      );

      expect({ column: name, guarded }).toEqual({ column: name, guarded: true });
    }
  });

  it('interdit un rendez-vous dont la fin ne suit pas le début', () => {
    // La contrainte d'exclusion à venir porte sur `tstzrange(starts_at, ends_at)`.
    // Un intervalle vide (`ends_at = starts_at`, ce que produit une prestation de
    // durée nulle) ne chevauche **rien** : deux réservations passeraient côte à
    // côte sur le même praticien au même instant, sans que rien ne s'y oppose.
    const bounded = checkConstraints.some(
      (check) => check.table === 'appointments' && /"ends_at"\s*>\s*"starts_at"/.test(check.expression),
    );

    expect(bounded).toBe(true);
  });

  it('interdit une prestation de durée nulle ou négative', () => {
    const bounded = checkConstraints.some(
      (check) => check.table === 'services' && /"duration_minutes"\s*>\s*0/.test(check.expression),
    );

    expect(bounded).toBe(true);
  });
});
