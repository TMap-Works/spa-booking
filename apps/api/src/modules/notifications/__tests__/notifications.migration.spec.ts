// Le SQL de migration est lu par un module unique, partagé avec
// `prisma-schema.spec.ts` (#217). L'import traverse les dossiers, mais il ne
// franchit aucune frontière de module métier au sens d'api-module §3 :
// `infrastructure/database` est le seul endroit du dépôt qui connaisse le
// schéma, et ce lecteur n'existe que pour les suites de test. Même import que
// `modules/identity/__tests__/roles.spec.ts`, pour la même raison.
import { readMigrationSql } from '../../../infrastructure/database/__tests__/migration-sql';
import { LIVE_NOTIFICATION_STATUSES } from '../notifications.types';

/**
 * L'index unique partiel, relu dans le SQL qui s'exécutera vraiment — #68.
 *
 * ## Pourquoi cette suite existe, alors que `prisma-schema.spec.ts` relit déjà
 * toutes les migrations
 *
 * Parce que son lecteur d'index ne reconnaît que les index **totaux** : son
 * motif exige un `;` juste après la parenthèse des colonnes, et un index partiel
 * porte un `WHERE` entre les deux. `notifications_live_once` lui est donc
 * invisible — ni vu ni compté, sans que rien ne rougisse.
 *
 * C'est exactement la situation où une garantie qu'on croit posée ne l'est pas.
 * L'index est le cœur du ticket : sans preuve qu'il figure dans le SQL, avec ces
 * colonnes-là et ce filtre-là, tout ce que le module construit dessus repose sur
 * une intention.
 *
 * ## Ce que cette suite ne prouve pas
 *
 * Qu'il s'applique. C'est la CI qui joue les migrations contre un vrai
 * PostgreSQL, et un `WHERE` mal formé y échouerait au `prisma migrate deploy`.
 * Ce qui se vérifie ici est ce qu'un fichier peut dire de lui-même : la présence,
 * les colonnes, leur ordre, et les statuts filtrés.
 */

const sql = readMigrationSql();

/**
 * L'instruction complète, du `CREATE UNIQUE INDEX` au point-virgule.
 *
 * Extraite plutôt que testée par sous-chaînes : un `WHERE` présent quelque part
 * dans le fichier ne prouve pas qu'il porte sur **cet** index.
 */
const statement = /CREATE UNIQUE INDEX "notifications_live_once"[\s\S]*?;/.exec(sql)?.[0] ?? '';

describe('notifications — l’index unique partiel', () => {
  it('est créé par une migration, en unique', () => {
    expect(statement).not.toBe('');
  });

  it('porte sur la table `notifications`', () => {
    expect(statement).toMatch(/ON\s+"notifications"/);
  });

  it('porte les quatre colonnes du critère d’acceptation, `tenant_id` en tête', () => {
    // L'ordre n'est pas cosmétique : un index qui ne commence pas par
    // `tenant_id` fait payer un parcours inter-tenant à toute lecture bornée à
    // un établissement (tenant-isolation §1).
    const columns = [...statement.matchAll(/"([a-z_]+)"/g)]
      .map((match) => match[1])
      .filter((name) => name !== 'notifications' && name !== 'notifications_live_once');

    expect(columns.slice(0, 4)).toEqual(['tenant_id', 'appointment_id', 'type', 'channel']);
  });

  it('ne vaut que pour les statuts vivants — `FAILED` libère la place', () => {
    // Le cœur du dispositif. Sans ce filtre, le premier échec transitoire
    // condamnerait le rappel : SQS rejouerait dans le vide jusqu'à la DLQ.
    expect(statement).toMatch(/WHERE\s+"status"\s+IN\s*\(\s*'PENDING'\s*,\s*'SENT'\s*\)/);
    expect(statement).not.toContain("'FAILED'");
  });

  it('filtre exactement les statuts que le domaine tient pour vivants', () => {
    // Les deux définitions doivent coïncider, sans quoi le dépôt chercherait la
    // ligne vivante autrement que la base ne la refuse.
    const filtered = [...statement.matchAll(/'([A-Z_]+)'/g)].map((match) => match[1]);

    expect(filtered).toEqual([...LIVE_NOTIFICATION_STATUSES]);
  });
});

