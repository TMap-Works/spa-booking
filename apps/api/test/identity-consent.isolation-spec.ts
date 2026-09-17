import { randomUUID } from 'node:crypto';

import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';

import { createScopedPrismaClient } from '../src/infrastructure/database/prisma-clients';
import { createDisposableDatabase, type DisposableDatabase } from './utils/disposable-database';
import { inTenant } from './utils/tenant-scope';
import { createTenantHarness, type TenantHarness } from './utils/tenant-harness';

/**
 * Fuite inter-tenant sur la **preuve de consentement d'un compte** —
 * tenant-isolation §6, appliqué à la donnée que #880 vient d'écrire.
 *
 * ## Ce qui est prouvé, et pourquoi en deux temps
 *
 * `users.data_consent_at` n'est servie par **aucune route**. Ce n'est pas un
 * oubli : la seule surface qui lit une fiche cliente est le fichier client du
 * module `crm` (`CUSTOMER_SELECT`), hors de l'empreinte de ce ticket, et
 * élargir en attendant une projection d'`identity` aurait fait sortir une donnée
 * de registre par la porte de l'authentification. La colonne s'écrit donc
 * maintenant, elle se lira quand le fichier client la montrera.
 *
 * Une donnée qu'aucune route ne rend se prouve à deux endroits, et ce sont les
 * deux `describe` de cette suite :
 *
 * | Où | Ce qui s'y prouve |
 * |---|---|
 * | **la colonne**, contre un vrai PostgreSQL | elle existe, elle porte un instant UTC, et un tenant étranger n'en lit rien |
 * | **les routes**, contre l'application câblée | l'accord est exigé, il est daté par le serveur, et il ne ressort par aucune sortie |
 *
 * Séparer les deux n'est pas un confort : le premier a besoin d'un moteur — une
 * colonne mal mappée (`@map("data_consent_at")`) ne se voit nulle part ailleurs
 * —, le second a besoin de l'application entière, et les monter ensemble aurait
 * fait payer un conteneur à des cas qui n'en ont aucun usage.
 *
 * ## Les deux façons dont cette colonne pourrait fuir
 *
 * 1. elle sort par une **surface de session** — la réponse de l'inscription,
 *    `/auth/me`, la connexion — qui parlent toutes à la personne elle-même mais
 *    dont la forme est publique et figée par le contrat. Un `USER_SELECT`
 *    élargi d'un geste suffirait, et rien ne rougirait ;
 * 2. elle se lit **depuis le salon voisin**, qui apprendrait alors qu'une
 *    personne s'est inscrite chez un concurrent, et quand.
 *
 * Le second est le pire des deux : une preuve de consentement dit *qu'une
 * personne est cliente* avant même de dire quoi que ce soit de son compte. Le
 * troisième critère d'acceptation de #880 l'exige nommément.
 */

const REGISTER_PATH = '/api/v1/auth/register';

/** Une inscription complète, à laquelle chaque cas retire ou ajoute une chose. */
const INSCRIPTION = {
  email: 'camille@example.test',
  password: 'correct horse battery',
  firstName: 'Camille',
  lastName: 'Rakoto',
  dataConsent: true,
} as const;

// ---------------------------------------------------------------------------
// 1. La colonne — contre un vrai moteur
// ---------------------------------------------------------------------------

/** Le tenant, tel que cette suite le crée — le strict nécessaire du schéma. */
function tenantSeed(label: string): Prisma.TenantCreateInput {
  return {
    slug: `i880-${label}-${randomUUID()}`,
    name: `Établissement ${label}`,
    timezone: 'Europe/Paris',
    defaultCurrency: 'EUR',
  };
}

/**
 * Charge utile de création **sans** le tenant, tel qu'un repository l'écrit —
 * même conversion, et pour la même raison, que dans `identity.repository.ts` :
 * le type généré exige `tenantId`, l'appelant du client scopé ne doit justement
 * pas le fournir, et `$extends` ne réécrit pas les types d'entrée de Prisma.
 */
function withScopedTenant<T>(data: Omit<T, 'tenantId' | 'tenant'>): T {
  return data as T;
}

