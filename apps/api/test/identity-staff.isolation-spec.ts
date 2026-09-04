import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { TokenService } from '../src/modules/identity/token.service';
import { expectCrossTenantNotFound, expectNotFoundWithoutLeak } from './utils/tenant-assertions';
import { createTenantHarness, UNKNOWN_ID, type TenantHarness } from './utils/tenant-harness';

/**
 * Gestion du personnel — invitation, CRUD, désactivation, isolation (#55).
 *
 * La suite exerce en HTTP, sur l'application réellement câblée par
 * `configureApp`, les quatre routes que #55 ajoute au contrôleur des comptes et
 * la route publique d'activation qu'il ajoute à celui de l'authentification :
 *
 * | Route | Rôle | Ce que la suite en prouve |
 * |---|---|---|
 * | `POST /users` | admin | le compte naît **sans mot de passe**, et l'invitation le désigne |
 * | `POST /users/:id/invitation` | admin | réémission possible tant que le compte n'est pas activé |
 * | `PATCH /users/:id` | manager | on modifie des coordonnées, jamais des droits |
 * | `PATCH /users/:id/status` | admin | la désactivation **n'efface rien** |
 * | `POST /auth/invitations/accept` | public | l'invitation ouvre une fois, et une seule |
 *
 * ## Ce qui distingue cette suite d'`identity-roles`
 *
 * `identity-roles.isolation-spec.ts` couvre les routes de #22 rôle par rôle.
 * Celle-ci couvre les routes de #55, avec le même protocole : chaque endpoint
 * est joué avec le jeton du **voisin**, et doit répondre 404 sans rien laisser
 * voir (tenant-isolation §6). Le cycle complet — inviter, activer, se
 * connecter — y est joué de bout en bout, parce que c'est le seul endroit où
 * l'on peut vérifier qu'un compte invité devient réellement connectable.
 *
 * Les jetons sont signés par le **vrai** `TokenService` : ce ne sont pas des
 * contrefaçons, ce sont exactement ceux qu'une connexion émettrait.
 */

/**
 * Le mot de passe que la personne invitée choisit à sa première connexion.
 *
 * Le même littéral que les autres suites d'authentification, délibérément : une
 * chaîne inédite de douze caractères et plus finit par franchir le seuil
 * d'entropie de gitleaks, qui bloque la CI sur un mot de passe de test.
 */
const CHOSEN_PASSWORD = 'correct-horse-battery';

const INVITATION = {
  email: 'nouvelle@lilas.test',
  role: 'STAFF' as const,
  firstName: 'Camille',
  lastName: 'Rakoto',
};

