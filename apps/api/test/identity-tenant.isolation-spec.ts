import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { AppConfigService } from '../src/config/app-config.service';
import { CacheConnection } from '../src/infrastructure/cache/cache.connection';
import { DatabaseConnection } from '../src/infrastructure/database/database.connection';
import { IdentityRepository } from '../src/modules/identity/identity.repository';
import { PasswordHasher } from '../src/modules/identity/password.hasher';
import { REFRESH_COOKIE_NAME } from '../src/modules/identity/refresh-cookie';
import { TokenService } from '../src/modules/identity/token.service';
import { FakeIdentityRepository } from '../src/modules/identity/__tests__/identity.doubles';
import { ProbeDouble } from './utils/test-app';

/**
 * Isolation inter-tenant du module `identity` — obligatoire pour tout endpoint
 * nouveau (tenant-isolation §6, DoD de l'issue).
 *
 * Le module est un cas particulier et c'est ce qui le rend intéressant : c'est
 * *lui* qui pose le tenant dans le contexte. Une faille ici n'ouvrirait pas une
 * table, elle ouvrirait **toutes** celles des sept autres modules, puisque tous
 * s'appuient sur le contexte qu'il renseigne.
 *
 * Deux établissements, la **même adresse e-mail** dans les deux — le cas que
 * `@@unique([tenantId, email])` autorise délibérément, et celui où une confusion
 * de tenant se voit.
 */

const SALON_A = 'salon-des-lilas';
const SALON_B = 'barbier-du-port';
const EMAIL = 'alice@example.test';
const PASSWORD_A = 'mot-de-passe-du-salon-a';
const PASSWORD_B = 'mot-de-passe-du-barbier';

interface Harness {
  app: INestApplication;
  repository: FakeIdentityRepository;
  tenantA: string;
  tenantB: string;
  userA: string;
  userB: string;
  close(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const repository = new FakeIdentityRepository();
  const tenantA = repository.addTenant(SALON_A);
  const tenantB = repository.addTenant(SALON_B);

  const moduleRef = await Test.createTestingModule({ imports: [AppModule] })
    .overrideProvider(DatabaseConnection)
    .useValue(new ProbeDouble())
    .overrideProvider(CacheConnection)
    .useValue(new ProbeDouble())
    .overrideProvider(IdentityRepository)
    .useValue(repository)
    .compile();

  const app = moduleRef.createNestApplication({ logger: false });
  configureApp(app, app.get(AppConfigService));
  await app.init();

  const hasher = app.get(PasswordHasher);
  const userA = repository.addUser({
    tenantId: tenantA,
    email: EMAIL,
    passwordHash: await hasher.hash(PASSWORD_A),
    role: 'CLIENT',
  });
  const userB = repository.addUser({
    tenantId: tenantB,
    email: EMAIL,
    passwordHash: await hasher.hash(PASSWORD_B),
    role: 'ADMIN',
  });

  return {
    app,
    repository,
    tenantA,
    tenantB,
    userA: userA.id,
    userB: userB.id,
    close: () => app.close(),
  };
}

describe('Isolation inter-tenant — module identity', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.app.getHttpServer();

  const login = async (slug: string, password: string): Promise<request.Response> =>
    request(server())
      .post('/api/v1/auth/login')
      .send({ tenantSlug: slug, email: EMAIL, password })
      .expect(200);

  it('la même adresse désigne deux comptes distincts dans deux établissements', async () => {
    const a = await login(SALON_A, PASSWORD_A);
    const b = await login(SALON_B, PASSWORD_B);

    expect(a.body.user.id).toBe(harness.userA);
    expect(b.body.user.id).toBe(harness.userB);
    expect(a.body.user.id).not.toBe(b.body.user.id);
  });

  it('le mot de passe d’un établissement n’ouvre pas l’autre', async () => {
    // Les identifiants sont valides — ailleurs. La réponse ne dit pas qu'ils le
    // sont ailleurs.
    const response = await request(server())
      .post('/api/v1/auth/login')
      .send({ tenantSlug: SALON_B, email: EMAIL, password: PASSWORD_A })
      .expect(401);

    expect(response.body.code).toBe('INVALID_CREDENTIALS');
  });

  it('le jeton d’un établissement ne lit que le compte de cet établissement', async () => {
    const a = await login(SALON_A, PASSWORD_A);

    const profile = await request(server())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${a.body.accessToken}`)
      .expect(200);

    expect(profile.body.id).toBe(harness.userA);
    expect(profile.body.id).not.toBe(harness.userB);
    // Le rôle du compte B est ADMIN : le lire prouverait la traversée.
    expect(profile.body.role).toBe('CLIENT');
  });

  it('un jeton forgé sur le tenant voisin ne ressuscite pas le compte d’origine', async () => {
    // Le scénario le plus direct : un porteur légitime du salon A modifie la
    // revendication `tenantId` pour viser le salon B. Le jeton est **signé par
    // nous** — ce n'est pas une contrefaçon, c'est ce qui arriverait si le module
    // émettait un jour un jeton mal apparié. Le compte de A n'existe pas dans B :
    // la lecture doit échouer, pas retomber sur la ligne de A.
    const tokens = harness.app.get(TokenService);
    const croise = await tokens.signAccessToken({
      userId: harness.userA,
      tenantId: harness.tenantB,
      role: 'CLIENT',
    });

    const response = await request(server())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${croise}`)
      .expect(404);

    // 404 et non 403 : un 403 confirmerait que ce compte existe quelque part.
    expect(response.body.code).toBe('NOT_FOUND');
    expect(JSON.stringify(response.body)).not.toContain(harness.userA);
  });

