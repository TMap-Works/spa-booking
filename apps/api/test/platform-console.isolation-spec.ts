import type { INestApplication } from '@nestjs/common';
import request from 'supertest';

import { PasswordHasher } from '../src/modules/identity/password.hasher';
import { PlatformRepository } from '../src/modules/identity/platform/platform.repository';
import { FakePlatformRepository } from '../src/modules/identity/platform/__tests__/platform.doubles';
import { generateTotpSecret, totpCodeAt } from '../src/modules/identity/platform/totp';
import { createTenantHarness, type TenantHarness } from './utils/tenant-harness';

/**
 * Étanchéité des deux espaces — **critère 5 de #806**, en HTTP.
 *
 * L'énoncé du critère est littéral, et c'est le seul de ce ticket qui décrive
 * un comportement dans les deux sens :
 *
 * > - un jeton d'établissement, même ADMIN, reçoit 401 sur toute route
 * >   `/v1/platform/*` ;
 * > - un jeton plateforme reçoit 401 sur toute route d'établissement.
 *
 * La suite l'exerce sur l'application **réellement câblée** par `configureApp` :
 * les jetons ne sont pas des contrefaçons, ce sont exactement ceux qu'une
 * connexion émettrait de chaque côté.
 *
 * ## Pourquoi 401 et non 403
 *
 * Parce que ce qui est refusé n'est pas un droit, c'est une **preuve de
 * qualité** : le jeton présenté n'est pas lisible par le vérificateur de
 * l'espace visé — clé différente, `typ` différent. Il n'y a donc aucune identité
 * à qui refuser quoi que ce soit, et un 403 aurait par ailleurs confirmé que la
 * route existe pour quelqu'un d'autre.
 *
 * ## Ce que la suite substitue, et ce qu'elle n'substitue pas
 *
 * `PlatformRepository` est remplacé par son double en mémoire — le harnais
 * n'ouvre aucune base. Tout le reste est réel : la garde, le service de jetons,
 * la vérification TOTP, le pipe de validation et le filtre d'exception. C'est
 * exactement ce qu'il faut pour un test de frontière : ce qui est éprouvé est le
 * câblage, pas le stockage.
 */

const PASSWORD = 'correct-horse-battery';
const PLATFORM_TENANTS = '/api/v1/platform/tenants';

