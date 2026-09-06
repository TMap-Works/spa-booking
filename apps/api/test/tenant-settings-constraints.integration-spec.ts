import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';
import { Client, DatabaseError } from 'pg';

import {
  createScopedPrismaClient,
  type ScopedPrismaClient,
} from '../src/infrastructure/database/prisma-clients';
import { IdentityRepository } from '../src/modules/identity/identity.repository';
import { createDisposableDatabase, type DisposableDatabase } from './utils/disposable-database';
import { inTenant } from './utils/tenant-scope';

/**
 * Les cinq garanties **en base** du paramétrage d'établissement — contre un
 * vrai PostgreSQL (#417, migration `20260904150000_add_tenant_address_and_opening_hours`).
 *
 * ## Le trou que cette suite ferme
 *
 * La migration de #343 pose cinq bornes, et rien jusqu'ici ne les exerçait :
 *
 * | Contrainte | Ce qu'elle interdit |
 * |---|---|
 * | `tenants_address_completeness_check` | une adresse sans rue, sans ville ou sans pays |
 * | `tenants_country_code_check` | un code pays qui n'est pas deux majuscules |
 * | `tenant_opening_hours_weekday_check` | un jour hors de la numérotation ISO 8601 |
 * | `tenant_opening_hours_minutes_check` | une plage inversée ou hors de la journée civile |
 * | `tenant_opening_hours_no_overlap` | deux plages du même jour qui se recouvrent |
 *
 * `prisma-schema.spec.ts` relit le **texte** de la migration : il prouve que la
 * contrainte est écrite, jamais qu'elle mord. `tenant-settings.isolation-spec.ts`
 * passe par le double en mémoire d'`IdentityRepository`, qui ne connaît aucune
 * contrainte. Entre les deux, une borne mal écrite — un `OR` à la place d'un
 * `AND`, une classe de caractères trop large, une borne haute incluse — passait
 * la relecture sans que rien ne rougisse : le contrôle applicatif du service la
 * double, et c'est lui qui rendait le 400 attendu. Or c'est la base qui est
 * censée être la garantie, et le contrôle applicatif le simple message.
 *
 * ## Pourquoi le SQL brut, et non Prisma, pour constater le refus
 *
 * Chaque borne est éprouvée par une instruction envoyée **directement au
 * moteur**, par un client `pg`. Deux raisons, et aucune n'est de commodité :
 *
 * 1. **passer par le service ne prouverait rien.** Sa validation d'entrée
 *    refuserait la valeur avant la base, et le test verdirait sur le contrôle
 *    applicatif — exactement l'angle mort que ce ticket ferme. Ce que la
 *    migration promet, c'est de tenir face à ce qui arrive *par une autre
 *    porte* : un correctif de données, une restauration, un import ;
 * 2. **l'erreur `pg` nomme la contrainte.** Un refus porte son `SQLSTATE`
 *    (`23514` pour une borne `CHECK`, `23P01` pour une contrainte d'exclusion)
 *    et le **nom** de la contrainte qui a mordu. C'est ce qui distingue « la
 *    base a refusé » de « la base a refusé *pour la raison qu'on croit* » — une
 *    distinction qui compte ici, puisque plusieurs bornes portent sur les mêmes
 *    colonnes et qu'un code pays invalide écrit seul violerait d'abord la
 *    complétude de l'adresse.
 *
 * Le second volet, lui, ne peut pas se passer de Prisma : voir plus bas.
 *
 * ## Le second volet — le `deleteMany({})` de la réécriture d'horaires
 *
 * `updateTenantSettings` remplace la semaine par un `deleteMany({})` **sans
 * `where`** (`identity.repository.ts`, #343 puis #416) : c'est l'extension de
 * scoping, et elle seule, qui y pose `tenant_id`. Une régression y effacerait
 * les horaires de *tous* les établissements de la plateforme, sans erreur et
 * sans trace. L'isolation en était prouvée sur le double en mémoire — c'est-à-dire
 * sur un objet qui n'a jamais rencontré l'extension.
 *
 * Ce bloc branche donc le **vrai** dépôt sur le **vrai** client scopé, tel que
 * `DatabaseModule` le construit, et vérifie sur deux établissements voisins que
 * l'effacement s'arrête à la frontière (tenant-isolation §3 et §6).
 *
 * ## Prérequis
 *
 * Un démon Docker joignable, et rien d'autre (#27, #274). La suite se crée une
 * **base jetable**, migrée puis détruite, dans un PostgreSQL 16 qu'elle démarre
 * elle-même (`utils/disposable-database.ts`). `DATABASE_URL` n'est pas lue :
 * rien de ce que la machine héberge n'entre dans le résultat, version du moteur
 * comprise — ce qui compte doublement pour une suite qui juge des contraintes,
 * dont la syntaxe et le comportement sont ceux d'une version précise.
 *
 * L'absence de démon fait échouer la suite, délibérément : une garantie qui se
 * désactiverait toute seule quand le moteur manque annoncerait ce que rien n'a
 * vérifié.
 *
 * ## Une seule base pour tout le fichier
 *
 * Les blocs partagent la base et les deux établissements : ils ne se marchent
 * pas dessus, chaque cas rangeant ce qu'il a semé. Le coût d'un conteneur se
 * paie par **fichier** (`apps/api/README.md`), et en ouvrir un second pour
 * séparer les bornes de l'isolation reviendrait à payer deux fois le même
 * moteur pour observer les deux moitiés du même ticket.
 */