  it('la déconnexion d’un établissement laisse la session de l’autre intacte', async () => {
    const a = await login(SALON_A, PASSWORD_A);
    const b = await login(SALON_B, PASSWORD_B);

    const cookieA = (a.headers['set-cookie'] as unknown as string[]).find((cookie) =>
      cookie.startsWith(`${REFRESH_COOKIE_NAME}=`),
    );
    const cookieB = (b.headers['set-cookie'] as unknown as string[]).find((cookie) =>
      cookie.startsWith(`${REFRESH_COOKIE_NAME}=`),
    );
    expect(cookieA).toBeDefined();
    expect(cookieB).toBeDefined();

    await request(server())
      .post('/api/v1/auth/logout')
      .set('Cookie', cookieA ?? '')
      .expect(204);

    // La session de B tourne encore : révoquer au-delà de son tenant serait un
    // déni de service inter-établissement.
    await request(server())
      .post('/api/v1/auth/refresh')
      .set('Cookie', cookieB ?? '')
      .expect(200);

    const sessions = harness.repository.sessions;
    expect(sessions.filter((session) => session.revokedAt !== null)).toHaveLength(1);
  });

  it('n’expose jamais le `tenantId` dans une réponse', async () => {
    // C'est une information interne : elle n'apporte rien au consommateur et
    // invite aux essais (tenant-isolation §4).
    const a = await login(SALON_A, PASSWORD_A);
    const profile = await request(server())
      .get('/api/v1/auth/me')
      .set('Authorization', `Bearer ${a.body.accessToken}`)
      .expect(200);

    for (const body of [a.body, profile.body]) {
      expect(JSON.stringify(body)).not.toContain(harness.tenantA);
      expect(JSON.stringify(body)).not.toContain(harness.tenantB);
    }

    expect(Object.keys(profile.body).sort()).toEqual([
      'email',
      'firstName',
      'id',
      'lastName',
      'phone',
      'role',
    ]);
  });

  it('ne laisse pas un `tenantSlug` inconnu servir de sonde d’existence', async () => {
    // Un slug inconnu et un slug connu sans compte doivent se distinguer le moins
    // possible : le premier répond 404 « établissement », le second 401
    // « identifiants ». C'est la seule différence, et elle ne dit rien d'un compte.
    const inconnu = await request(server())
      .post('/api/v1/auth/login')
      .send({ tenantSlug: 'salon-qui-nexiste-pas', email: EMAIL, password: PASSWORD_A })
      .expect(404);

    expect(inconnu.body.details).toEqual({});
    expect(JSON.stringify(inconnu.body)).not.toContain(EMAIL);
  });
});