describe('Console plateforme — étanchéité des deux espaces (#806)', () => {
  let harness: TenantHarness;
  let platform: FakePlatformRepository;
  let totpSecret: string;

  beforeEach(async () => {
    platform = new FakePlatformRepository();
    harness = await createTenantHarness({
      overrides: [{ provide: PlatformRepository, useValue: platform }],
    });

    // L'empreinte est posée par le **vrai** `PasswordHasher`, celui que
    // l'application injecte : le coût bcrypt et la vérification sont donc ceux
    // de la production.
    const hasher = harness.app.get(PasswordHasher);
    totpSecret = generateTotpSecret();
    platform.addOperator({
      email: 'operateur@tmap-works.test',
      passwordHash: await hasher.hash(PASSWORD),
      totpSecret,
    });
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.server();

  /** Un jeton de console, obtenu par la **vraie** route de connexion. */
  const platformToken = async (): Promise<string> => {
    const response = await request(server())
      .post('/api/v1/platform/auth/login')
      .send({
        email: 'operateur@tmap-works.test',
        password: PASSWORD,
        totpCode: totpCodeAt(totpSecret, Date.now()) ?? '',
      })
      .expect(200);

    return (response.body as { accessToken: string }).accessToken;
  };

  describe('un jeton d’établissement n’ouvre aucune route de console', () => {
    it.each(['ADMIN', 'MANAGER', 'STAFF', 'CLIENT'] as const)(
      'refuse le rôle %s en 401 sur POST /platform/tenants',
      async (role) => {
        await request(server())
          .post(PLATFORM_TENANTS)
          .set('Authorization', await harness.bearer(role))
          .set('Idempotency-Key', 'une-cle-de-test-0001')
          .send({ slug: 'maison-lotus' })
          .expect(401);
      },
    );

    it('refuse un jeton ADMIN en 401 sur GET /platform/tenants', async () => {
      const response = await request(server())
        .get(PLATFORM_TENANTS)
        .set('Authorization', await harness.bearer('ADMIN'))
        .expect(401);

      // Rien du corps ne doit laisser entendre qu'une autre identité y aurait
      // droit : un message qui nommerait « opérateur plateforme » dirait déjà
      // trop.
      expect((response.body as { code: string }).code).toBe('UNAUTHORIZED');
    });

    it('refuse un jeton ADMIN en 401 sur la réémission d’invitation', async () => {
      await request(server())
        .post(`${PLATFORM_TENANTS}/99999999-9999-4999-8999-999999999999/invitation`)
        .set('Authorization', await harness.bearer('ADMIN'))
        .expect(401);
    });

    it('refuse aussi l’absence totale de jeton', async () => {
      await request(server()).get(PLATFORM_TENANTS).expect(401);
    });
  });

  describe('un jeton plateforme n’ouvre aucune route d’établissement', () => {
    it('reçoit 401 sur GET /users', async () => {
      await request(server())
        .get('/api/v1/users')
        .set('Authorization', `Bearer ${await platformToken()}`)
        .expect(401);
    });

    it('reçoit 401 sur GET /auth/me', async () => {
      await request(server())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${await platformToken()}`)
        .expect(401);
    });

    it('reçoit 401 sur le réglage de l’établissement', async () => {
      await request(server())
        .get('/api/v1/tenant')
        .set('Authorization', `Bearer ${await platformToken()}`)
        .expect(401);
    });

    it('ne peut pas non plus servir de jeton d’invitation', async () => {
      // Le troisième usage de jeton du produit : si la dérivation de clés était
      // mal faite, c'est ici que cela se verrait — un jeton de console posant le
      // mot de passe d'un compte de salon.
      await request(server())
        .post('/api/v1/auth/invitations/accept')
        .send({ token: await platformToken(), password: PASSWORD })
        .expect(401);
    });
  });

  describe('la console, avec son propre jeton', () => {
    it('refuse la connexion sans le second facteur', async () => {
      await request(server())
        .post('/api/v1/platform/auth/login')
        .send({ email: 'operateur@tmap-works.test', password: PASSWORD, totpCode: '000000' })
        .expect(401);
    });

    it('refuse une connexion dont le code n’a pas la bonne forme — 400', async () => {
      const response = await request(server())
        .post('/api/v1/platform/auth/login')
        .send({ email: 'operateur@tmap-works.test', password: PASSWORD, totpCode: 'abc' })
        .expect(400);

      expect((response.body as { code: string }).code).toBe('VALIDATION_ERROR');
    });

    it('ouvre un établissement et rend les trois liens', async () => {
      const response = await request(server())
        .post(PLATFORM_TENANTS)
        .set('Authorization', `Bearer ${await platformToken()}`)
        .set('Idempotency-Key', 'ouverture-maison-lotus-01')
        .send({
          slug: 'maison-lotus',
          name: 'Maison Lotus',
          timezone: 'Europe/Paris',
          defaultCurrency: 'EUR',
          countryCode: 'FR',
          addressLine1: '12 rue des Lilas',
          postalCode: '75011',
          city: 'Paris',
          adminEmail: 'gerante@maison-lotus.test',
          adminFirstName: 'Alice',
          adminLastName: 'Durand',
        })
        .expect(201);

      const body = response.body as {
        replayed: boolean;
        tenant: { slug: string };
        links: { bookingUrl: string; adminLoginUrl: string; adminInvitationUrl: string };
      };

      expect(body.replayed).toBe(false);
      expect(body.tenant.slug).toBe('maison-lotus');
      expect(body.links.bookingUrl).toContain('/reservation');
      expect(body.links.adminLoginUrl).toContain('/admin/connexion');
      expect(body.links.adminInvitationUrl).toContain('token=');
    });

    it('refuse une ouverture sans en-tête `Idempotency-Key` — 400', async () => {
      const response = await request(server())
        .post(PLATFORM_TENANTS)
        .set('Authorization', `Bearer ${await platformToken()}`)
        .send({
          slug: 'maison-lotus',
          name: 'Maison Lotus',
          timezone: 'Europe/Paris',
          defaultCurrency: 'EUR',
          countryCode: 'FR',
          addressLine1: '12 rue des Lilas',
          city: 'Paris',
          adminEmail: 'gerante@maison-lotus.test',
          adminFirstName: 'Alice',
          adminLastName: 'Durand',
        })
        .expect(400);

      expect((response.body as { code: string }).code).toBe('VALIDATION_ERROR');
    });

    it('refuse un `tenantId` glissé dans le corps — 400', async () => {
      // `forbidNonWhitelisted` rend l'omission exécutoire : un salon ne naît pas
      // sous un identifiant que l'appelant aurait choisi (tenant-isolation §2).
      await request(server())
        .post(PLATFORM_TENANTS)
        .set('Authorization', `Bearer ${await platformToken()}`)
        .set('Idempotency-Key', 'ouverture-maison-lotus-02')
        .send({
          slug: 'maison-lotus',
          name: 'Maison Lotus',
          timezone: 'Europe/Paris',
          defaultCurrency: 'EUR',
          countryCode: 'FR',
          addressLine1: '12 rue des Lilas',
          city: 'Paris',
          adminEmail: 'gerante@maison-lotus.test',
          adminFirstName: 'Alice',
          adminLastName: 'Durand',
          tenantId: '11111111-1111-4111-8111-111111111111',
        })
        .expect(400);
    });

    it('refuse un fuseau que le moteur ne résout pas — 400', async () => {
      await request(server())
        .post(PLATFORM_TENANTS)
        .set('Authorization', `Bearer ${await platformToken()}`)
        .set('Idempotency-Key', 'ouverture-maison-lotus-03')
        .send({
          slug: 'maison-lotus',
          name: 'Maison Lotus',
          timezone: 'Pas/UnFuseau',
          defaultCurrency: 'EUR',
          countryCode: 'FR',
          addressLine1: '12 rue des Lilas',
          city: 'Paris',
          adminEmail: 'gerante@maison-lotus.test',
          adminFirstName: 'Alice',
          adminLastName: 'Durand',
        })
        .expect(400);
    });

    it('rejouée sous la même clé, l’ouverture rend le même établissement', async () => {
      const token = `Bearer ${await platformToken()}`;
      const payload = {
        slug: 'maison-lotus',
        name: 'Maison Lotus',
        timezone: 'Europe/Paris',
        defaultCurrency: 'EUR',
        countryCode: 'FR',
        addressLine1: '12 rue des Lilas',
        city: 'Paris',
        adminEmail: 'gerante@maison-lotus.test',
        adminFirstName: 'Alice',
        adminLastName: 'Durand',
      };

      const first = await request(server())
        .post(PLATFORM_TENANTS)
        .set('Authorization', token)
        .set('Idempotency-Key', 'ouverture-maison-lotus-04')
        .send(payload)
        .expect(201);

      const replay = await request(server())
        .post(PLATFORM_TENANTS)
        .set('Authorization', token)
        .set('Idempotency-Key', 'ouverture-maison-lotus-04')
        .send({ ...payload, slug: 'un-tout-autre-nom' })
        .expect(201);

      expect((replay.body as { replayed: boolean }).replayed).toBe(true);
      expect((replay.body as { tenant: { id: string } }).tenant.id).toBe(
        (first.body as { tenant: { id: string } }).tenant.id,
      );
    });

    it('refuse un nom d’adresse réservé — 409 `TENANT_SLUG_TAKEN`', async () => {
      const response = await request(server())
        .post(PLATFORM_TENANTS)
        .set('Authorization', `Bearer ${await platformToken()}`)
        .set('Idempotency-Key', 'ouverture-reservee-01')
        .send({
          slug: 'www',
          name: 'Maison Lotus',
          timezone: 'Europe/Paris',
          defaultCurrency: 'EUR',
          countryCode: 'FR',
          addressLine1: '12 rue des Lilas',
          city: 'Paris',
          adminEmail: 'gerante@maison-lotus.test',
          adminFirstName: 'Alice',
          adminLastName: 'Durand',
        })
        .expect(409);

      expect((response.body as { code: string }).code).toBe('TENANT_SLUG_TAKEN');
    });

    it('liste les établissements, page par page', async () => {
      platform.addTenant({ slug: 'salon-des-lilas' });

      const response = await request(server())
        .get(`${PLATFORM_TENANTS}?page=1&pageSize=10`)
        .set('Authorization', `Bearer ${await platformToken()}`)
        .expect(200);

      const body = response.body as { items: { slug: string }[]; totalItems: number };
      expect(body.totalItems).toBe(1);
      expect(body.items[0]?.slug).toBe('salon-des-lilas');
    });

    it('refuse une pagination hors bornes — 400', async () => {
      await request(server())
        .get(`${PLATFORM_TENANTS}?pageSize=100000`)
        .set('Authorization', `Bearer ${await platformToken()}`)
        .expect(400);
    });

    it('réémet l’invitation de l’administrateur d’un établissement', async () => {
      const tenant = platform.addTenant({ slug: 'salon-des-lilas' });

      const response = await request(server())
        .post(`${PLATFORM_TENANTS}/${tenant.id}/invitation`)
        .set('Authorization', `Bearer ${await platformToken()}`)
        .expect(201);

      const body = response.body as { tenantId: string; links: { adminInvitationUrl: string } };
      expect(body.tenantId).toBe(tenant.id);
      expect(body.links.adminInvitationUrl).toContain('token=');
    });

    it('rend 404 sur un établissement inconnu', async () => {
      await request(server())
        .post(`${PLATFORM_TENANTS}/99999999-9999-4999-8999-999999999999/invitation`)
        .set('Authorization', `Bearer ${await platformToken()}`)
        .expect(404);
    });
  });
});