describe('Isolation inter-tenant — la colonne `users.data_consent_at`', () => {
  let prismaUnscoped: PrismaClient;
  let scoped: ReturnType<typeof createScopedPrismaClient>;
  let database: DisposableDatabase | undefined;

  let tenantA: string;
  let tenantB: string;
  let compteDeA: string;

  /** L'accord de la cliente de A, daté par ce test comme le service le date. */
  const ACCORD_DE_A = new Date('2026-09-17T08:30:00.000Z');

  beforeAll(async () => {
    // Une base neuve et migrée pour cette suite seule : c'est elle qui applique
    // `20260917160000_add_account_data_consent`, donc ce qui prouve que la
    // colonne existe réellement sous le nom que le modèle lui donne.
    database = await createDisposableDatabase();

    prismaUnscoped = new PrismaClient({ datasourceUrl: database.url, errorFormat: 'minimal' });
    await prismaUnscoped.$connect();

    // Le client scopé vient de la **fabrique de l'application** : c'est
    // l'extension que `DatabaseModule` applique réellement qui filtre ici.
    scoped = createScopedPrismaClient(prismaUnscoped);

    // Les établissements passent par le client non scopé — l'extension refuse
    // `Tenant.create`, puisqu'il n'existe alors aucun tenant courant.
    tenantA = (await prismaUnscoped.tenant.create({ data: tenantSeed('a') })).id;
    tenantB = (await prismaUnscoped.tenant.create({ data: tenantSeed('b') })).id;

    compteDeA = await inTenant(tenantA, async () => {
      const user = await scoped.user.create({
        data: withScopedTenant<Prisma.UserUncheckedCreateInput>({
          email: 'camille@example.test',
          role: 'CLIENT',
          firstName: 'Camille',
          lastName: 'Rakoto',
          dataConsentAt: ACCORD_DE_A,
        }),
      });
      return user.id;
    });

    // La **même adresse** chez le voisin, sans accord : c'est le cas que
    // `@@unique([tenant_id, email])` autorise délibérément, et celui où une
    // confusion de tenant se voit.
    await inTenant(tenantB, () =>
      scoped.user.create({
        data: withScopedTenant<Prisma.UserUncheckedCreateInput>({
          email: 'camille@example.test',
          role: 'CLIENT',
          firstName: 'Camille',
          lastName: 'Rakoto',
        }),
      }),
    );
  });

  afterAll(async () => {
    if (prismaUnscoped !== undefined) {
      await prismaUnscoped.$disconnect();
    }
    await database?.drop();
  });

  it('rend l’accord de son établissement, horodaté en UTC', async () => {
    const lu = await inTenant(tenantA, () =>
      scoped.user.findUnique({ where: { id: compteDeA }, select: { dataConsentAt: true } }),
    );

    // `TIMESTAMPTZ` : ce qui sort est l'instant qui est entré, quel que soit le
    // fuseau du serveur (ADR 0006). Une date-heure nue aurait dérivé ici.
    expect(lu?.dataConsentAt?.toISOString()).toBe(ACCORD_DE_A.toISOString());
  });

  it('ne laisse rien lire de l’accord depuis le salon voisin', async () => {
    // Par identifiant : rien du tout, et non une ligne dont l'accord serait nul.
    const parId = await inTenant(tenantB, () =>
      scoped.user.findUnique({ where: { id: compteDeA }, select: { dataConsentAt: true } }),
    );
    expect(parId).toBeNull();

    // Par liste : le voisin voit sa propre cliente, jamais celle d'à côté — et
    // surtout jamais son accord.
    const parListe = await inTenant(tenantB, () =>
      scoped.user.findMany({ select: { id: true, dataConsentAt: true } }),
    );
    expect(parListe.map((ligne) => ligne.id)).not.toContain(compteDeA);
    expect(parListe.every((ligne) => ligne.dataConsentAt === null)).toBe(true);
  });

  it('laisse intact l’accord de A quand le voisin écrit en aveugle', async () => {
    // `updateMany` sans `where` est le geste qui traverse le plus facilement :
    // l'extension y pose le tenant courant, et il ne peut donc atteindre que les
    // lignes du voisin.
    await inTenant(tenantB, () => scoped.user.updateMany({ data: { dataConsentAt: new Date() } }));

    const apres = await inTenant(tenantA, () =>
      scoped.user.findUnique({ where: { id: compteDeA }, select: { dataConsentAt: true } }),
    );

    expect(apres?.dataConsentAt?.toISOString()).toBe(ACCORD_DE_A.toISOString());
  });
});

// ---------------------------------------------------------------------------
// 2. Les routes — contre l'application câblée
// ---------------------------------------------------------------------------