/** `check_violation` — une borne `CHECK` a refusé la ligne. */
const CHECK_VIOLATION = '23514';

/** `exclusion_violation` — une contrainte `EXCLUDE` a refusé la ligne. */
const EXCLUSION_VIOLATION = '23P01';

/**
 * `string_data_right_truncation` — le **type** a refusé la valeur, avant toute
 * borne. C'est ce qui distingue la longueur, tenue par `CHAR(2)`, de l'alphabet,
 * tenu par `tenants_country_code_check`.
 */
const STRING_TOO_LONG = '22001';

/** Les cinq colonnes d'adresse, dans l'ordre où les instructions les posent. */
interface AddressColumns {
  line1: string | null;
  line2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
}

/** Une adresse vide — le point de départ de chaque cas, et l'état d'origine. */
const NO_ADDRESS: AddressColumns = {
  line1: null,
  line2: null,
  postalCode: null,
  city: null,
  country: null,
};

/**
 * Écrit les cinq colonnes d'un coup.
 *
 * En une seule instruction, et non cinq : une adresse est publiée en entier ou
 * pas du tout, et la contrainte est vérifiée à la fin de chaque instruction. La
 * poser en plusieurs fois refuserait des états intermédiaires parfaitement
 * légitimes, et le test mesurerait alors sa propre maladresse.
 */
const WRITE_ADDRESS = `
  UPDATE tenants
     SET address_line1 = $2,
         address_line2 = $3,
         postal_code   = $4,
         city          = $5,
         country_code  = $6
   WHERE id = $1
`;

/**
 * Insère une plage d'ouverture sans passer par Prisma.
 *
 * `updated_at` est fourni : la colonne est `NOT NULL` et son remplissage est le
 * fait du client Prisma (`@updatedAt`), pas d'un défaut de la base — un `INSERT`
 * brut doit donc l'écrire lui-même.
 */
const WRITE_OPENING_HOUR = `
  INSERT INTO tenant_opening_hours (id, tenant_id, weekday, start_minute, end_minute, updated_at)
  VALUES ($1, $2, $3, $4, $5, now())
`;

/** Le tenant, tel que cette suite le crée — le strict nécessaire du schéma. */
function tenantSeed(label: string): Prisma.TenantCreateInput {
  return {
    slug: `i417-${label}-${randomUUID()}`,
    name: `Établissement ${label}`,
    timezone: 'Europe/Paris',
    defaultCurrency: 'EUR',
  };
}

