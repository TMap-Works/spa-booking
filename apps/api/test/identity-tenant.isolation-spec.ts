import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { REFRESH_COOKIE_NAME } from '../src/modules/identity/refresh-cookie';
import { TokenService } from '../src/modules/identity/token.service';
import { expectCrossTenantNotFound } from './utils/tenant-assertions';
import { createTenantHarness, TENANT_A, TENANT_B, type TenantHarness } from './utils/tenant-harness';

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
 * de tenant se voit. Les deux établissements, l'application et les jetons
 * viennent du harnais partagé (`utils/tenant-harness.ts`, #27) ; cette suite ne
 * décrit plus que ce qui lui est propre — deux comptes homonymes et leurs mots
 * de passe.
 */

const SALON_A = TENANT_A.slug;
const SALON_B = TENANT_B.slug;
const EMAIL = 'alice@example.test';
const PASSWORD_A = 'mot-de-passe-du-salon-a';
const PASSWORD_B = 'mot-de-passe-du-barbier';

describe('Isolation inter-tenant — module identity', () => {
  let harness: TenantHarness;
  /** Le compte du salon A — `CLIENT`. */
  let userA: string;
  /** Le compte homonyme du barbier — `ADMIN`, pour que la traversée se voie. */
  let userB: string;

  beforeEach(async () => {
    harness = await createTenantHarness();
    userA = (await harness.seedUser(harness.a, { email: EMAIL, password: PASSWORD_A })).id;
    userB = (
      await harness.seedUser(harness.b, { email: EMAIL, password: PASSWORD_B, role: 'ADMIN' })
    ).id;
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.server();

  const login = async (slug: string, password: string): Promise<request.Response> =>
    request(server())
      .post('/api/v1/auth/login')
      .send({ tenantSlug: slug, email: EMAIL, password })
      .expect(200);

  it('la même adresse désigne deux comptes distincts dans deux établissements', async () => {
    const a = await login(SALON_A, PASSWORD_A);
    const b = await login(SALON_B, PASSWORD_B);

    expect(a.body.user.id).toBe(userA);
    expect(b.body.user.id).toBe(userB);
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

    expect(profile.body.id).toBe(userA);
    expect(profile.body.id).not.toBe(userB);
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
      userId: userA,
      tenantId: harness.b.id,
      role: 'CLIENT',
    });

    // 404 et non 403 : un 403 confirmerait que ce compte existe quelque part.
    // L'assertion partagée (#27) exige les deux à la fois — le code, et
    // l'absence de l'identifiant dans le corps, qui sert de miroir à un
    // attaquant.
    await expectCrossTenantNotFound({
      attempts: [
        {
          label: 'lecture du profil sous un jeton croisé',
          send: () =>
            request(server()).get('/api/v1/auth/me').set('Authorization', `Bearer ${croise}`),
        },
      ],
      hidden: [userA, harness.a.id],
    });
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

    const sessions = harness.identity.sessions;
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
      expect(JSON.stringify(body)).not.toContain(harness.a.id);
      expect(JSON.stringify(body)).not.toContain(harness.b.id);
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
