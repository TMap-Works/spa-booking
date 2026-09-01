import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { USER_ROLES, type UserRole } from '../src/modules/identity/roles';
import { TokenService } from '../src/modules/identity/token.service';
import { createTenantHarness, UNKNOWN_ID, type TenantHarness } from './utils/tenant-harness';

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
 * par `/auth/login` obligerait à faire hacher un mot de passe par rôle et par
 * cas, sans rien prouver de plus sur la garde — c'est `identity-auth` qui exerce
 * la connexion.
 *
 * Les quatre rôles ont désormais un compte réel derrière leur jeton, `MANAGER`
 * compris : la migration `20260826100000_add_manager_user_role` a rendu la
 * valeur stockable (#202). Le rang intermédiaire — celui où une erreur d'un cran
 * se cache — est donc exercé sur un compte que la colonne saurait porter, et non
 * plus sur un emprunt d'identifiant.
 */

describe('Rôles, permissions et isolation — #22', () => {
  let harness: TenantHarness;
  /** Les quatre rangs de l'établissement A, chacun sur un compte réel. */
  let adminA: string;
  let managerA: string;
  let staffA: string;
  let clientA: string;
  let adminB: string;
  /**
   * Le pendant de `managerA` dans l'autre établissement : c'est lui qui rend
   * vérifiable qu'un rôle nouvellement stockable ne franchit pas la frontière —
   * ni en lecture, ni en réattribution (tenant-isolation §6).
   */
  let managerB: string;

  beforeEach(async () => {
    harness = await createTenantHarness();
    const seed = async (
      tenant: typeof harness.a,
      email: string,
      role: UserRole,
    ): Promise<string> => (await harness.seedUser(tenant, { email, role })).id;

    adminA = await seed(harness.a, 'admin@lilas.test', 'ADMIN');
    managerA = await seed(harness.a, 'manager@lilas.test', 'MANAGER');
    staffA = await seed(harness.a, 'praticienne@lilas.test', 'STAFF');
    clientA = await seed(harness.a, 'cliente@lilas.test', 'CLIENT');
    adminB = await seed(harness.b, 'admin@port.test', 'ADMIN');
    managerB = await seed(harness.b, 'manager@port.test', 'MANAGER');
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.server();

  /**
   * Un jeton d'accès pour ce rôle, dans l'établissement A.
   *
   * Le compte porteur est réel pour les quatre rôles — `/auth/me` le relit — et
   * porte en mémoire le rôle qu'annonce la revendication : depuis #202, la
   * colonne sait écrire les quatre, il n'y a plus d'identité à emprunter.
   *
   * C'est la seule raison pour laquelle cette suite ne se sert pas du
   * `tokenFor` du harnais partagé : celui-ci tire un `userId` au hasard, ce qui
   * convient à un test de fuite mais pas à une suite qui relit le compte porteur.
   */
  const HOLDERS: Readonly<Record<UserRole, () => string>> = {
    CLIENT: () => clientA,
    STAFF: () => staffA,
    MANAGER: () => managerA,
    ADMIN: () => adminA,
  };

  const tokenFor = async (role: UserRole, tenantId = harness.a.id): Promise<string> => {
    return harness.app
      .get(TokenService)
      .signAccessToken({ userId: HOLDERS[role](), tenantId, role });
  };


  describe('sans jeton — 401 sur toute route protégée', () => {
    it.each([
      ['GET', '/api/v1/auth/me'],
      ['GET', '/api/v1/users'],
      ['GET', '/api/v1/users/00000000-0000-4000-8000-000000000000'],
      ['PATCH', '/api/v1/users/00000000-0000-4000-8000-000000000000/role'],
      // #47 : modifier ses coordonnées n'est pas plus ouvert que le reste. Le
      // 401 vient de la garde, donc **avant** le `ValidationPipe` — un corps
      // impropre à cette route ne change rien au refus.
      ['PATCH', '/api/v1/users/me'],
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
      // déclaration — `STAFF` avant `MANAGER` avant `ADMIN`. C'est ce que la
      // migration de #202 obtient en insérant `MANAGER` *avant* `ADMIN` plutôt
      // qu'en queue d'énumération ; un ajout en queue aurait rendu
      // `[STAFF, ADMIN, MANAGER]`.
      expect(response.body.map((user: { id: string }) => user.id)).toEqual([
        staffA,
        managerA,
        adminA,
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
      expect(serialized).not.toContain(adminB);
      // Le compte `MANAGER` de l'autre établissement pas davantage : un rôle
      // devenu stockable est un rôle de plus à ne pas laisser franchir la
      // frontière.
      expect(serialized).not.toContain(managerB);
      expect(serialized).not.toContain('port.test');
      expect(serialized).not.toContain(clientA);
      // Ni le tenant, jamais rendu par l'API (tenant-isolation §4).
      expect(serialized).not.toContain(harness.a.id);
      expect(serialized).not.toContain(harness.b.id);
    });
  });

  describe('GET /api/v1/users/:id — `@AuthAtLeast(STAFF)`', () => {
    it.each(['STAFF', 'MANAGER', 'ADMIN'] as const)('laisse passer %s', async (role) => {
      const token = await tokenFor(role);
      const response = await request(server())
        .get(`/api/v1/users/${staffA}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(response.body.id).toBe(staffA);
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
        .get(`/api/v1/users/${staffA}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(403);
    });

    it('rend 404 — et non 403 — pour un compte de l’autre établissement', async () => {
      // Le critère de #22, mot pour mot. Un 403 confirmerait l'existence du
      // compte visé (tenant-isolation §4).
      const token = await tokenFor('ADMIN');
      const response = await request(server())
        .get(`/api/v1/users/${adminB}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      expect(response.body.details).toEqual({});
      expect(JSON.stringify(response.body)).not.toContain('port.test');
    });

    it('rend 404 sur le compte `MANAGER` de l’autre établissement', async () => {
      // Le rôle que #202 rend stockable est un compte de plus derrière la
      // frontière : sans cette assertion, rien ne dirait que le filtre sur les
      // rôles internes ne l'a pas rendu lisible d'ailleurs.
      const token = await tokenFor('ADMIN');
      const response = await request(server())
        .get(`/api/v1/users/${managerB}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('port.test');
    });

    it('rend 404 sur une fiche cliente du même établissement', async () => {
      // La route administre les droits ; les données personnelles de la clientèle
      // relèvent du module `crm` et de ses permissions (CDC §5.1). Sans ce
      // filtre, le rang interne le plus bas lirait nom, e-mail et téléphone d'une
      // cliente depuis un point d'entrée qui s'annonce « comptes internes ».
      const token = await tokenFor('STAFF');
      const response = await request(server())
        .get(`/api/v1/users/${clientA}`)
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
        .get(`/api/v1/users/${adminB}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(404);

      expect(inconnu.body).toEqual(ailleurs.body);
    });
  });

  describe('PATCH /api/v1/users/:id/role — `@Auth(ADMIN)`', () => {
    it('laisse passer ADMIN et attribue le rôle', async () => {
      const token = await tokenFor('ADMIN');
      const response = await request(server())
        .patch(`/api/v1/users/${staffA}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'ADMIN' })
        .expect(200);

      expect(response.body).toMatchObject({ id: staffA, role: 'ADMIN' });
      expect(harness.identity.users.find((user) => user.id === staffA)?.role).toBe(
        'ADMIN',
      );
    });

    it.each(['CLIENT', 'STAFF', 'MANAGER'] as const)('refuse %s en 403, sans rien écrire', async (role) => {
      const token = await tokenFor(role);
      const response = await request(server())
        .patch(`/api/v1/users/${clientA}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'ADMIN' })
        .expect(403);

      expect(response.body.code).toBe('FORBIDDEN');
      expect(response.body.details).toEqual({ requiredRoles: ['ADMIN'] });
      expect(harness.identity.users.find((user) => user.id === clientA)?.role).toBe(
        'CLIENT',
      );
    });

    it('rend 404 — et non 403 — sur un compte de l’autre établissement, qui reste intact', async () => {
      const token = await tokenFor('ADMIN');
      const response = await request(server())
        .patch(`/api/v1/users/${adminB}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'CLIENT' })
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      // La ressource du tenant B est intacte — tenant-isolation §6, point 4.
      expect(harness.identity.users.find((user) => user.id === adminB)?.role).toBe(
        'ADMIN',
      );
    });

    it('refuse en 422 qu’un compte modifie son propre rôle', async () => {
      const token = await tokenFor('ADMIN');
      const response = await request(server())
        .patch(`/api/v1/users/${adminA}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'STAFF' })
        .expect(422);

      expect(response.body.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(harness.identity.users.find((user) => user.id === adminA)?.role).toBe(
        'ADMIN',
      );
    });

    it('promeut une cliente en membre du personnel', async () => {
      // La lecture d'une fiche cliente est refusée ; sa promotion ne l'est pas.
      const token = await tokenFor('ADMIN');
      const response = await request(server())
        .patch(`/api/v1/users/${clientA}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'STAFF' })
        .expect(200);

      expect(response.body).toMatchObject({ id: clientA, role: 'STAFF' });
    });

    it('attribue `MANAGER`, que la colonne sait désormais écrire', async () => {
      // Le critère d'acceptation de #202 : le rang intermédiaire a cessé d'être
      // refusé en 400. La garde le nommait depuis #201, `enum UserRole` ne
      // l'écrivait pas, et le DTO le rejetait pour éviter une erreur Prisma en
      // 500. La migration additive a levé les trois d'un coup.
      const token = await tokenFor('ADMIN');
      const response = await request(server())
        .patch(`/api/v1/users/${staffA}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'MANAGER' })
        .expect(200);

      expect(response.body).toMatchObject({ id: staffA, role: 'MANAGER' });
      expect(harness.identity.users.find((user) => user.id === staffA)?.role).toBe(
        'MANAGER',
      );
    });

    it('relit ensuite le compte avec son rôle `MANAGER`', async () => {
      // « Créé **et lu** » : l'écriture ne prouve rien si la lecture ne rend pas
      // le rôle. `GET /users/:id` filtre sur les rôles internes — un `MANAGER`
      // absent de ce filtre disparaîtrait de l'administration des droits juste
      // après y avoir été promu.
      const token = await tokenFor('ADMIN');
      await request(server())
        .patch(`/api/v1/users/${staffA}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'MANAGER' })
        .expect(200);

      const relu = await request(server())
        .get(`/api/v1/users/${staffA}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(200);

      expect(relu.body).toMatchObject({ id: staffA, role: 'MANAGER' });
    });

    it('rejette toujours en 400 un rôle absent de l’énumération', async () => {
      // Le `@IsIn` du DTO n'a pas disparu avec la restriction de #201 : c'est lui
      // qui empêche une chaîne arbitraire de descendre jusqu'au pilote
      // PostgreSQL, qui la refuserait par une erreur de type remontée en 500.
      const token = await tokenFor('ADMIN');
      const response = await request(server())
        .patch(`/api/v1/users/${staffA}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'SUPERADMIN' })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(harness.identity.users.find((user) => user.id === staffA)?.role).toBe(
        'STAFF',
      );
    });

    it('rend 404 — et non 403 — en promouvant `MANAGER` un compte de l’autre établissement', async () => {
      // tenant-isolation §6, point 4, appliqué au rôle que #202 rend stockable :
      // la tentative échoue en 404 et la ressource du tenant B est intacte.
      const token = await tokenFor('ADMIN');
      const response = await request(server())
        .patch(`/api/v1/users/${adminB}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'MANAGER' })
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      expect(harness.identity.users.find((user) => user.id === adminB)?.role).toBe(
        'ADMIN',
      );
    });

    it('rend 404 sur le compte `MANAGER` de l’autre établissement, qui reste intact', async () => {
      const token = await tokenFor('ADMIN');
      const response = await request(server())
        .patch(`/api/v1/users/${managerB}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'CLIENT' })
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain('port.test');
      expect(harness.identity.users.find((user) => user.id === managerB)?.role).toBe(
        'MANAGER',
      );
    });

    it('rejette en 400 un `tenantId` glissé dans le corps', async () => {
      // `forbidNonWhitelisted` : l'injection d'un champ non déclaré ne passe pas
      // en silence — c'est le scénario de fuite que le pipe global refuse.
      const token = await tokenFor('ADMIN');
      await request(server())
        .patch(`/api/v1/users/${staffA}/role`)
        .set('Authorization', `Bearer ${token}`)
        .send({ role: 'ADMIN', tenantId: harness.b.id })
        .expect(400);

      expect(harness.identity.users.find((user) => user.id === staffA)?.role).toBe(
        'STAFF',
      );
    });
  });

  describe('PATCH /api/v1/users/me — `@Auth()`, ses propres coordonnées (#47)', () => {
    it.each([...USER_ROLES])('laisse passer %s et n’écrit que son propre compte', async (role) => {
      const token = await tokenFor(role);
      const holder = HOLDERS[role]();

      const response = await request(server())
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ firstName: 'Camille', phone: '+261 34 12 345 67' })
        .expect(200);

      expect(response.body).toMatchObject({
        id: holder,
        firstName: 'Camille',
        phone: '+261 34 12 345 67',
      });

      const written = harness.identity.users.find((user) => user.id === holder);
      expect(written?.firstName).toBe('Camille');
      // Le champ omis n'est pas effacé : `partial` veut dire « ce qui est
      // envoyé », pas « ce qui reste ».
      expect(written?.lastName).toBe('Durand');
      // Et surtout : le rôle n'a pas bougé. C'est la route par laquelle un
      // `CLIENT` écrit dans `users` — si un `role` pouvait y passer, elle serait
      // une promotion en libre-service.
      expect(written?.role).toBe(role);
    });

    it('efface le numéro quand `phone` vaut `null`', async () => {
      const token = await tokenFor('CLIENT');
      const seeded = harness.identity.users.find((user) => user.id === clientA);
      expect(seeded).toBeDefined();
      if (seeded !== undefined) {
        seeded.phone = '+261340000000';
      }

      const response = await request(server())
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ phone: null })
        .expect(200);

      expect(response.body.phone).toBeNull();
      expect(harness.identity.users.find((user) => user.id === clientA)?.phone).toBeNull();
    });

    it('n’expose ni `tenantId` ni empreinte de mot de passe', async () => {
      const token = await tokenFor('CLIENT');
      const response = await request(server())
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ firstName: 'Camille' })
        .expect(200);

      expect(Object.keys(response.body).sort()).toEqual([
        'email',
        'firstName',
        'id',
        'lastName',
        'phone',
        'role',
      ]);
      expect(JSON.stringify(response.body)).not.toContain(harness.a.id);
      expect(JSON.stringify(response.body)).not.toContain(harness.b.id);
    });

    it.each([
      ['role', { role: 'ADMIN' }],
      ['email', { email: 'autre@lilas.test' }],
      ['isActive', { isActive: false }],
      ['tenantId', { tenantId: 'un-autre-salon' }],
      ['id', { id: '00000000-0000-4000-8000-000000000000' }],
    ])('rejette en 400 un `%s` glissé dans le corps, sans rien écrire', async (_field, body) => {
      // `forbidNonWhitelisted` : ce qui n'est pas déclaré par le DTO est refusé
      // en nommant le champ, jamais ignoré en silence. C'est ce qui rend
      // exécutoire l'omission délibérée de ces cinq champs.
      const token = await tokenFor('CLIENT');
      const response = await request(server())
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send(body)
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
      const kept = harness.identity.users.find((user) => user.id === clientA);
      expect(kept?.role).toBe('CLIENT');
      expect(kept?.email).toBe('cliente@lilas.test');
    });

    it('rejette en 400 un prénom réduit à des espaces', async () => {
      const token = await tokenFor('CLIENT');
      await request(server())
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ firstName: '   ' })
        .expect(400);

      expect(harness.identity.users.find((user) => user.id === clientA)?.firstName).toBe('Alice');
    });

    it('rend 404 — et non 403 — sous un jeton signé sur l’autre établissement', async () => {
      // Le scénario de traversée : un porteur légitime de A dont la revendication
      // `tenantId` vise B. Le compte de A n'existe pas dans B — la lecture doit
      // échouer, pas retomber sur la ligne de A. Et le compte de A doit ressortir
      // intact : un `updateMany` sans filtre de tenant l'aurait réécrit.
      const croise = await harness.app
        .get(TokenService)
        .signAccessToken({ userId: clientA, tenantId: harness.b.id, role: 'CLIENT' });

      const response = await request(server())
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${croise}`)
        .send({ firstName: 'Intruse' })
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      expect(response.body.details).toEqual({});
      expect(JSON.stringify(response.body)).not.toContain(clientA);
      expect(harness.identity.users.find((user) => user.id === clientA)?.firstName).toBe('Alice');
    });

    it('rend le même 404 pour un compte qui n’existe nulle part', async () => {
      const inconnu = await harness.app
        .get(TokenService)
        .signAccessToken({ userId: UNKNOWN_ID, tenantId: harness.a.id, role: 'CLIENT' });
      const croise = await harness.app
        .get(TokenService)
        .signAccessToken({ userId: clientA, tenantId: harness.b.id, role: 'CLIENT' });

      const absent = await request(server())
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${inconnu}`)
        .send({ firstName: 'Camille' })
        .expect(404);
      const ailleurs = await request(server())
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${croise}`)
        .send({ firstName: 'Camille' })
        .expect(404);

      // « Inconnu ici » et « connu ailleurs » doivent être indiscernables.
      expect(absent.body).toEqual(ailleurs.body);
    });

    it('n’écrit rien chez le voisin quand la modification aboutit', async () => {
      const token = await tokenFor('CLIENT');
      await request(server())
        .patch('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`)
        .send({ firstName: 'Camille', lastName: 'Rakoto' })
        .expect(200);

      for (const foreign of [adminB, managerB]) {
        const kept = harness.identity.users.find((user) => user.id === foreign);
        expect(kept?.firstName).toBe('Alice');
        expect(kept?.lastName).toBe('Durand');
      }
    });
  });

  describe('le refus de droit ne renseigne pas sur la ressource visée', () => {
    it('rend le même 403 pour un compte d’ici, un compte d’ailleurs et un inconnu', async () => {
      // C'est ce qui rend la garde compatible avec la règle du 404 : elle ne
      // consulte aucune ressource, son refus ne peut donc en distinguer aucune.
      const token = await tokenFor('CLIENT');
      const bodies = [];
      for (const id of [staffA, adminB, UNKNOWN_ID]) {
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
        .signAccessToken({ userId: adminA, tenantId: harness.b.id, role: 'ADMIN' });

      const response = await request(server())
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${croise}`)
        .expect(200);

      // Les deux comptes internes de B, dans l'ordre du rang — et aucun de A.
      expect(response.body.map((user: { id: string }) => user.id)).toEqual([
        managerB,
        adminB,
      ]);
      expect(JSON.stringify(response.body)).not.toContain('lilas.test');
    });
  });
});