describe('notifications — la colonne `provider_message_id`', () => {
  it('est ajoutée par une migration, et nullable', () => {
    // Nullable par nécessité : une ligne `PENDING` n'a pas encore d'accusé, une
    // ligne `FAILED` n'en aura jamais.
    const added = /ALTER TABLE "notifications" ADD COLUMN "provider_message_id"([^;]*);/.exec(sql);

    expect(added).not.toBeNull();
    expect(added?.[1]).toContain('VARCHAR(255)');
    expect(added?.[1]).not.toMatch(/\bNOT NULL\b/);
  });
});

describe('notifications — ce que la migration ne défait pas', () => {
  it('conserve l’unique total sur la clé de livraison', () => {
    // Les deux uniques ne disent pas la même chose, et aucun ne remplace
    // l'autre : celui-ci identifie la livraison, l'autre la donnée. Le retirer
    // rendrait par ailleurs la migration destructive.
    expect(sql).toContain('"notifications_tenant_id_dedupe_key_key"');
  });
});

/**
 * La table des modèles par établissement — #69.
 *
 * `prisma-schema.spec.ts` relit déjà, pour **toutes** les tables, le `tenant_id`
 * non nullable, sa clé étrangère et le préfixe des index. Ce qui se vérifie ici
 * est ce qu'il ne sait pas dire : que les corps sont bien des `TEXT` non
 * nullables — l'invariant « une version texte brut, toujours » repose dessus — et
 * que l'unique porte les trois colonnes qui identifient un message, dans cet
 * ordre.
 */
describe('modèles de messages — la table', () => {
  const table = /CREATE TABLE "notification_templates" \([\s\S]*?\n\);/.exec(sql)?.[0] ?? '';

  it('est créée par une migration', () => {
    expect(table).not.toBe('');
  });

  it('rend les trois corps non nullables — dont la version texte brut', () => {
    // Le quatrième critère d'acceptation tient à cette colonne : un modèle sans
    // texte produirait un e-mail que les filtres anti-spam pénalisent.
    for (const column of ['subject', 'body_html', 'body_text']) {
      expect(new RegExp(`"${column}" [A-Z(0-9)]+ NOT NULL`).test(table)).toBe(true);
    }
  });

  it('borne l’objet et laisse les corps libres', () => {
    // La borne d'un corps HTML aurait fini par refuser un modèle légitime :
    // PostgreSQL stocke `TEXT` et `VARCHAR(n)` de la même façon.
    expect(table).toContain('"subject" VARCHAR(200)');
    expect(table).toContain('"body_html" TEXT');
    expect(table).toContain('"body_text" TEXT');
  });

  it('n’ouvre aucune colonne où une donnée personnelle pourrait se glisser', () => {
    // Un modèle porte `{{client}}`, jamais un nom de cliente (CDC §5.1,
    // notifications §7). C'est ce qui permet de lire cette table au back-office
    // sans réserve.
    for (const forbidden of ['email', 'phone', 'recipient', 'first_name', 'last_name']) {
      expect({ colonne: forbidden, présente: table.includes(`"${forbidden}"`) }).toEqual({
        colonne: forbidden,
        présente: false,
      });
    }
  });

  it('identifie un modèle par `(tenant_id, type, channel)`, dans cet ordre', () => {
    const statement =
      /CREATE UNIQUE INDEX "notification_templates_tenant_id_type_channel_key"[\s\S]*?;/.exec(
        sql,
      )?.[0] ?? '';

    expect(statement).toMatch(/ON\s+"notification_templates"/);

    const columns = [...statement.matchAll(/"([a-z_]+)"/g)]
      .map((match) => match[1])
      .filter((name) => name !== 'notification_templates')
      .filter((name) => name !== 'notification_templates_tenant_id_type_channel_key');

    // `tenant_id` en tête : un index qui ne commence pas par lui fait payer un
    // parcours inter-établissement à une lecture toujours bornée à un salon.
    expect(columns).toEqual(['tenant_id', 'type', 'channel']);
  });
});