describe('Preuve de consentement à l’inscription — ce que les routes exigent et taisent', () => {
  let harness: TenantHarness;

  beforeEach(async () => {
    harness = await createTenantHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  /** Ce que le dépôt a réellement écrit pour cet établissement-**là**. */
  const comptesDe = (tenantId: string): readonly { dataConsentAt?: Date | null }[] =>
    harness.identity.users.filter((compte) => compte.tenantId === tenantId);

  it('inscrit avec accord, date la preuve côté serveur, et n’en rend rien', async () => {
    const avant = Date.now();

    const reponse = await request(harness.server())
      .post(REGISTER_PATH)
      .send({ tenantSlug: harness.a.slug, ...INSCRIPTION })
      .expect(201);

    const apres = Date.now();
    const preuve = comptesDe(harness.a.id)[0]?.dataConsentAt;

    expect(preuve).toBeInstanceOf(Date);
    // Datée **maintenant**, par le serveur : le corps n'en portait aucune date.
    expect(preuve?.getTime()).toBeGreaterThanOrEqual(avant);
    expect(preuve?.getTime()).toBeLessThanOrEqual(apres);

    // Et la session n'en dit rien — pas même à la personne qui vient de cocher.
    // C'est une donnée de registre, et le registre est du côté du salon.
    expect(JSON.stringify(reponse.body)).not.toContain('dataConsent');

    // Ni le profil qu'elle lira ensuite avec son propre jeton.
    const profil = await request(harness.server())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${String(reponse.body.accessToken)}`)
      .expect(200);

    expect(JSON.stringify(profil.body)).not.toContain('dataConsent');
    expect(JSON.stringify(profil.body)).not.toContain(harness.a.id);
  });

  it('n’écrit aucune preuve dans l’établissement voisin', async () => {
    await request(harness.server())
      .post(REGISTER_PATH)
      .send({ tenantSlug: harness.a.slug, ...INSCRIPTION })
      .expect(201);

    // La même adresse chez le voisin donne un second compte, avec **son propre**
    // accord : l'un ne se déduit pas de l'autre, et aucun ne se partage.
    await request(harness.server())
      .post(REGISTER_PATH)
      .send({ tenantSlug: harness.b.slug, ...INSCRIPTION })
      .expect(201);

    expect(comptesDe(harness.a.id)).toHaveLength(1);
    expect(comptesDe(harness.b.id)).toHaveLength(1);
    // **Chacun** porte le sien. Comparer les deux instants serait un faux
    // témoin des deux côtés : `not.toBe` sur deux `Date` compare des
    // références et ne peut pas échouer, et `getTime()` rendrait le cas rouge
    // le jour où les deux inscriptions tombent dans la même milliseconde. Ce
    // qui se prouve ici, c'est que le second compte a reçu sa propre preuve —
    // et non qu'il a hérité de celle du voisin, auquel cas l'un des deux
    // établissements en serait resté dépourvu.
    expect(comptesDe(harness.a.id)[0]?.dataConsentAt).toBeInstanceOf(Date);
    expect(comptesDe(harness.b.id)[0]?.dataConsentAt).toBeInstanceOf(Date);
  });

  it('ne laisse la preuve apparaître sur aucune liste du back-office', async () => {
    await request(harness.server())
      .post(REGISTER_PATH)
      .send({ tenantSlug: harness.a.slug, ...INSCRIPTION })
      .expect(201);

    // La liste des comptes internes est la seule lecture de comptes qu'`identity`
    // sert. Elle ne montre pas la clientèle, et elle ne montre aucun accord.
    const liste = await request(harness.server())
      .get('/api/v1/users')
      .set('Authorization', await harness.bearer('STAFF'))
      .expect(200);

    expect(JSON.stringify(liste.body)).not.toContain('dataConsent');
  });

  it('refuse l’inscription dont l’accord manque, est refusé, ou s’invente une date', async () => {
    const { dataConsent: _accord, ...sansAccord } = INSCRIPTION;

    const absent = await request(harness.server())
      .post(REGISTER_PATH)
      .send({ tenantSlug: harness.a.slug, ...sansAccord })
      .expect(400);
    expect(absent.body).toMatchObject({ code: expect.any(String), message: expect.any(String) });

    const refuse = await request(harness.server())
      .post(REGISTER_PATH)
      .send({ tenantSlug: harness.a.slug, ...sansAccord, dataConsent: false })
      .expect(400);
    // Le message est celui de l'écran d'inscription : il se lit sur la case.
    expect(JSON.stringify(refuse.body)).toContain('pour créer un compte');

    // Une date soumise par l'appelant n'est pas une preuve (RGPD art. 7.1) : le
    // `.strict()` du contrat la refuse, plutôt que de l'ignorer en silence.
    await request(harness.server())
      .post(REGISTER_PATH)
      .send({
        tenantSlug: harness.a.slug,
        ...INSCRIPTION,
        dataConsentAt: '2020-01-01T00:00:00.000Z',
      })
      .expect(400);

    // Aucun des trois refus n'a laissé de compte derrière lui.
    expect(comptesDe(harness.a.id)).toHaveLength(0);
  });
});
