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
import { FakeIdentityRepository } from '../src/modules/identity/__tests__/identity.doubles';
import { ProbeDouble } from './utils/test-app';

/**
 * Le parcours d'authentification, exercé **en HTTP** sur l'application réelle.
 *
 * Ce que cette suite prouve et qu'un test unitaire ne peut pas : que le
 * `ValidationPipe` global, la garde, le filtre d'exceptions, le préfixe d'URI et
 * les cookies sont réellement câblés ensemble. Les règles métier, elles, sont
 * couvertes sans HTTP par `auth.service.spec.ts`.
 *
 * Le dépôt est remplacé par son double en mémoire : PostgreSQL n'est pas
 * l'objet du test, et `PrismaService` ne se connecte de toute façon pas à
 * l'initialisation.
 */

const SLUG = 'salon-des-lilas';
const EMAIL = 'alice@example.test';
const PASSWORD = 'correct-horse-battery';

interface Harness {
  app: INestApplication;
  repository: FakeIdentityRepository;
  tenantId: string;
  close(): Promise<void>;
}

async function createHarness(): Promise<Harness> {
  const repository = new FakeIdentityRepository();
  const tenantId = repository.addTenant(SLUG);

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

  return { app, repository, tenantId, close: () => app.close() };
}

/** Le `Set-Cookie` du jeton de rafraîchissement, tel qu'il part sur le fil. */
function refreshCookie(response: request.Response): string | undefined {
  const header = response.headers['set-cookie'];
  const cookies = Array.isArray(header) ? header : header === undefined ? [] : [header];
  return cookies.find((cookie) => cookie.startsWith(`${REFRESH_COOKIE_NAME}=`));
}

