import type { INestApplication } from '@nestjs/common';

import request from 'supertest';

import { createCrmHarness, type CrmHarness } from './crm.harness';

/**
 * Le fichier client, exercé en HTTP sur l'application réellement câblée (#56).
 *
 * Ce que cette suite prouve et que les tests unitaires ne peuvent pas :
 *
 * - **les six routes sont servies** — un contrôleur oublié dans les
 *   `controllers` de son module compile, passe ses tests unitaires, et rend 404
 *   en vrai ;
 * - **les gardes sont montées** — `@AuthAtLeast('STAFF')` sans jeton rend 401,
 *   avec un jeton `CLIENT` rend 403, et la désactivation exige `MANAGER` ;
 * - **le `ValidationPipe` global mord** — `forbidNonWhitelisted` refuse en 400
 *   un `tenantId`, un `role` ou un `isActive` glissés dans un corps ;
 * - **la sérialisation est celle du contrat** — instants en UTC suffixés `Z`,
 *   montant + devise, `null` explicite sur les champs vides.
 *
 * La traversée inter-tenant, elle, vit dans `crm-tenant.isolation-spec.ts` :
 * c'est un protocole à part, avec ses propres assertions.
 */

const BASE = '/api/v1/customers';

describe('CRM — fichier client', () => {
  let harness: CrmHarness;

  beforeEach(async () => {
    harness = await createCrmHarness();
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.app.getHttpServer();

  /** Crée une fiche par la route, et rend son corps. */
  async function creerFiche(
    overrides: Record<string, unknown> = {},
  ): Promise<Record<string, unknown>> {
    const response = await request(server())
      .post(BASE)
      .set('Authorization', await harness.bearer('STAFF'))
      .send({
        email: 'alice@example.test',
        firstName: 'Alice',
        lastName: 'Durand',
        phone: '+261 34 12 345 67',
        ...overrides,
      })
      .expect(201);

    return response.body as Record<string, unknown>;
  }

  describe('POST /customers', () => {
    it('crée une fiche et rend son identifiant, sa note et sa date de création', async () => {
      const fiche = await creerFiche({ internalNote: 'allergique au monoï' });

      expect(fiche).toMatchObject({
        firstName: 'Alice',
        lastName: 'Durand',
        email: 'alice@example.test',
        phone: '+261 34 12 345 67',
        isActive: true,
        internalNote: 'allergique au monoï',
      });
      // Instant UTC suffixé `Z` — un seul référentiel (ADR 0006).
      expect(fiche['createdAt']).toMatch(/Z$/);
    });

    it('canonise l’adresse à l’écriture', async () => {
      const fiche = await creerFiche({ email: '  Alice@EXAMPLE.test ' });

      // Sans cette canonisation, la connexion — qui normalise — ne retrouverait
      // jamais la ligne créée ici.
      expect(fiche['email']).toBe('alice@example.test');
    });

    it('refuse une adresse déjà prise dans cet établissement', async () => {
      await creerFiche();

      const response = await request(server())
        .post(BASE)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({ email: 'ALICE@example.test', firstName: 'Alice', lastName: 'Durand' })
        .expect(409);

      expect(response.body).toMatchObject({ code: 'CUSTOMER_EMAIL_TAKEN' });
      // Le corps d'erreur ne recopie pas l'adresse : c'est de là qu'elle
      // repartirait vers un journal d'accès ou un ticket (CDC §5.1).
      expect(JSON.stringify(response.body)).not.toContain('alice@example.test');
    });

    it('refuse en 400 un corps invalide, en nommant le champ', async () => {
      const response = await request(server())
        .post(BASE)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({ email: 'pas-une-adresse', firstName: '', lastName: 'Durand' })
        .expect(400);

      expect(response.body).toMatchObject({ code: expect.any(String) });
      expect(JSON.stringify(response.body)).toContain('email');
    });

    it.each([
      ['tenantId', { tenantId: '11111111-1111-4111-8111-111111111111' }],
      ['role', { role: 'ADMIN' }],
      ['isActive', { isActive: false }],
    ])('refuse en 400 un `%s` glissé dans le corps', async (_champ, intrus) => {
      await request(server())
        .post(BASE)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({ email: 'bob@example.test', firstName: 'Bob', lastName: 'Martin', ...intrus })
        .expect(400);
    });
  });

  describe('GET /customers', () => {
    it('rend une page vide avec « page 1 sur 0 » sur un fichier vide', async () => {
      const response = await request(server())
        .get(BASE)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expect(response.body).toEqual({
        items: [],
        page: 1,
        pageSize: 20,
        totalItems: 0,
        totalPages: 0,
      });
    });

    it('cherche par préfixe de nom, d’adresse et de numéro', async () => {
      await creerFiche();
      await creerFiche({
        email: 'bruno@example.test',
        firstName: 'Bruno',
        lastName: 'Duval',
        phone: '+261 34 99 999 99',
      });
      await creerFiche({
        email: 'chloe@example.test',
        firstName: 'Chloé',
        lastName: 'Martin',
        phone: undefined,
      });

      const parNom = await request(server())
        .get(BASE)
        .query({ q: 'DU' })
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);
      expect((parNom.body as { items: { lastName: string }[] }).items.map((i) => i.lastName)).toEqual(
        ['Durand', 'Duval'],
      );

      const parEmail = await request(server())
        .get(BASE)
        .query({ q: 'chloe@' })
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);
      expect((parEmail.body as { totalItems: number }).totalItems).toBe(1);

      const parNumero = await request(server())
        .get(BASE)
        .query({ q: '+261 34 99' })
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);
      expect((parNumero.body as { totalItems: number }).totalItems).toBe(1);
    });

    it('n’expose aucune note interne dans la liste', async () => {
      await creerFiche({ internalNote: 'allergique au monoï' });

      const response = await request(server())
        .get(BASE)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expect(JSON.stringify(response.body)).not.toContain('monoï');
    });

    it('masque les fiches désactivées, sauf demande explicite', async () => {
      const fiche = await creerFiche();
      await request(server())
        .patch(`${BASE}/${String(fiche['id'])}/status`)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ isActive: false })
        .expect(200);

      const parDefaut = await request(server())
        .get(BASE)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);
      expect((parDefaut.body as { totalItems: number }).totalItems).toBe(0);

      const avecInactives = await request(server())
        .get(BASE)
        .query({ includeInactive: 'true' })
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);
      expect((avecInactives.body as { totalItems: number }).totalItems).toBe(1);
    });

    it('refuse un terme d’une seule lettre et une page hors bornes', async () => {
      const bearer = await harness.bearer('STAFF');

      await request(server()).get(BASE).query({ q: 'a' }).set('Authorization', bearer).expect(400);
      await request(server()).get(BASE).query({ page: 0 }).set('Authorization', bearer).expect(400);
      // Plafond serveur : `?pageSize=100000` serait un déni de service à une requête.
      await request(server())
        .get(BASE)
        .query({ pageSize: 1000 })
        .set('Authorization', bearer)
        .expect(400);
    });
  });

  describe('GET /customers/:id', () => {
    it('rend la fiche complète, note interne comprise', async () => {
      const creee = await creerFiche({ internalNote: 'allergique au monoï' });

      const response = await request(server())
        .get(`${BASE}/${String(creee['id'])}`)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expect(response.body).toMatchObject({ internalNote: 'allergique au monoï' });
    });

    it('rend 404 sur un identifiant inconnu et 400 sur un identifiant mal formé', async () => {
      const bearer = await harness.bearer('STAFF');

      const inconnu = await request(server())
        .get(`${BASE}/99999999-9999-4999-8999-999999999999`)
        .set('Authorization', bearer)
        .expect(404);
      expect(inconnu.body).toMatchObject({ code: 'NOT_FOUND' });

      await request(server()).get(`${BASE}/pas-un-uuid`).set('Authorization', bearer).expect(400);
    });

    it('rend 404 sur un compte du personnel — le fichier client n’est pas le trombinoscope', async () => {
      const praticienne = harness.repository.addCustomer({
        tenantId: harness.tenantId,
        role: 'STAFF',
        email: 'camille@salon.test',
      });

      await request(server())
        .get(`${BASE}/${praticienne.id}`)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(404);
    });
  });

  describe('PATCH /customers/:id', () => {
    it('modifie les champs présents et laisse les autres en place', async () => {
      const creee = await creerFiche({ internalNote: 'allergique au monoï' });

      const response = await request(server())
        .patch(`${BASE}/${String(creee['id'])}`)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({ lastName: 'Martin' })
        .expect(200);

      expect(response.body).toMatchObject({
        firstName: 'Alice',
        lastName: 'Martin',
        phone: '+261 34 12 345 67',
        internalNote: 'allergique au monoï',
      });
    });

    it('efface le numéro et la note sur `null`', async () => {
      const creee = await creerFiche({ internalNote: 'allergique au monoï' });

      const response = await request(server())
        .patch(`${BASE}/${String(creee['id'])}`)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({ phone: null, internalNote: null })
        .expect(200);

      expect(response.body).toMatchObject({ phone: null, internalNote: null });
    });

    it.each([
      ['email', { email: 'autre@example.test' }],
      ['role', { role: 'ADMIN' }],
      ['isActive', { isActive: false }],
    ])('refuse en 400 un `%s` glissé dans le corps', async (_champ, intrus) => {
      const creee = await creerFiche();

      await request(server())
        .patch(`${BASE}/${String(creee['id'])}`)
        .set('Authorization', await harness.bearer('STAFF'))
        .send(intrus)
        .expect(400);
    });
  });

  describe('PATCH /customers/:id/status', () => {
    it('désactive sans supprimer, et reste idempotent', async () => {
      const creee = await creerFiche();
      const bearer = await harness.bearer('MANAGER');

      const premiere = await request(server())
        .patch(`${BASE}/${String(creee['id'])}/status`)
        .set('Authorization', bearer)
        .send({ isActive: false })
        .expect(200);
      expect(premiere.body).toMatchObject({ isActive: false });

      const seconde = await request(server())
        .patch(`${BASE}/${String(creee['id'])}/status`)
        .set('Authorization', bearer)
        .send({ isActive: false })
        .expect(200);
      expect(seconde.body).toMatchObject({ isActive: false });

      // La ligne est toujours là — il n'y a pas de suppression sur cette
      // ressource, et les clés étrangères en `Restrict` l'interdiraient.
      expect(harness.repository.customers).toHaveLength(1);
    });

    it('exige le booléen plutôt que de basculer', async () => {
      const creee = await creerFiche();

      await request(server())
        .patch(`${BASE}/${String(creee['id'])}/status`)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({})
        .expect(400);
    });

    it('n’offre aucun `DELETE` sur la ressource', async () => {
      const creee = await creerFiche();

      // 404 : la route n'existe pas. Un `DELETE` qui n'effacerait rien mentirait
      // au client autant qu'au relecteur.
      await request(server())
        .delete(`${BASE}/${String(creee['id'])}`)
        .set('Authorization', await harness.bearer('MANAGER'))
        .expect(404);
    });
  });

  describe('GET /customers/:id/history', () => {
    it('agrège sur la totalité et ne liste que la fenêtre demandée', async () => {
      const fiche = harness.repository.addCustomer({ tenantId: harness.tenantId });

      for (let index = 0; index < 4; index += 1) {
        harness.repository.addVisit({
          tenantId: harness.tenantId,
          clientId: fiche.id,
          status: 'COMPLETED',
          startsAt: new Date(Date.UTC(2026, 0, index + 1, 9)),
          priceAmountMinor: 1000,
        });
      }
      harness.repository.addVisit({
        tenantId: harness.tenantId,
        clientId: fiche.id,
        status: 'NO_SHOW',
        startsAt: new Date(Date.UTC(2026, 1, 1, 9)),
      });

      const response = await request(server())
        .get(`${BASE}/${fiche.id}/history`)
        .query({ limit: 2 })
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      const body = response.body as {
        summary: Record<string, unknown>;
        visits: { startsAt: string }[];
      };

      expect(body.summary).toEqual({
        totalVisits: 5,
        honoredVisits: 4,
        cancelledVisits: 0,
        noShowVisits: 1,
        upcomingVisits: 0,
        firstVisitAt: '2026-01-01T09:00:00.000Z',
        lastVisitAt: '2026-01-04T09:00:00.000Z',
        totalSpent: { amountMinor: 4000, currency: 'EUR' },
      });
      // La fenêtre est bornée, l'agrégat non — c'est la propriété centrale.
      expect(body.visits).toHaveLength(2);
      expect(body.visits.map((visit) => visit.startsAt)).toEqual([
        '2026-02-01T09:00:00.000Z',
        '2026-01-04T09:00:00.000Z',
      ]);
    });

    it('rend un agrégat vide sans inventer un total à zéro', async () => {
      const creee = await creerFiche();

      const response = await request(server())
        .get(`${BASE}/${String(creee['id'])}/history`)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(200);

      expect(response.body).toMatchObject({
        summary: { totalVisits: 0, totalSpent: null, firstVisitAt: null, lastVisitAt: null },
        visits: [],
      });
    });

    it('rend 404 plutôt qu’un historique vide sur un identifiant inconnu', async () => {
      await request(server())
        .get(`${BASE}/99999999-9999-4999-8999-999999999999/history`)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(404);
    });

    it('refuse une fenêtre au-delà du plafond serveur', async () => {
      const creee = await creerFiche();

      await request(server())
        .get(`${BASE}/${String(creee['id'])}/history`)
        .query({ limit: 500 })
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(400);
    });
  });

  describe('gardes', () => {
    const routes: readonly [string, string][] = [
      ['get', BASE],
      ['get', `${BASE}/99999999-9999-4999-8999-999999999999`],
      ['get', `${BASE}/99999999-9999-4999-8999-999999999999/history`],
      ['post', BASE],
      ['patch', `${BASE}/99999999-9999-4999-8999-999999999999`],
      ['patch', `${BASE}/99999999-9999-4999-8999-999999999999/status`],
    ];

    it.each(routes)('refuse %s %s sans jeton — 401', async (methode, chemin) => {
      await request(server())[methode as 'get'](chemin).expect(401);
    });

    it.each(routes)('refuse %s %s au rôle CLIENT — 403', async (methode, chemin) => {
      const appel = request(server())[methode as 'get'](chemin);

      await appel
        .set('Authorization', await harness.bearer('CLIENT'))
        .send({})
        .expect(403);
    });

    it('réserve la désactivation au rang MANAGER', async () => {
      const creee = await creerFiche();

      // `STAFF` corrige une fiche mais ne la retire pas des écrans : c'est une
      // décision sur le fichier, pas une correction dedans.
      await request(server())
        .patch(`${BASE}/${String(creee['id'])}/status`)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({ isActive: false })
        .expect(403);

      await request(server())
        .patch(`${BASE}/${String(creee['id'])}/status`)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ isActive: false })
        .expect(200);
    });
  });
});
