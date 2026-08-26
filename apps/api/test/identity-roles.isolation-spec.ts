import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';

import { AppModule } from '../src/app.module';
import { configureApp } from '../src/bootstrap';
import { AppConfigService } from '../src/config/app-config.service';
import { CacheConnection } from '../src/infrastructure/cache/cache.connection';
import { DatabaseConnection } from '../src/infrastructure/database/database.connection';
import { IdentityRepository } from '../src/modules/identity/identity.repository';
import { USER_ROLES, type UserRole } from '../src/modules/identity/roles';
import { TokenService } from '../src/modules/identity/token.service';
import { FakeIdentityRepository } from '../src/modules/identity/__tests__/identity.doubles';
import { ProbeDouble } from './utils/test-app';

/**
 * Rôles, permissions et isolation — #22.
 *
 * La suite couvre **chaque rôle sur chaque endpoint protégé**, en HTTP, sur
 * l'application réellement câblée par `configureApp`. Elle exerce trois
 * propriétés que rien d'autre ne prouve bout en bout :
 *
 * 1. la garde de permissions est réellement **montée** par `@Auth(...)` — une
 *    annotation posée sans sa garde serait un commentaire, et la route resterait
 *    ouverte sans que rien ne le signale ;
 * 2. une ressource d'un autre établissement répond **404, jamais 403** ;
 * 3. un refus de droit ne dit rien de la ressource visée — il est identique pour
 *    un identifiant du tenant courant, un identifiant d'ailleurs et un
 *    identifiant qui n'existe nulle part.
 *
 * ## Les jetons sont forgés, et c'est délibéré
 *
 * Ils sont signés par le **vrai** `TokenService` : ce ne sont pas des
 * contrefaçons, ce sont exactement les jetons qu'une connexion émettrait. Passer
 * par `/auth/login` obligerait à créer un compte par rôle, or `MANAGER` n'est pas
 * encore stockable en base — `enum UserRole` ne le connaît pas, et la migration
 * additive appartient à l'empreinte `prisma/`. Le rôle est pourtant reconnu par
 * la couche d'autorisation, et le laisser hors du tableau laisserait justement
 * le rang intermédiaire — celui où une erreur d'un cran se cache — sans test.
 */

const SALON_A = 'salon-des-lilas';
const SALON_B = 'barbier-du-port';
const UNKNOWN_ID = '99999999-9999-4999-8999-999999999999';

interface Harness {
  app: INestApplication;
  repository: FakeIdentityRepository;
  tenantA: string;
  tenantB: string;
  adminA: string;
  staffA: string;
  clientA: string;
  adminB: string;
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

  const adminA = repository.addUser({
    tenantId: tenantA,
    email: 'admin@lilas.test',
    passwordHash: null,
    role: 'ADMIN',
  });
  const staffA = repository.addUser({
    tenantId: tenantA,
    email: 'praticienne@lilas.test',
    passwordHash: null,
    role: 'STAFF',
  });
  const clientA = repository.addUser({
    tenantId: tenantA,
    email: 'cliente@lilas.test',
    passwordHash: null,
    role: 'CLIENT',
  });
  const adminB = repository.addUser({
    tenantId: tenantB,
    email: 'admin@port.test',
    passwordHash: null,
    role: 'ADMIN',
  });

  return {
    app,
    repository,
    tenantA,
    tenantB,
    adminA: adminA.id,
    staffA: staffA.id,
    clientA: clientA.id,
    adminB: adminB.id,
    close: () => app.close(),
  };
}