describe('Authentification — parcours HTTP', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
    const hasher = harness.app.get(PasswordHasher);
    harness.repository.addUser({
      tenantId: harness.tenantId,
      email: EMAIL,
      passwordHash: await hasher.hash(PASSWORD),
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> =>
    harness.app.getHttpServer();

  describe('inscription', () => {
    it('crée le compte, pose le cookie et rend le jeton d’accès', async () => {
      const response = await request(server())
        .post('/api/v1/auth/register')
        .send({
          tenantSlug: SLUG,
          email: 'nouvelle@example.test',
          password: PASSWORD,
          firstName: 'Nouvelle',
          lastName: 'Cliente',
        })
        .expect(201);

      expect(response.body.accessToken).toEqual(expect.any(String));
      expect(response.body.expiresIn).toBe(900);
      expect(refreshCookie(response)).toBeDefined();
    });

    it('refuse un mot de passe trop court', async () => {
      const response = await request(server())
        .post('/api/v1/auth/register')
        .send({
          tenantSlug: SLUG,
          email: 'courte@example.test',
          password: 'court',
          firstName: 'A',
          lastName: 'B',
        })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('rejette un `tenantId` glissé dans le corps', async () => {
      // Le scénario de fuite le plus direct : le client pose lui-même le tenant.
      // `forbidNonWhitelisted` le **rejette** au lieu de l'ignorer.
      const response = await request(server())
        .post('/api/v1/auth/register')
        .send({
          tenantSlug: SLUG,
          tenantId: 'tenant-de-la-victime',
          email: 'injection@example.test',
          password: PASSWORD,
          firstName: 'A',
          lastName: 'B',
        })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(response.body)).not.toContain('tenant-de-la-victime');
    });

    it('refuse une adresse déjà prise dans cet établissement', async () => {
      const response = await request(server())
        .post('/api/v1/auth/register')
        .send({
          tenantSlug: SLUG,
          email: EMAIL,
          password: PASSWORD,
          firstName: 'A',
          lastName: 'B',
        })
        .expect(409);

      expect(response.body.code).toBe('EMAIL_ALREADY_REGISTERED');
    });
  });

  describe('connexion', () => {
    it('rend un jeton d’accès et un profil sans donnée interne', async () => {
      const response = await request(server())
        .post('/api/v1/auth/login')
        .send({ tenantSlug: SLUG, email: EMAIL, password: PASSWORD })
        .expect(200);

      expect(Object.keys(response.body).sort()).toEqual(['accessToken', 'expiresIn', 'user']);
      // Le jeton de rafraîchissement n'est **pas** dans le corps : l'y mettre
      // annulerait ce que `httpOnly` protège.
      expect(JSON.stringify(response.body)).not.toContain(harness.tenantId);
      expect(response.body.user.passwordHash).toBeUndefined();
      expect(response.body.user.tenantId).toBeUndefined();
    });

    it('pose un cookie httpOnly, SameSite=Lax, borné aux routes d’authentification', async () => {
      const response = await request(server())
        .post('/api/v1/auth/login')
        .send({ tenantSlug: SLUG, email: EMAIL, password: PASSWORD })
        .expect(200);

      const cookie = refreshCookie(response);
      expect(cookie).toBeDefined();
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('SameSite=Lax');
      expect(cookie).toContain('Path=/api/v1/auth');
    });

    it.each([
      ['mot de passe faux', EMAIL, 'mauvais-mot-de-passe'],
      ['adresse inconnue', 'personne@example.test', PASSWORD],
    ])('répond 401 et le même corps sur %s', async (_cas, email, password) => {
      const response = await request(server())
        .post('/api/v1/auth/login')
        .send({ tenantSlug: SLUG, email, password })
        .expect(401);

      expect(response.body.code).toBe('INVALID_CREDENTIALS');
      expect(response.body.details).toEqual({});
    });

    it('répond 404 sur un établissement inconnu, jamais 403', async () => {
      const response = await request(server())
        .post('/api/v1/auth/login')
        .send({ tenantSlug: 'salon-inexistant', email: EMAIL, password: PASSWORD })
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
    });
  });

  describe('route authentifiée', () => {
    const login = async (): Promise<{ accessToken: string; cookie: string }> => {
      const response = await request(server())
        .post('/api/v1/auth/login')
        .send({ tenantSlug: SLUG, email: EMAIL, password: PASSWORD })
        .expect(200);
      const cookie = refreshCookie(response);
      expect(cookie).toBeDefined();
      return { accessToken: response.body.accessToken, cookie: cookie ?? '' };
    };

    it('rend le compte porté par le jeton', async () => {
      const { accessToken } = await login();

      const response = await request(server())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(response.body.email).toBe(EMAIL);
      expect(response.body.tenantId).toBeUndefined();
    });

    it.each([
      ['sans en-tête', undefined],
      ['avec un schéma inconnu', 'Basic abc'],
      ['avec un jeton vide', 'Bearer '],
      ['avec un jeton forgé', 'Bearer pas.un.jeton'],
    ])('répond 401 %s', async (_cas, header) => {
      const call = request(server()).get('/api/v1/auth/me');
      if (header !== undefined) {
        call.set('Authorization', header);
      }
      await call.expect(401);
    });

    it('refuse le jeton de rafraîchissement comme jeton d’accès', async () => {
      const { cookie } = await login();
      const token = decodeURIComponent(cookie.split(';')[0]?.split('=')[1] ?? '');

      await request(server())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(401);
    });
  });

  describe('rafraîchissement et déconnexion', () => {
    const login = async (): Promise<string> => {
      const response = await request(server())
        .post('/api/v1/auth/login')
        .send({ tenantSlug: SLUG, email: EMAIL, password: PASSWORD })
        .expect(200);
      return refreshCookie(response) ?? '';
    };

    it('renouvelle le jeton d’accès depuis le cookie', async () => {
      const cookie = await login();

      const response = await request(server())
        .post('/api/v1/auth/refresh')
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body.accessToken).toEqual(expect.any(String));
      // Le cookie est renouvelé : la rotation est visible sur le fil.
      expect(refreshCookie(response)).toBeDefined();
      expect(refreshCookie(response)).not.toBe(cookie);
    });

    it('refuse un rafraîchissement sans cookie', async () => {
      const response = await request(server()).post('/api/v1/auth/refresh').expect(401);
      expect(response.body.code).toBe('INVALID_REFRESH_TOKEN');
    });

    it('invalide le refresh à la déconnexion — c’est la ligne en base qui s’éteint', async () => {
      const cookie = await login();

      await request(server()).post('/api/v1/auth/logout').set('Cookie', cookie).expect(204);

      // Le critère d'acceptation : après déconnexion, le jeton ne vaut plus rien,
      // même présenté par quelqu'un qui l'aurait volé et n'effacera pas le cookie.
      await request(server()).post('/api/v1/auth/refresh').set('Cookie', cookie).expect(401);
      expect(harness.repository.sessions[0]?.revokedAt).toBeInstanceOf(Date);
    });

    it('efface le cookie à la déconnexion', async () => {
      const cookie = await login();

      const response = await request(server())
        .post('/api/v1/auth/logout')
        .set('Cookie', cookie)
        .expect(204);

      const cleared = refreshCookie(response);
      expect(cleared).toBeDefined();
      expect(cleared).toContain('Path=/api/v1/auth');
    });

    it('répond 204 sans cookie — la déconnexion n’échoue jamais', async () => {
      await request(server()).post('/api/v1/auth/logout').expect(204);
    });

    it('révoque toute la session au réemploi d’un jeton déjà tourné', async () => {
      const cookie = await login();
      await request(server()).post('/api/v1/auth/refresh').set('Cookie', cookie).expect(200);

      // Rejeu du jeton d'origine, déjà consommé par la rotation.
      await request(server()).post('/api/v1/auth/refresh').set('Cookie', cookie).expect(401);

      expect(harness.repository.sessions.every((session) => session.revokedAt !== null)).toBe(true);
    });
  });

  describe('limitation de débit', () => {
    it('coupe le forçage de la connexion depuis une même origine', async () => {
      // bcrypt rend le forçage **hors ligne** coûteux ; il ne fait rien contre le
      // forçage **en ligne**, où c'est notre serveur qui paie le hachage.
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 12; attempt += 1) {
        const response = await request(server())
          .post('/api/v1/auth/login')
          .send({ tenantSlug: SLUG, email: EMAIL, password: 'mauvais-mot-de-passe' });
        statuses.push(response.status);
      }

      expect(statuses).toContain(429);
      // Le quota est de 10 par minute : les deux dernières tentatives tombent.
      expect(statuses.filter((status) => status === 429).length).toBeGreaterThanOrEqual(2);
    });

    it('borne aussi la création de comptes en masse', async () => {
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 7; attempt += 1) {
        const response = await request(server())
          .post('/api/v1/auth/register')
          .send({
            tenantSlug: SLUG,
            email: `masse-${attempt}@example.test`,
            password: PASSWORD,
            firstName: 'A',
            lastName: 'B',
          });
        statuses.push(response.status);
      }

      expect(statuses).toContain(429);
    });
  });
});