describe('Contraintes du paramétrage d’établissement — contre un vrai PostgreSQL', () => {
  /** La base créée pour ce fichier, et détruite avec lui. */
  let database: DisposableDatabase | undefined;
  /**
   * La connexion `pg` par laquelle les bornes sont éprouvées.
   *
   * Elle ne remplace pas Prisma : elle est le seul moyen de soumettre au moteur
   * ce que ni le DTO ni le repository n'accepteraient de former.
   */
  let sql: Client | undefined;
  /**
   * La racine non scopée : elle sème les établissements — qui n'ont par
   * définition aucun tenant courant — et **observe** la base sans le filtre que
   * le dernier bloc met justement à l'épreuve.
   */
  let prismaUnscoped: PrismaClient;
  /** Le client scopé, construit par la fabrique de l'application. */
  let scoped: ScopedPrismaClient;
  /** Le **vrai** dépôt, branché sur le **vrai** client scopé. */
  let repository: IdentityRepository;

  let salon: string;
  let voisin: string;

  /**
   * Envoie l'instruction au moteur et rend le refus qu'il oppose.
   *
   * Un succès est une **erreur de la suite**, pas un cas de passage : il veut
   * dire que la contrainte annoncée par la migration ne mord pas. Le message le
   * dit dans ces termes, parce que c'est le constat qu'il faudra porter.
   */
  async function refusal(statement: string, params: readonly unknown[]): Promise<DatabaseError> {
    if (sql === undefined) {
      throw new Error('la connexion `pg` de la suite n’est pas ouverte');
    }
    try {
      await sql.query(statement, [...params]);
    } catch (error: unknown) {
      if (error instanceof DatabaseError) {
        return error;
      }
      throw error;
    }
    throw new Error(
      `PostgreSQL a accepté ce que la migration prétend interdire : ${statement.trim()} ` +
        `avec ${JSON.stringify(params)}`,
    );
  }

  /** Envoie l'instruction et exige qu'elle passe — le contrôle négatif. */
  async function accepted(statement: string, params: readonly unknown[]): Promise<void> {
    if (sql === undefined) {
      throw new Error('la connexion `pg` de la suite n’est pas ouverte');
    }
    await sql.query(statement, [...params]);
  }

  /**
   * Exige que le chemin de production — le dépôt, sur le client scopé — soit
   * arrêté par **la** contrainte nommée.
   *
   * Prisma ne mappe les violations de `CHECK` et d'`EXCLUDE` sur aucun code
   * `P####` : il recopie l'erreur du connecteur, `SQLSTATE` et nom de la
   * contrainte compris. C'est ce nom qu'on lit, et non le seul fait que la
   * promesse ait rejeté — sans lui, une base injoignable, un `tenantId` absent
   * du contexte ou une contrainte tout autre se liraient toutes comme la
   * garantie attendue.
   */
  async function refusedByConstraint(
    run: () => Promise<unknown>,
    constraint: string,
  ): Promise<void> {
    const caught = await run().then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain(constraint);
  }

  /** L'adresse d'un établissement, telle qu'elle est en base. */
  async function readAddress(tenantId: string): Promise<AddressColumns> {
    const row = await prismaUnscoped.tenant.findUniqueOrThrow({
      where: { id: tenantId },
      select: {
        addressLine1: true,
        addressLine2: true,
        postalCode: true,
        city: true,
        countryCode: true,
      },
    });
    return {
      line1: row.addressLine1,
      line2: row.addressLine2,
      postalCode: row.postalCode,
      city: row.city,
      country: row.countryCode,
    };
  }

  /** Les paramètres de `WRITE_ADDRESS`, dans l'ordre. */
  function addressParams(tenantId: string, address: AddressColumns): readonly unknown[] {
    return [
      tenantId,
      address.line1,
      address.line2,
      address.postalCode,
      address.city,
      address.country,
    ];
  }

  /** Les paramètres de `WRITE_OPENING_HOUR`, dans l'ordre. */
  function openingHourParams(
    tenantId: string,
    weekday: number,
    startMinute: number,
    endMinute: number,
  ): readonly unknown[] {
    return [randomUUID(), tenantId, weekday, startMinute, endMinute];
  }

  /** Les plages d'un établissement, lues **sans** le filtre du scoping. */
  async function readOpeningHours(
    tenantId: string,
  ): Promise<Array<{ weekday: number; startMinute: number; endMinute: number }>> {
    return prismaUnscoped.tenantOpeningHour.findMany({
      where: { tenantId },
      select: { weekday: true, startMinute: true, endMinute: true },
      orderBy: [{ weekday: 'asc' }, { startMinute: 'asc' }],
    });
  }

  beforeAll(async () => {
    database = await createDisposableDatabase();

    prismaUnscoped = new PrismaClient({ datasourceUrl: database.url, errorFormat: 'minimal' });
    try {
      await prismaUnscoped.$connect();
      // Une requête réelle, et pas seulement `$connect` : c'est elle qui prouve
      // que le schéma est en place. Une base joignable mais vide produirait
      // sinon une erreur bien plus loin, où elle se lirait comme une contrainte
      // absente — c'est-à-dire comme le constat que cette suite doit porter.
      await prismaUnscoped.tenant.count();

      sql = new Client({ connectionString: database.url });
      await sql.connect();

      scoped = createScopedPrismaClient(prismaUnscoped);
      // Le dépôt est câblé à la main, comme le ferait Nest : le client scopé sur
      // `PRISMA`, la racine sur `PRISMA_UNSCOPED`. C'est bien la classe de
      // production qui est sous test, pas une réécriture.
      repository = new IdentityRepository(scoped, prismaUnscoped);

      salon = (await prismaUnscoped.tenant.create({ data: tenantSeed('salon') })).id;
      voisin = (await prismaUnscoped.tenant.create({ data: tenantSeed('voisin') })).id;
    } catch (error: unknown) {
      // Un amorçage raté ne doit pas laisser un PostgreSQL debout sur la machine
      // d'un agent : le ménage est sous filet, l'erreur d'origine remonte.
      await sql?.end().catch(() => undefined);
      await prismaUnscoped.$disconnect().catch(() => undefined);
      await database.drop();
      throw error;
    }
  });

  afterAll(async () => {
    // La déconnexion d'abord : `DROP DATABASE … WITH (FORCE)` saurait couper les
    // sessions, mais fermer proprement évite de journaliser une rupture de
    // connexion qui se lirait comme un incident.
    await sql?.end().catch(() => undefined);
    if (prismaUnscoped !== undefined) {
      await prismaUnscoped.$disconnect();
    }
    await database?.drop();
  });

  afterEach(async () => {
    // Le ménage vise les deux établissements de la suite, et rien d'autre : la
    // base est à ce fichier seul, mais les blocs se succèdent dedans.
    await prismaUnscoped.tenantOpeningHour.deleteMany({
      where: { tenantId: { in: [salon, voisin] } },
    });
    await prismaUnscoped.tenant.updateMany({
      where: { id: { in: [salon, voisin] } },
      data: {
        addressLine1: null,
        addressLine2: null,
        postalCode: null,
        city: null,
        countryCode: null,
      },
    });
  });

  describe('`tenants_address_completeness_check` — une adresse entière, ou aucune', () => {
    /**
     * Les six façons d'écrire un triplet incomplet. Elles sont énumérées plutôt
     * qu'échantillonnées : la contrainte est une disjonction de deux termes, et
     * seule l'énumération distingue « les trois ensemble » d'un `OR` mal placé
     * qui laisserait passer deux colonnes sur trois.
     */
    const incomplete: ReadonlyArray<[string, Partial<AddressColumns>]> = [
      ['la rue seule', { line1: '12 rue des Lilas' }],
      ['la ville seule', { city: 'Paris' }],
      ['le pays seul', { country: 'FR' }],
      ['la rue et la ville, sans le pays', { line1: '12 rue des Lilas', city: 'Paris' }],
      ['la rue et le pays, sans la ville', { line1: '12 rue des Lilas', country: 'FR' }],
      ['la ville et le pays, sans la rue', { city: 'Paris', country: 'FR' }],
    ];

    it.each(incomplete)('refuse %s', async (_label, partial) => {
      const error = await refusal(
        WRITE_ADDRESS,
        addressParams(salon, { ...NO_ADDRESS, ...partial }),
      );

      expect(error.code).toBe(CHECK_VIOLATION);
      expect(error.constraint).toBe('tenants_address_completeness_check');

      // Le refus n'a pas seulement rendu une erreur : la ligne est restée
      // telle qu'elle était. Sur un `UPDATE`, la distinction n'est pas
      // rhétorique — une borne évaluée après coup, par un déclencheur, aurait
      // laissé derrière elle une adresse à moitié écrite.
      //
      // Ce que ce cas ne prouve **pas** : qu'aucune ligne déjà en base ne viole
      // la borne. Une contrainte posée `NOT VALID` s'applique à tout `INSERT`
      // et à tout `UPDATE` — donc à ce cas, qui rougirait exactement pareil —
      // et laisse pourtant intactes les lignes préexistantes invalides. Seule
      // l'absence de `NOT VALID` dans la migration en répond, et c'est
      // `prisma-schema.spec.ts`, qui en relit le texte, qui la constate.
      expect(await readAddress(salon)).toEqual(NO_ADDRESS);
    });

    it('accepte le triplet complet', async () => {
      await accepted(
        WRITE_ADDRESS,
        addressParams(salon, {
          line1: '12 rue des Lilas',
          line2: null,
          postalCode: null,
          city: 'Paris',
          country: 'FR',
        }),
      );

      expect(await readAddress(salon)).toEqual({
        line1: '12 rue des Lilas',
        line2: null,
        postalCode: null,
        city: 'Paris',
        country: 'FR',
      });
    });

    it('accepte l’absence totale d’adresse — l’état de tout établissement d’avant #343', async () => {
      await accepted(WRITE_ADDRESS, addressParams(salon, NO_ADDRESS));

      expect(await readAddress(salon)).toEqual(NO_ADDRESS);
    });

    it('ignore le complément d’adresse et le code postal — ils ne sont pas du triplet', async () => {
      // Ces deux-là sont **délibérément** hors de la contrainte : le premier est
      // un complément, le second n'existe pas dans tous les pays. Les exiger
      // refuserait l'adresse réelle d'un salon. Le cas fige les deux moitiés de
      // cette exclusion, pour qu'un resserrement de la borne ne passe pas
      // inaperçu : ni ils ne sont requis avec le triplet, ni leur présence seule
      // ne suffit à réclamer le triplet.
      await accepted(
        WRITE_ADDRESS,
        addressParams(salon, {
          line1: '12 rue des Lilas',
          line2: null,
          postalCode: null,
          city: 'Paris',
          country: 'FR',
        }),
      );

      await accepted(
        WRITE_ADDRESS,
        addressParams(salon, { ...NO_ADDRESS, line2: 'Bâtiment B', postalCode: '75011' }),
      );

      expect(await readAddress(salon)).toEqual({
        ...NO_ADDRESS,
        line2: 'Bâtiment B',
        postalCode: '75011',
      });
    });
  });

  describe('`tenants_country_code_check` — deux majuscules, et rien d’autre', () => {
    /**
     * Chaque cas écrit le triplet **complet** : sans rue ni ville, c'est la
     * complétude qui refuserait d'abord, et le test verdirait sur la mauvaise
     * contrainte. C'est précisément ce que l'assertion sur le nom de la
     * contrainte rend visible.
     */
    function withCountry(country: string): readonly unknown[] {
      return addressParams(salon, {
        line1: '12 rue des Lilas',
        line2: null,
        postalCode: '75011',
        city: 'Paris',
        country,
      });
    }

    const rejected: ReadonlyArray<[string, string]> = [
      ['minuscules', 'fr'],
      ['casse mêlée', 'Fr'],
      ['casse mêlée, l’autre sens', 'fR'],
      ['chiffres', '12'],
      ['lettre et chiffre', 'F1'],
      // `CHAR(2)` complète à droite — `'F'` occupe bien deux octets en base —,
      // mais la conversion vers `text` qu'impose l'opérateur `~` retire les
      // blancs de fin : la borne compare donc `'F'`, refusé parce qu'il n'a
      // qu'une lettre, et non parce qu'il traînerait une espace. La nuance
      // compte pour qui voudrait « laisser passer le remplissage » en
      // élargissant la classe de caractères : `^[A-Z ]{2}$` accepterait `'A '`,
      // c'est-à-dire rouvrirait le trou que ce cas ferme. Sans la borne, un
      // pays à une lettre passerait.
      ['une seule lettre', 'F'],
    ];

    it.each(rejected)('refuse un code pays en %s', async (_label, country) => {
      const error = await refusal(WRITE_ADDRESS, withCountry(country));

      expect(error.code).toBe(CHECK_VIOLATION);
      expect(error.constraint).toBe('tenants_country_code_check');
      expect(await readAddress(salon)).toEqual(NO_ADDRESS);
    });

    it('accepte deux majuscules', async () => {
      await accepted(WRITE_ADDRESS, withCountry('BE'));

      expect((await readAddress(salon)).country).toBe('BE');
    });

    it('laisse le type refuser ce qui est trop long — la borne ne porte que l’alphabet', async () => {
      // Le partage annoncé par la migration : « le `CHAR(2)` borne la longueur,
      // pas l'alphabet ». Le refus vient donc du type, pas de la contrainte, et
      // le `SQLSTATE` le dit — sans ce cas, on croirait la borne responsable
      // d'une garantie qu'elle ne porte pas.
      const error = await refusal(WRITE_ADDRESS, withCountry('FRA'));

      expect(error.code).toBe(STRING_TOO_LONG);
      expect(error.constraint).toBeUndefined();
    });
  });

  describe('`tenant_opening_hours_weekday_check` — un jour de la semaine ISO 8601', () => {
    /**
     * Les trois façons de sortir de `BETWEEN 1 AND 7`. Le `0` est le cas que la
     * migration nomme explicitement, et il n'est pas théorique : c'est ce que
     * rend `Date.getDay` pour un dimanche. Il est *falsy*, si bien qu'un
     * `weekday ?? défaut` ou un `weekday || défaut` écrit en amont le
     * remplacerait sans bruit — le dimanche se rangerait alors un autre jour.
     * La borne est ce qui fait rougir cette écriture-là au lieu de l'accepter.
     */
    const rejected: ReadonlyArray<[string, number]> = [
      ['le `0` de `Date.getDay` — le dimanche *falsy*', 0],
      ['un jour négatif', -1],
      ['un huitième jour', 8],
    ];

    it.each(rejected)('refuse %s', async (_label, weekday) => {
      const error = await refusal(WRITE_OPENING_HOUR, openingHourParams(salon, weekday, 540, 720));

      expect(error.code).toBe(CHECK_VIOLATION);
      expect(error.constraint).toBe('tenant_opening_hours_weekday_check');
      expect(await readOpeningHours(salon)).toEqual([]);
    });

    /**
     * Les deux extrémités de l'intervalle, et elles seules : une borne écrite
     * `BETWEEN 0 AND 6` — le décalage exact contre lequel la migration met en
     * garde — refuserait le dimanche tout en acceptant le `0`. Les cas négatifs
     * seuls ne la distingueraient pas d'une borne correcte.
     */
    const allowed: ReadonlyArray<[string, number]> = [
      ['le lundi, premier jour ISO', 1],
      ['le dimanche, septième jour ISO', 7],
    ];

    it.each(allowed)('accepte %s', async (_label, weekday) => {
      await accepted(WRITE_OPENING_HOUR, openingHourParams(salon, weekday, 540, 720));

      expect(await readOpeningHours(salon)).toEqual([
        { weekday, startMinute: 540, endMinute: 720 },
      ]);
    });
  });

  describe('`tenant_opening_hours_minutes_check` — une plage dans sa journée', () => {
    const rejected: ReadonlyArray<[string, number, number]> = [
      ['inversée', 600, 540],
      ['vide — une ligne saisie qui n’affiche rien', 540, 540],
      ['commençant avant minuit', -1, 600],
      ['finissant après la journée civile', 600, 1441],
      ['entièrement hors de la journée civile', 1500, 1600],
    ];

    it.each(rejected)('refuse une plage %s', async (_label, startMinute, endMinute) => {
      const error = await refusal(
        WRITE_OPENING_HOUR,
        openingHourParams(salon, 2, startMinute, endMinute),
      );

      expect(error.code).toBe(CHECK_VIOLATION);
      expect(error.constraint).toBe('tenant_opening_hours_minutes_check');
      expect(await readOpeningHours(salon)).toEqual([]);
    });

    it('accepte la journée entière — `1440` dit « ferme à minuit »', async () => {
      await accepted(WRITE_OPENING_HOUR, openingHourParams(salon, 2, 0, 1440));

      expect(await readOpeningHours(salon)).toEqual([
        { weekday: 2, startMinute: 0, endMinute: 1440 },
      ]);
    });
  });

  describe('`tenant_opening_hours_no_overlap` — deux plages d’un jour ne se recouvrent pas', () => {
    /** La plage de référence : le matin du mardi, 09:00–12:00. */
    const MORNING: readonly [number, number, number] = [2, 540, 720];

    beforeEach(async () => {
      await accepted(WRITE_OPENING_HOUR, openingHourParams(salon, ...MORNING));
    });

    const overlapping: ReadonlyArray<[string, number, number]> = [
      ['qui chevauche par la fin', 660, 1140],
      ['identique', 540, 720],
      ['strictement contenue', 600, 660],
      ['qui englobe', 480, 1140],
      ['qui chevauche par le début', 480, 600],
    ];

    it.each(overlapping)('refuse une seconde plage %s', async (_label, startMinute, endMinute) => {
      const error = await refusal(
        WRITE_OPENING_HOUR,
        openingHourParams(salon, 2, startMinute, endMinute),
      );

      expect(error.code).toBe(EXCLUSION_VIOLATION);
      expect(error.constraint).toBe('tenant_opening_hours_no_overlap');

      // La plage d'origine est intacte : un refus qui aurait emporté la ligne
      // en place serait pire que pas de contrainte du tout.
      expect(await readOpeningHours(salon)).toEqual([
        { weekday: 2, startMinute: 540, endMinute: 720 },
      ]);
    });

    it('accepte la coupure méridienne — deux plages adjacentes, borne haute exclue', async () => {
      // C'est le cas d'usage qui a motivé la table : un salon qui ferme entre
      // midi et deux. Une contrainte écrite sur un intervalle fermé le
      // refuserait, et la vitrine ne saurait plus dire l'après-midi.
      await accepted(WRITE_OPENING_HOUR, openingHourParams(salon, 2, 720, 1140));

      expect(await readOpeningHours(salon)).toEqual([
        { weekday: 2, startMinute: 540, endMinute: 720 },
        { weekday: 2, startMinute: 720, endMinute: 1140 },
      ]);
    });

    it('accepte la même plage un autre jour', async () => {
      // `weekday WITH =` fait partie de la clé d'exclusion : sans lui, publier
      // le mardi matin fermerait tous les autres matins de la semaine.
      await accepted(WRITE_OPENING_HOUR, openingHourParams(salon, 3, 540, 720));

      expect(await readOpeningHours(salon)).toEqual([
        { weekday: 2, startMinute: 540, endMinute: 720 },
        { weekday: 3, startMinute: 540, endMinute: 720 },
      ]);
    });

    it('accepte la même plage, le même jour, chez l’établissement voisin', async () => {
      // La frontière du tenant est **dans l'index**, pas seulement dans les
      // intentions : `tenant_id WITH =` fait partie de la clé d'exclusion. Sans
      // lui, le premier salon à publier ses horaires du mardi les interdirait à
      // tous les autres — une fuite qui se manifesterait en refus, pas en
      // lecture, et que rien n'aurait rattachée au multi-tenant.
      await accepted(WRITE_OPENING_HOUR, openingHourParams(voisin, ...MORNING));

      expect(await readOpeningHours(salon)).toHaveLength(1);
      expect(await readOpeningHours(voisin)).toHaveLength(1);
    });
  });

  describe('la réécriture de la semaine, à travers le vrai client scopé', () => {
    /** Sème une semaine à un établissement, sans passer par le scoping. */
    async function seedWeek(
      tenantId: string,
      ranges: ReadonlyArray<[number, number, number]>,
    ): Promise<void> {
      // Le client non scopé est le bon outil pour semer : ces lignes précèdent
      // toute requête HTTP, donc tout contexte de tenant. Le `tenantId` est
      // écrit explicitement — ce que tenant-isolation §3 exige d'un accès non
      // scopé.
      await prismaUnscoped.tenantOpeningHour.createMany({
        data: ranges.map(([weekday, startMinute, endMinute]) => ({
          tenantId,
          weekday,
          startMinute,
          endMinute,
        })),
      });
    }

    /** La semaine du voisin, semée à l'identique dans chaque cas. */
    const VOISIN_WEEK: ReadonlyArray<[number, number, number]> = [
      [1, 600, 1140],
      [4, 540, 720],
    ];

    beforeEach(async () => {
      await seedWeek(voisin, VOISIN_WEEK);
    });

    /** Ce que le voisin doit retrouver, quoi qu'il arrive chez son voisin. */
    async function expectVoisinIntact(): Promise<void> {
      expect(await readOpeningHours(voisin)).toEqual([
        { weekday: 1, startMinute: 600, endMinute: 1140 },
        { weekday: 4, startMinute: 540, endMinute: 720 },
      ]);
    }

    it('`deleteMany({})` sur le client scopé s’arrête à la frontière du tenant', async () => {
      // Le geste nu, celui qu'`updateTenantSettings` exécute : aucun `where`,
      // donc aucune borne écrite par l'appelant. Ce que l'extension y pose est
      // la seule chose qui empêche d'effacer les horaires de la plateforme
      // entière.
      await seedWeek(salon, [
        [2, 540, 720],
        [2, 840, 1140],
        [6, 600, 1440],
      ]);

      const deleted = await inTenant(salon, () => scoped.tenantOpeningHour.deleteMany({}));

      expect(deleted.count).toBe(3);
      expect(await readOpeningHours(salon)).toEqual([]);
      await expectVoisinIntact();
    });

    it('`updateTenantSettings` remplace la semaine de son établissement, et de lui seul', async () => {
      await seedWeek(salon, [[2, 540, 720]]);

      const written = await inTenant(salon, () =>
        repository.updateTenantSettings({
          changes: {},
          openingHours: [
            { weekday: 3, startMinute: 600, endMinute: 780 },
            { weekday: 3, startMinute: 840, endMinute: 1140 },
          ],
        }),
      );

      expect(written).toBe(true);
      expect(await readOpeningHours(salon)).toEqual([
        { weekday: 3, startMinute: 600, endMinute: 780 },
        { weekday: 3, startMinute: 840, endMinute: 1140 },
      ]);
      await expectVoisinIntact();
    });

    it('une semaine vide efface la sienne, jamais celle du voisin', async () => {
      // Le cas le plus dangereux du lot : un tableau vide est la seule façon
      // d'effacer la semaine, et c'est donc le seul appel dont l'effet nominal
      // est une suppression sans rien créer derrière.
      await seedWeek(salon, [
        [2, 540, 720],
        [5, 600, 1140],
      ]);

      expect(
        await inTenant(salon, () =>
          repository.updateTenantSettings({ changes: {}, openingHours: [] }),
        ),
      ).toBe(true);

      expect(await readOpeningHours(salon)).toEqual([]);
      await expectVoisinIntact();
    });

    it('les plages créées portent le tenant de la portée, que le dépôt ne fournit nulle part', async () => {
      // Le pendant en écriture : l'extension **pose** `tenant_id` sur la
      // création, et le repository ne le fournit nulle part. S'il venait à
      // manquer, l'insertion échouerait sur la colonne `NOT NULL` — bruyamment,
      // jamais en silence.
      //
      // Ce cas ne prouve pas l'**écrasement** d'un `tenantId` soumis :
      // `OpeningHourRecord` ne porte que le jour et les minutes, si bien
      // qu'aucun appelant ne peut en soumettre un par cette porte. C'est
      // `withTenant`, dans `tenant-scope.extension.ts`, qui tient l'écrasement,
      // et sa propre suite qui l'exerce.
      await inTenant(salon, () =>
        repository.updateTenantSettings({
          changes: {},
          openingHours: [{ weekday: 7, startMinute: 600, endMinute: 900 }],
        }),
      );

      const rows = await prismaUnscoped.tenantOpeningHour.findMany({
        where: { weekday: 7 },
        select: { tenantId: true },
      });
      expect(rows).toEqual([{ tenantId: salon }]);
    });

    it('la contrainte d’exclusion mord aussi sur ce chemin, et la transaction rend la semaine intacte', async () => {
      // Les deux moitiés du ticket se rejoignent ici : la borne posée en base
      // arrête une demande que le repository laisse passer, et le `ROLLBACK` de
      // la transaction de #416 fait qu'un refus n'emporte pas la semaine
      // précédente — ce qu'un `deleteMany` hors transaction aurait fait.
      await seedWeek(salon, [[2, 540, 720]]);

      await refusedByConstraint(
        () =>
          inTenant(salon, () =>
            repository.updateTenantSettings({
              changes: {},
              openingHours: [
                { weekday: 3, startMinute: 540, endMinute: 720 },
                { weekday: 3, startMinute: 660, endMinute: 1140 },
              ],
            }),
          ),
        'tenant_opening_hours_no_overlap',
      );

      expect(await readOpeningHours(salon)).toEqual([
        { weekday: 2, startMinute: 540, endMinute: 720 },
      ]);
      await expectVoisinIntact();
    });

    it('l’adresse incomplète est refusée par la base sur ce même chemin', async () => {
      // Le repository écrit ce qu'on lui donne : la validation qui refuserait
      // cette adresse vit dans le DTO, en amont. La base est ce qui reste quand
      // la valeur arrive par une autre porte — et c'est ce que ce cas exerce.
      await refusedByConstraint(
        () =>
          inTenant(salon, () =>
            repository.updateTenantSettings({
              changes: { addressLine1: '12 rue des Lilas', city: null, countryCode: null },
            }),
          ),
        'tenants_address_completeness_check',
      );

      expect(await readAddress(salon)).toEqual(NO_ADDRESS);
      expect(await readAddress(voisin)).toEqual(NO_ADDRESS);
    });
  });
});