describe('Rôles, permissions et isolation — #22', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await createHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.app.getHttpServer();

  /**
   * Un jeton d'accès pour ce rôle, dans l'établissement A.
   *
   * Le compte porteur est réel — `/auth/me` le relit — sauf pour `MANAGER`, qui
   * emprunte l'identifiant du compte `STAFF` : le rang vit dans la revendication
   * signée, pas dans la colonne, et c'est le rang que la garde juge.
   */
  const tokenFor = async (role: UserRole, tenantId = harness.tenantA): Promise<string> => {
    const holder =
      role === 'ADMIN' ? harness.adminA : role === 'CLIENT' ? harness.clientA : harness.staffA;
    return harness.app
      .get(TokenService)
      .signAccessToken({ userId: holder, tenantId, role });
  };


  describe('sans jeton — 401 sur toute route protégée', () => {
    it.each([
      ['GET', '/api/v1/auth/me'],
      ['GET', '/api/v1/users'],
      ['GET', '/api/v1/users/00000000-0000-4000-8000-000000000000'],
      ['PATCH', '/api/v1/users/00000000-0000-4000-8000-000000000000/role'],
    ])('%s %s', async (method, path) => {
      const response = await (method === 'GET'
        ? request(server()).get(path)
        : request(server()).patch(path).send({ role: 'STAFF' }));

      expect(response.status).toBe(401);
      expect(response.body.code).toBe('UNAUTHORIZED');
    });
  });

  describe('GET /api/v1/auth/me — `@Auth()`, toute identité vérifiée', () => {
    it.each([...USER_ROLES])('laisse passer %s', async (role) => {
      const token = await tokenFor(role);
      const response = await request(server())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // La route n'est pas un privilège : la clientèle y lit son propre compte.
      expect(response.body.id).toBeDefined();
    });
  });

  describe('GET /api/v1/users — `@AuthAtLeast(STAFF)`', () => {
    it.each(['STAFF', 'MANAGER', 'ADMIN'] as const)('laisse passer %s', async (role) => {
      const token = await tokenFor(role);
      const response = await request(server())
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      // Ordre `(role, email)` : le rang d'un `enum` PostgreSQL est son ordre de
      // déclaration — `STAFF` avant `ADMIN`.
      expect(response.body.map((user: { id: string }) => user.id)).toEqual([
        harness.staffA,
        harness.adminA,
      ]);
    });

    it('refuse CLIENT en 403', async () => {
      const token = await tokenFor('CLIENT');
      const response = await request(server())
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(response.body.details).toEqual({ requiredRoles: ['STAFF', 'MANAGER', 'ADMIN'] });
    });

    it('ne liste ni la clientèle, ni aucun compte de l’autre établissement', async () => {
      const token = await tokenFor('ADMIN');
      const response = await request(server())
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain(harness.adminB);
      expect(serialized).not.toContain('port.test');
      expect(serialized).not.toContain(harness.clientA);
      // Ni le tenant, jamais rendu par l'API (tenant-isolation §4).
      expect(serialized).not.toContain(harness.tenantA);
      expect(serialized).not.toContain(harness.tenantB);
    });
  });

  describe('GET /api/v1/users/:id — `@AuthAtLeast(STAFF)`', () => {
    it.each(['STAFF', 'MANAGER', 'ADMIN'] as const)('laisse passer %s', async (role) => {
      const token = await tokenFor(role);
      const response = await request(server())
        .get(`/api/v1/users/${harness.staffA}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body.id).toBe(harness.staffA);
      expect(Object.keys(response.body).sort()).toEqual([
        'email',
        'firstName',
        'id',
        'lastName',
        'phone',
        'role',
      ]);
    });

    it('refuse CLIENT en 403', async () => {
      const token = await tokenFor('CLIENT');
      await request(server())
        .get(`/api/v1/users/${harness.staffA}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('rend 404 — et non 403 — pour un compte de l’autre établissement', async () => {
      // Le critère de #22, mot pour mot. Un 403 confirmerait l'existence du
      // compte visé (tenant-isolation §4).
      const token = await tokenFor('ADMIN');
      const response = await request(server())
        .get(`/api/v1/users/${harness.adminB}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      expect(response.body.details).toEqual({});
      expect(JSON.stringify(response.body)).not.toContain('port.test');
    });

    it('rend 404 sur une fiche cliente du même établissement', async () => {
      // La route administre les droits ; les données personnelles de la clientèle
      // relèvent du module `crm` et de ses permissions (CDC §5.1). Sans ce
      // filtre, le rang interne le plus bas lirait nom, e-mail et téléphone d'une
      // cliente depuis un point d'entrée qui s'annonce « comptes internes ».
      const token = await tokenFor('STAFF');
      const response = await request(server())
        .get(`/api/v1/users/${harness.clientA}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('cliente@lilas.test');
    });

    it('rend la même réponse pour « inconnu partout » et « connu ailleurs »', async () => {
      const token = await tokenFor('ADMIN');
      const inconnu = await request(server())
        .get(`/api/v1/users/${UNKNOWN_ID}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);
      const ailleurs = await request(server())
        .get(`/api/v1/users/${harness.adminB}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);

      expect(inconnu.body).toEqual(ailleurs.body);
    });
  });

  describe('PATCH /api/v1/users/:id/role — `@Auth(ADMIN)`', () => {
    it('laisse passer ADMIN et attribue le rôle', async () => {
      const token = await tokenFor('ADMIN');
      const response = await request(server())
        .patch(`/api/v1/users/${harness.staffA}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'ADMIN' })
        .expect(200);

      expect(response.body).toMatchObject({ id: harness.staffA, role: 'ADMIN' });
      expect(harness.repository.users.find((user) => user.id === harness.staffA)?.role).toBe(
        'ADMIN',
      );
    });

    it.each(['CLIENT', 'STAFF', 'MANAGER'] as const)('refuse %s en 403, sans rien écrire', async (role) => {
      const token = await tokenFor(role);
      const response = await request(server())
        .patch(`/api/v1/users/${harness.clientA}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'ADMIN' })
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(response.body.details).toEqual({ requiredRoles: ['ADMIN'] });
      expect(harness.repository.users.find((user) => user.id === harness.clientA)?.role).toBe(
        'CLIENT',
      );
    });

    it('rend 404 — et non 403 — sur un compte de l’autre établissement, qui reste intact', async () => {
      const token = await tokenFor('ADMIN');
      const response = await request(server())
        .patch(`/api/v1/users/${harness.adminB}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'CLIENT' })
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      // La ressource du tenant B est intacte — tenant-isolation §6, point 4.
      expect(harness.repository.users.find((user) => user.id === harness.adminB)?.role).toBe(
        'ADMIN',
      );
    });

    it('refuse en 422 qu’un compte modifie son propre rôle', async () => {
      const token = await tokenFor('ADMIN');
      const response = await request(server())
        .patch(`/api/v1/users/${harness.adminA}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'STAFF' })
        .expect(422);

      expect(response.body.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(harness.repository.users.find((user) => user.id === harness.adminA)?.role).toBe(
        'ADMIN',
      );
    });

    it('promeut une cliente en membre du personnel', async () => {
      // La lecture d'une fiche cliente est refusée ; sa promotion ne l'est pas.
      const token = await tokenFor('ADMIN');
      const response = await request(server())
        .patch(`/api/v1/users/${harness.clientA}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'STAFF' })
        .expect(200);

      expect(response.body).toMatchObject({ id: harness.clientA, role: 'STAFF' });
    });

    it('rejette en 400 un rôle que la colonne ne sait pas écrire', async () => {
      // `MANAGER` est nommable par l'autorisation, pas encore stockable. Le
      // refuser à la validation donne un 400 qui nomme les valeurs acceptées ;
      // le laisser passer donnerait une erreur Prisma remontée en 500.
      const token = await tokenFor('ADMIN');
      const response = await request(server())
        .patch(`/api/v1/users/${harness.staffA}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'MANAGER' })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(harness.repository.users.find((user) => user.id === harness.staffA)?.role).toBe(
        'STAFF',
      );
    });

    it('rejette en 400 un `tenantId` glissé dans le corps', async () => {
      // `forbidNonWhitelisted` : l'injection d'un champ non déclaré ne passe pas
      // en silence — c'est le scénario de fuite que le pipe global refuse.
      const token = await tokenFor('ADMIN');
      await request(server())
        .patch(`/api/v1/users/${harness.staffA}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'ADMIN', tenantId: harness.tenantB })
        .expect(400);

      expect(harness.repository.users.find((user) => user.id === harness.staffA)?.role).toBe(
        'STAFF',
      );
    });
  });

  describe('le refus de droit ne renseigne pas sur la ressource visée', () => {
    it('rend le même 403 pour un compte d’ici, un compte d’ailleurs et un inconnu', async () => {
      // C'est ce qui rend la garde compatible avec la règle du 404 : elle ne
      // consulte aucune ressource, son refus ne peut donc en distinguer aucune.
      const token = await tokenFor('CLIENT');
      const bodies = [];
      for (const id of [harness.staffA, harness.adminB, UNKNOWN_ID]) {
        const response = await request(server())
          .get(`/api/v1/users/${id}`)
          .set('Authorization', `Bearer ${token}`)
          .expect(403);
        bodies.push(response.body);
      }

      expect(bodies[1]).toEqual(bodies[0]);
      expect(bodies[2]).toEqual(bodies[0]);
    });
  });

  describe('jeton croisé — le rang ne traverse pas la frontière', () => {
    it('un ADMIN du salon A ne devient pas ADMIN du salon B', async () => {
      // Le jeton est signé par nous, sur le tenant B, avec l'identifiant du
      // compte de A : c'est ce qui arriverait si le module émettait un jour un
      // jeton mal apparié. La liste doit être celle de B, jamais celle de A.
      const croise = await harness.app
        .get(TokenService)
        .signAccessToken({ userId: harness.adminA, tenantId: harness.tenantB, role: 'ADMIN' });

      const response = await request(server())
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${croise}`)
        .expect(200);

      expect(response.body.map((user: { id: string }) => user.id)).toEqual([harness.adminB]);
      expect(JSON.stringify(response.body)).not.toContain('lilas.test');
    });
  });
});