describe('Gestion du personnel — #55', () => {
  let harness: TenantHarness;
  let adminA: string;
  let managerA: string;
  let staffA: string;
  let clientA: string;
  let adminB: string;
  /** Un compte du personnel chez le voisin — la cible des tentatives croisées. */
  let staffB: string;

  beforeEach(async () => {
    harness = await createTenantHarness();
    adminA = (await harness.seedUser(harness.a, { email: 'admin@lilas.test', role: 'ADMIN' })).id;
    managerA = (await harness.seedUser(harness.a, { email: 'manager@lilas.test', role: 'MANAGER' }))
      .id;
    staffA = (await harness.seedUser(harness.a, { email: 'praticienne@lilas.test', role: 'STAFF' }))
      .id;
    clientA = (await harness.seedUser(harness.a, { email: 'cliente@lilas.test', role: 'CLIENT' })).id;
    adminB = (await harness.seedUser(harness.b, { email: 'admin@port.test', role: 'ADMIN' })).id;
    staffB = (await harness.seedUser(harness.b, { email: 'praticien@port.test', role: 'STAFF' })).id;
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.server();

  /**
   * Un jeton d'accès porté par un compte **réel** de l'établissement, avec le
   * rôle que ce compte porte en base.
   *
   * `harness.tokenFor` tire un `userId` au hasard, ce qui convient à un test de
   * fuite mais pas ici : `PATCH /users/:id/status` compare l'appelant à sa cible
   * pour interdire qu'un compte se désactive lui-même, et un porteur fictif
   * rendrait ce contrôle inobservable.
   *
   * Le rôle est **relu sur le compte** et non passé en paramètre : un jeton qui
   * annoncerait `ADMIN` pour le compte du manager ferait passer au vert les cas
   * de refus, en n'exerçant jamais le seuil qu'ils prétendent vérifier.
   */
  const tokenOf = async (userId: string, tenant = harness.a): Promise<string> => {
    const role = harness.identity.users.find((user) => user.id === userId)?.role;
    if (role === undefined) {
      throw new Error(`compte ${userId} absent du harnais`);
    }
    return harness.app.get(TokenService).signAccessToken({ userId, tenantId: tenant.id, role });
  };

  const bearerOf = async (userId: string, tenant = harness.a): Promise<string> =>
    `Bearer ${await tokenOf(userId, tenant)}`;

  /** Invite un membre du personnel chez A et rend la réponse `201`. */
  const invite = async (
    overrides: Partial<typeof INVITATION> = {},
  ): Promise<{ id: string; token: string }> => {
    const response = await request(server())
      .post('/api/v1/users')
      .set('Authorization', await bearerOf(adminA))
      .send({ ...INVITATION, ...overrides })
      .expect(201);

    return { id: response.body.user.id, token: response.body.invitationToken };
  };

  describe('POST /api/v1/users — inviter un membre du personnel', () => {
    it('crée le compte, le liste, et rend une invitation qui le désigne', async () => {
      const response = await request(server())
        .post('/api/v1/users')
        .set('Authorization', await bearerOf(adminA))
        .send(INVITATION)
        .expect(201);

      expect(response.body.user).toMatchObject({
        email: 'nouvelle@lilas.test',
        role: 'STAFF',
        firstName: 'Camille',
        lastName: 'Rakoto',
        phone: null,
      });
      expect(typeof response.body.invitationToken).toBe('string');
      expect(response.body.expiresIn).toBe(7 * 24 * 3600);
      // Ni empreinte, ni tenant dans le profil rendu (tenant-isolation §4).
      expect(Object.keys(response.body.user).sort()).toEqual([
        'email',
        'firstName',
        'id',
        'lastName',
        'phone',
        'role',
      ]);
      expect(JSON.stringify(response.body.user)).not.toContain(harness.a.id);

      const list = await request(server())
        .get('/api/v1/users')
        .set('Authorization', await bearerOf(adminA))
        .expect(200);
      expect(list.body.map((user: { id: string }) => user.id)).toContain(response.body.user.id);
    });

    it('normalise l’adresse — sans quoi le compte serait inconnectable', async () => {
      const response = await request(server())
        .post('/api/v1/users')
        .set('Authorization', await bearerOf(adminA))
        .send({ ...INVITATION, email: 'Nouvelle@Lilas.TEST' })
        .expect(201);

      // L'unique du schéma porte sur les octets, et `/auth/login` normalise :
      // une ligne écrite en capitales serait prise et pourtant introuvable.
      expect(response.body.user.email).toBe('nouvelle@lilas.test');

      await request(server())
        .post('/api/v1/auth/login')
        .send({
          tenantSlug: harness.a.slug,
          email: 'nouvelle@lilas.test',
          password: CHOSEN_PASSWORD,
        })
        // 401 et non 404 : le compte est bien là, il n'a simplement pas encore de
        // mot de passe. C'est ce 401-là qui prouve que l'adresse a été retrouvée.
        .expect(401);
    });

    it('refuse en 400 un rôle `CLIENT`, un champ inconnu, une adresse invalide', async () => {
      const bearer = await bearerOf(adminA);

      const roleClient = await request(server())
        .post('/api/v1/users')
        .set('Authorization', bearer)
        .send({ ...INVITATION, role: 'CLIENT' })
        .expect(400);
      expect(roleClient.body).toMatchObject({ code: 'VALIDATION_ERROR' });

      // `forbidNonWhitelisted` : un `tenantId` glissé dans le corps est refusé en
      // nommant le champ, jamais ignoré en silence — c'est le scénario de fuite
      // le plus direct (tenant-isolation §2).
      await request(server())
        .post('/api/v1/users')
        .set('Authorization', bearer)
        .send({ ...INVITATION, tenantId: harness.b.id })
        .expect(400);

      // Pas davantage de mot de passe choisi par l'administrateur : le champ
      // n'existe pas au DTO.
      await request(server())
        .post('/api/v1/users')
        .set('Authorization', bearer)
        .send({ ...INVITATION, password: CHOSEN_PASSWORD })
        .expect(400);

      await request(server())
        .post('/api/v1/users')
        .set('Authorization', bearer)
        .send({ ...INVITATION, email: 'pas-une-adresse' })
        .expect(400);
    });

    it('refuse en 409 une adresse déjà prise dans l’établissement', async () => {
      const response = await request(server())
        .post('/api/v1/users')
        .set('Authorization', await bearerOf(adminA))
        .send({ ...INVITATION, email: 'cliente@lilas.test' })
        .expect(409);

      expect(response.body.code).toBe('EMAIL_ALREADY_REGISTERED');
    });

    it('laisse la même adresse libre chez le voisin — l’unicité est par tenant', async () => {
      await invite({ email: 'partagee@exemple.test' });

      await request(server())
        .post('/api/v1/users')
        .set('Authorization', await bearerOf(adminB, harness.b))
        .send({ ...INVITATION, email: 'partagee@exemple.test' })
        .expect(201);
    });

    it('refuse manager et staff en 403, et l’anonyme en 401', async () => {
      // Les deux rangs, et pas seulement le plus proche : `@Auth('ADMIN')` est
      // une liste exacte, pas un seuil, et c'est ce que `STAFF` vérifie ici.
      for (const actor of [managerA, staffA]) {
        await request(server())
          .post('/api/v1/users')
          .set('Authorization', await bearerOf(actor))
          .send(INVITATION)
          .expect(403);
      }

      await request(server()).post('/api/v1/users').send(INVITATION).expect(401);
    });

    it('n’écrit rien chez le voisin — le tenant vient du jeton, jamais du corps', async () => {
      const before = harness.identity.users.filter((user) => user.tenantId === harness.b.id).length;

      await request(server())
        .post('/api/v1/users')
        .set('Authorization', await bearerOf(adminA))
        .send(INVITATION)
        .expect(201);

      expect(
        harness.identity.users.filter((user) => user.tenantId === harness.b.id).length,
      ).toBe(before);
    });
  });

  describe('POST /api/v1/users/:id/invitation — réémettre', () => {
    it('réémet tant que le compte n’a pas été activé', async () => {
      const invited = await invite();

      const response = await request(server())
        .post(`/api/v1/users/${invited.id}/invitation`)
        .set('Authorization', await bearerOf(adminA))
        .expect(201);

      expect(response.body.user.id).toBe(invited.id);
      expect(typeof response.body.invitationToken).toBe('string');
    });

    it('refuse en 409 un compte déjà activé', async () => {
      const invited = await invite();
      await request(server())
        .post('/api/v1/auth/invitations/accept')
        .send({ token: invited.token, password: CHOSEN_PASSWORD })
        .expect(200);

      const response = await request(server())
        .post(`/api/v1/users/${invited.id}/invitation`)
        .set('Authorization', await bearerOf(adminA))
        .expect(409);

      expect(response.body.code).toBe('INVITATION_ALREADY_ACCEPTED');
    });

    it('refuse en 422 un compte désactivé — le lien ne pourrait qu’échouer', async () => {
      const invited = await invite();
      const bearer = await bearerOf(adminA);
      await request(server())
        .patch(`/api/v1/users/${invited.id}/status`)
        .set('Authorization', bearer)
        .send({ isActive: false })
        .expect(200);

      const response = await request(server())
        .post(`/api/v1/users/${invited.id}/invitation`)
        .set('Authorization', bearer)
        .expect(422);
      expect(response.body.code).toBe('BUSINESS_RULE_VIOLATION');
    });

    it('rend 404 pour une fiche cliente, comme pour un identifiant inconnu', async () => {
      const bearer = await bearerOf(adminA);

      for (const id of [clientA, UNKNOWN_ID]) {
        const response = await request(server())
          .post(`/api/v1/users/${id}/invitation`)
          .set('Authorization', bearer);
        expectNotFoundWithoutLeak(response, { hidden: [harness.a.id, harness.b.id] });
      }
    });
  });

  describe('POST /api/v1/auth/invitations/accept — première connexion', () => {
    it('active le compte, ouvre la session, et le rend connectable', async () => {
      const invited = await invite();

      const activation = await request(server())
        .post('/api/v1/auth/invitations/accept')
        .send({ token: invited.token, password: CHOSEN_PASSWORD })
        .expect(200);

      expect(activation.body.user.id).toBe(invited.id);
      expect(typeof activation.body.accessToken).toBe('string');
      // Le jeton de rafraîchissement part en cookie `httpOnly`, jamais dans le
      // corps — l'y exposer annulerait ce que le cookie protège.
      expect(JSON.stringify(activation.body)).not.toContain('refreshToken');
      expect(String(activation.headers['set-cookie'])).toContain('HttpOnly');

      const login = await request(server())
        .post('/api/v1/auth/login')
        .send({
          tenantSlug: harness.a.slug,
          email: 'nouvelle@lilas.test',
          password: CHOSEN_PASSWORD,
        })
        .expect(200);
      expect(login.body.user.id).toBe(invited.id);
    });

    it('n’ouvre qu’une fois — le rejeu du même jeton est refusé en 401', async () => {
      const invited = await invite();
      await request(server())
        .post('/api/v1/auth/invitations/accept')
        .send({ token: invited.token, password: CHOSEN_PASSWORD })
        .expect(200);

      const rejeu = await request(server())
        .post('/api/v1/auth/invitations/accept')
        .send({ token: invited.token, password: 'un-tout-autre-mot-de-passe' })
        .expect(401);
      expect(rejeu.body.code).toBe('INVALID_INVITATION');

      // Le mot de passe posé en premier reste le bon : le rejeu n'a rien écrit.
      await request(server())
        .post('/api/v1/auth/login')
        .send({
          tenantSlug: harness.a.slug,
          email: 'nouvelle@lilas.test',
          password: CHOSEN_PASSWORD,
        })
        .expect(200);
    });

    it('refuse en 401 un jeton contrefait, et en 400 un mot de passe trop court', async () => {
      const invited = await invite();

      const contrefait = await request(server())
        .post('/api/v1/auth/invitations/accept')
        .send({ token: `${invited.token}x`, password: CHOSEN_PASSWORD })
        .expect(401);
      expect(contrefait.body.code).toBe('INVALID_INVITATION');

      await request(server())
        .post('/api/v1/auth/invitations/accept')
        .send({ token: invited.token, password: 'court' })
        .expect(400);
    });

    it('refuse un compte désactivé entre l’invitation et son acceptation', async () => {
      const invited = await invite();
      await request(server())
        .patch(`/api/v1/users/${invited.id}/status`)
        .set('Authorization', await bearerOf(adminA))
        .send({ isActive: false })
        .expect(200);

      const response = await request(server())
        .post('/api/v1/auth/invitations/accept')
        .send({ token: invited.token, password: CHOSEN_PASSWORD })
        .expect(401);
      expect(response.body.code).toBe('INVALID_INVITATION');
    });
  });

  describe('PATCH /api/v1/users/:id — coordonnées d’un membre', () => {
    it('laisse passer manager et admin, refuse staff et client', async () => {
      for (const actor of [managerA, adminA]) {
        const response = await request(server())
          .patch(`/api/v1/users/${staffA}`)
          .set('Authorization', await bearerOf(actor))
          .send({ firstName: 'Camille' })
          .expect(200);
        expect(response.body.firstName).toBe('Camille');
      }

      // Le seuil est déclaré par route : `STAFF` lit le trombinoscope, il ne
      // modifie pas le compte d'autrui.
      const staffToken = await harness.app
        .get(TokenService)
        .signAccessToken({ userId: staffA, tenantId: harness.a.id, role: 'STAFF' });
      await request(server())
        .patch(`/api/v1/users/${staffA}`)
        .set('Authorization', `Bearer ${staffToken}`)
        .send({ firstName: 'Camille' })
        .expect(403);
    });

    it('ne laisse écrire ni rôle, ni activation, ni adresse', async () => {
      const bearer = await bearerOf(adminA);

      for (const body of [{ role: 'ADMIN' }, { isActive: false }, { email: 'x@lilas.test' }]) {
        await request(server())
          .patch(`/api/v1/users/${staffA}`)
          .set('Authorization', bearer)
          .send(body)
          .expect(400);
      }

      expect(harness.identity.users.find((user) => user.id === staffA)?.role).toBe('STAFF');
    });

    it('rend 404 pour une fiche cliente', async () => {
      const response = await request(server())
        .patch(`/api/v1/users/${clientA}`)
        .set('Authorization', await bearerOf(adminA))
        .send({ firstName: 'Camille' });

      expectNotFoundWithoutLeak(response, { hidden: [harness.a.id, harness.b.id] });
    });
  });

  describe('PATCH /api/v1/users/:id/status — désactiver sans supprimer', () => {
    it('désactive, révoque les sessions, et **conserve** le compte', async () => {
      const response = await request(server())
        .patch(`/api/v1/users/${staffA}/status`)
        .set('Authorization', await bearerOf(adminA))
        .send({ isActive: false })
        .expect(200);

      expect(response.body).toMatchObject({ id: staffA, isActive: false });

      // Le critère du CDC : « désactivation d'un compte **sans suppression des
      // rendez-vous passés** ». La ligne survit — donc tout ce qui la référence
      // aussi — et la route de lecture le confirme.
      const relu = await request(server())
        .get(`/api/v1/users/${staffA}`)
        .set('Authorization', await bearerOf(adminA))
        .expect(200);
      expect(relu.body.id).toBe(staffA);
      expect(harness.identity.users.some((user) => user.id === staffA)).toBe(true);
    });

    it('ferme la connexion du compte désactivé, et la rouvre à la réactivation', async () => {
      const invited = await invite();
      await request(server())
        .post('/api/v1/auth/invitations/accept')
        .send({ token: invited.token, password: CHOSEN_PASSWORD })
        .expect(200);

      const credentials = {
        tenantSlug: harness.a.slug,
        email: 'nouvelle@lilas.test',
        password: CHOSEN_PASSWORD,
      };
      const bearer = await bearerOf(adminA);

      await request(server())
        .patch(`/api/v1/users/${invited.id}/status`)
        .set('Authorization', bearer)
        .send({ isActive: false })
        .expect(200);
      const refuse = await request(server())
        .post('/api/v1/auth/login')
        .send(credentials)
        .expect(401);
      // Le message ne dit pas « compte désactivé » : ce serait un oracle de plus.
      expect(refuse.body.code).toBe('INVALID_CREDENTIALS');

      await request(server())
        .patch(`/api/v1/users/${invited.id}/status`)
        .set('Authorization', bearer)
        .send({ isActive: true })
        .expect(200);
      await request(server()).post('/api/v1/auth/login').send(credentials).expect(200);
    });

    it('refuse en 422 qu’un administrateur se désactive lui-même', async () => {
      const response = await request(server())
        .patch(`/api/v1/users/${adminA}/status`)
        .set('Authorization', await bearerOf(adminA))
        .send({ isActive: false })
        .expect(422);

      expect(response.body.code).toBe('BUSINESS_RULE_VIOLATION');
      expect(harness.identity.users.find((user) => user.id === adminA)?.isActive).toBe(true);
    });

    it('refuse en 400 un corps sans `isActive` — l’opération n’est pas une bascule', async () => {
      await request(server())
        .patch(`/api/v1/users/${staffA}/status`)
        .set('Authorization', await bearerOf(adminA))
        .send({})
        .expect(400);
    });

    it('refuse manager en 403 — fermer un accès est une décision sur les droits', async () => {
      await request(server())
        .patch(`/api/v1/users/${staffA}/status`)
        .set('Authorization', await bearerOf(managerA))
        .send({ isActive: false })
        .expect(403);
    });

    it('rend 404 pour une fiche cliente — la clientèle relève de `crm`', async () => {
      const response = await request(server())
        .patch(`/api/v1/users/${clientA}/status`)
        .set('Authorization', await bearerOf(adminA))
        .send({ isActive: false });

      expectNotFoundWithoutLeak(response, { hidden: [harness.a.id, harness.b.id] });
    });
  });

  /**
   * Le protocole de tenant-isolation §6, joué sur les quatre routes de #55 :
   * créer chez A, s'authentifier comme B, tenter par identifiant, attendre 404
   * sur toutes, et vérifier que la ressource de A est intacte.
   */
  describe('frontière du tenant — 404 sur toute tentative croisée', () => {
    it('un administrateur du voisin n’atteint aucun compte de A', async () => {
      const bearerB = await bearerOf(adminB, harness.b);

      await expectCrossTenantNotFound({
        attempts: [
          {
            label: 'réémission d’invitation',
            send: () =>
              request(server())
                .post(`/api/v1/users/${staffA}/invitation`)
                .set('Authorization', bearerB),
          },
          {
            label: 'modification des coordonnées',
            send: () =>
              request(server())
                .patch(`/api/v1/users/${staffA}`)
                .set('Authorization', bearerB)
                .send({ firstName: 'Intruse' }),
          },
          {
            label: 'désactivation',
            send: () =>
              request(server())
                .patch(`/api/v1/users/${staffA}/status`)
                .set('Authorization', bearerB)
                .send({ isActive: false }),
          },
        ],
        hidden: [harness.a.id, 'lilas.test'],
        // Pas 4 : le refus ne suffit pas, encore faut-il que rien n'ait été écrit
        // chez A avant que le 404 ne parte.
        intact: () => harness.identity.users.find((user) => user.id === staffA),
      });
    });

    it('le refus est identique pour « connu ailleurs » et « inconnu partout »', async () => {
      // La différence entre les deux est précisément l'information à ne pas
      // donner (tenant-isolation §4).
      const bearerB = await bearerOf(adminB, harness.b);

      const ailleurs = await request(server())
        .patch(`/api/v1/users/${staffA}`)
        .set('Authorization', bearerB)
        .send({ firstName: 'Intruse' });
      const inconnu = await request(server())
        .patch(`/api/v1/users/${UNKNOWN_ID}`)
        .set('Authorization', bearerB)
        .send({ firstName: 'Intruse' });

      expect(ailleurs.status).toBe(inconnu.status);
      expect(ailleurs.body).toEqual(inconnu.body);
    });

    it('une invitation signée pour A n’active rien chez B, et réciproquement', async () => {
      const invited = await invite();

      // Le `tenantId` est une revendication **signée** : le jeton ouvre la portée
      // de A, quel que soit l'établissement depuis lequel on le présente. Ce que
      // la suite vérifie ici est qu'aucun compte de B n'en subit l'effet.
      await request(server())
        .post('/api/v1/auth/invitations/accept')
        .send({ token: invited.token, password: CHOSEN_PASSWORD })
        .expect(200);

      expect(harness.identity.users.find((user) => user.id === staffB)?.passwordHash).toBeNull();
      expect(harness.identity.users.find((user) => user.id === adminB)?.passwordHash).toBeNull();
    });

    it('la liste du personnel de A ne montre aucun compte du voisin', async () => {
      await invite();
      const list = await request(server())
        .get('/api/v1/users')
        .set('Authorization', await bearerOf(adminA))
        .expect(200);

      const serialized = JSON.stringify(list.body);
      expect(serialized).not.toContain(staffB);
      expect(serialized).not.toContain(adminB);
      expect(serialized).not.toContain('port.test');
      expect(serialized).not.toContain(harness.a.id);
      expect(serialized).not.toContain(harness.b.id);
    });
  });
});
