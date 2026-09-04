import request from 'supertest';

import { createPosHarness, type PosHarness } from './pos.harness';

/**
 * Le POS, exercé en HTTP sur l'application réellement câblée (#60).
 *
 * Ce que cette suite prouve et que les tests unitaires ne peuvent pas :
 *
 * - **les cinq routes sont servies** — un contrôleur oublié dans les
 *   `controllers` de son module compile, passe ses tests unitaires, et rend 404
 *   en vrai ;
 * - **les gardes sont montées** — sans jeton 401, avec un jeton `CLIENT` 403, et
 *   la tenue du rayon exige `MANAGER` là où la caisse se contente de `STAFF` ;
 * - **le `ValidationPipe` global mord** — `forbidNonWhitelisted` refuse en 400
 *   un `total`, un `priceAmountMinor` ou un `tenantId` glissés dans un corps de
 *   ticket, ce qui est la moitié exécutoire du troisième critère ;
 * - **la sérialisation est celle du contrat** — montant + devise, instants en
 *   UTC suffixés `Z`, `null` explicite sur les champs vides.
 *
 * La traversée inter-tenant, elle, vit dans `pos-tenant.isolation-spec.ts` :
 * c'est un protocole à part, avec ses propres assertions.
 */

const PRODUCTS = '/api/v1/products';
const SALES = '/api/v1/sales';

describe('POS — rayon retail et ticket de caisse', () => {
  let harness: PosHarness;

  afterEach(async () => {
    await harness.close();
  });

  describe('le rayon retail', () => {
    beforeEach(async () => {
      harness = await createPosHarness();
    });

    it('crée un article et le libelle dans la devise de l’établissement', async () => {
      const response = await request(harness.server())
        .post(PRODUCTS)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ sku: 'SH-01', name: 'Shampoing hydratant 250 ml', priceAmountMinor: 1850 })
        .expect(201);

      expect(response.body).toMatchObject({
        sku: 'SH-01',
        name: 'Shampoing hydratant 250 ml',
        priceAmountMinor: 1850,
        currency: 'EUR',
        isActive: true,
      });
      // Une information interne n'a rien à faire dans une réponse.
      expect(Object.keys(response.body as object)).not.toContain('tenantId');
    });

    it('refuse en 409 un code article déjà pris', async () => {
      const bearer = await harness.bearer('MANAGER');
      await request(harness.server())
        .post(PRODUCTS)
        .set('Authorization', bearer)
        .send({ sku: 'SH-01', name: 'Shampoing', priceAmountMinor: 1850 })
        .expect(201);

      const response = await request(harness.server())
        .post(PRODUCTS)
        .set('Authorization', bearer)
        .send({ sku: 'SH-01', name: 'Autre', priceAmountMinor: 1000 })
        .expect(409);

      expect(response.body).toMatchObject({ code: 'PRODUCT_SKU_TAKEN' });
    });

    it('refuse en 400 un prix fractionnaire — jamais de flottant sur un montant', async () => {
      const response = await request(harness.server())
        .post(PRODUCTS)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ sku: 'SH-02', name: 'Shampoing', priceAmountMinor: 18.5 })
        .expect(400);

      expect(response.body).toMatchObject({ code: 'VALIDATION_ERROR' });
      expect(JSON.stringify(response.body)).toContain('priceAmountMinor');
    });

    it('refuse en 400 une devise glissée dans le corps — elle vient de l’établissement', async () => {
      await request(harness.server())
        .post(PRODUCTS)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ sku: 'SH-03', name: 'Shampoing', priceAmountMinor: 1850, currency: 'USD' })
        .expect(400);
    });

    it('liste le rayon vendable, et les articles retirés seulement sur demande', async () => {
      harness.repository.seedProduct({ tenantId: harness.tenantId, name: 'Au rayon' });
      harness.repository.seedProduct({
        tenantId: harness.tenantId,
        name: 'Retiré',
        isActive: false,
      });
      const bearer = await harness.bearer('STAFF');

      const vendable = await request(harness.server())
        .get(PRODUCTS)
        .set('Authorization', bearer)
        .expect(200);
      expect((vendable.body as { name: string }[]).map((item) => item.name)).toEqual(['Au rayon']);

      const tout = await request(harness.server())
        .get(`${PRODUCTS}?includeInactive=true`)
        .set('Authorization', bearer)
        .expect(200);
      expect(tout.body).toHaveLength(2);
    });

    it('retire un article du rayon sans le supprimer', async () => {
      const article = harness.repository.seedProduct({ tenantId: harness.tenantId });

      const response = await request(harness.server())
        .patch(`${PRODUCTS}/${article.id}`)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ isActive: false })
        .expect(200);

      expect(response.body).toMatchObject({ id: article.id, isActive: false });
    });

    it('n’offre aucun verbe de suppression', async () => {
      const article = harness.repository.seedProduct({ tenantId: harness.tenantId });

      await request(harness.server())
        .delete(`${PRODUCTS}/${article.id}`)
        .set('Authorization', await harness.bearer('MANAGER'))
        .expect(404);
    });

    it('rend 400 sur un identifiant mal formé, avant d’atteindre la base', async () => {
      await request(harness.server())
        .patch(`${PRODUCTS}/pas-un-uuid`)
        .set('Authorization', await harness.bearer('MANAGER'))
        .send({ name: 'X' })
        .expect(400);
    });

    describe('les gardes', () => {
      it('refuse la lecture sans jeton', async () => {
        await request(harness.server()).get(PRODUCTS).expect(401);
      });

      it('refuse la lecture à une cliente', async () => {
        await request(harness.server())
          .get(PRODUCTS)
          .set('Authorization', await harness.bearer('CLIENT'))
          .expect(403);
      });

      it('réserve la tenue du rayon au rang `MANAGER`', async () => {
        await request(harness.server())
          .post(PRODUCTS)
          .set('Authorization', await harness.bearer('STAFF'))
          .send({ sku: 'SH-04', name: 'Shampoing', priceAmountMinor: 1850 })
          .expect(403);
      });
    });
  });

  describe('le ticket de caisse', () => {
    beforeEach(async () => {
      harness = await createPosHarness({ taxRateBps: 2000 });
    });

    it('compose un ticket de services et de produits, total recalculé côté serveur', async () => {
      const prestation = harness.catalog.seedService({
        tenantId: harness.tenantId,
        amountMinor: 7000,
      });
      const article = harness.repository.seedProduct({
        tenantId: harness.tenantId,
        amountMinor: 1850,
      });

      const response = await request(harness.server())
        .post(SALES)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({
          lines: [
            { kind: 'SERVICE', serviceId: prestation.id, quantity: 1 },
            { kind: 'PRODUCT', productId: article.id, quantity: 2 },
            { kind: 'TIP', amountMinor: 500 },
          ],
        })
        .expect(201);

      const body = response.body as Record<string, { amountMinor: number; currency: string }> &
        Record<string, unknown>;

      expect(body.subtotal).toEqual({ amountMinor: 10_700, currency: 'EUR' });
      expect(body.tax).toEqual({ amountMinor: 2140, currency: 'EUR' });
      expect(body.tip).toEqual({ amountMinor: 500, currency: 'EUR' });
      expect(body.total).toEqual({ amountMinor: 13_340, currency: 'EUR' });
      expect(body.appointmentId).toBeNull();
      expect(typeof body.createdAt).toBe('string');
      expect(body.createdAt).toMatch(/Z$/);
    });

    it('porte taxes et pourboires en **lignes distinctes** du ticket', async () => {
      const article = harness.repository.seedProduct({
        tenantId: harness.tenantId,
        amountMinor: 10_000,
      });

      const response = await request(harness.server())
        .post(SALES)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({
          lines: [
            { kind: 'PRODUCT', productId: article.id, quantity: 1 },
            { kind: 'TIP', amountMinor: 300 },
          ],
        })
        .expect(201);

      const items = (response.body as { items: { kind: string; position: number }[] }).items;
      expect(items.map((item) => item.kind)).toEqual(['PRODUCT', 'TAX', 'TIP']);
      expect(items.map((item) => item.position)).toEqual([0, 1, 2]);
    });

    it('rattache le ticket à un rendez-vous quand il est désigné', async () => {
      const rendezVous = harness.repository.seedAppointment({ tenantId: harness.tenantId });
      const article = harness.repository.seedProduct({ tenantId: harness.tenantId });

      const response = await request(harness.server())
        .post(SALES)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({
          appointmentId: rendezVous.id,
          lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 1 }],
        })
        .expect(201);

      expect(response.body).toMatchObject({ appointmentId: rendezVous.id });
    });

    it('trace l’opérateur depuis le jeton, jamais depuis le corps', async () => {
      const article = harness.repository.seedProduct({ tenantId: harness.tenantId });

      const response = await request(harness.server())
        .post(SALES)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({ lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 1 }] })
        .expect(201);

      expect(typeof (response.body as { cashierUserId: unknown }).cashierUserId).toBe('string');
    });

    it('refuse en 400 un montant glissé sur une ligne d’article', async () => {
      // C'est la moitié exécutoire du troisième critère : le champ n'existe pas
      // au contrat, et `forbidNonWhitelisted` le nomme dans son refus plutôt que
      // de l'ignorer en silence.
      const article = harness.repository.seedProduct({ tenantId: harness.tenantId });

      const response = await request(harness.server())
        .post(SALES)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({
          lines: [
            { kind: 'PRODUCT', productId: article.id, quantity: 1, unitAmountMinor: 1 },
          ],
        })
        .expect(400);

      expect(JSON.stringify(response.body)).toContain('unitAmountMinor');
    });

    it('refuse en 400 un total glissé dans le corps du ticket', async () => {
      const article = harness.repository.seedProduct({ tenantId: harness.tenantId });

      await request(harness.server())
        .post(SALES)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({
          total: { amountMinor: 1, currency: 'EUR' },
          lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 1 }],
        })
        .expect(400);
    });

    it('refuse en 400 une ligne `TAX` demandée par l’appelant', async () => {
      // La taxe est composée par le serveur : l'accepter du front aurait fait du
      // navigateur l'autorité sur ce que le salon doit au fisc.
      await request(harness.server())
        .post(SALES)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({ lines: [{ kind: 'TAX', amountMinor: 1 }] })
        .expect(400);
    });

    it('refuse en 400 un second pourboire, plutôt que de les additionner', async () => {
      // Deux lignes `TIP` fondues en une seule ligne de reçu feraient régler
      // deux fois ce que la cliente a laissé une fois, sans qu'aucun refus ne
      // le signale. Sur le chemin de l'argent, l'ambiguïté se rejette.
      const article = harness.repository.seedProduct({ tenantId: harness.tenantId });

      const response = await request(harness.server())
        .post(SALES)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({
          lines: [
            { kind: 'PRODUCT', productId: article.id, quantity: 1 },
            { kind: 'TIP', amountMinor: 500 },
            { kind: 'TIP', amountMinor: 500 },
          ],
        })
        .expect(400);

      expect(JSON.stringify(response.body)).toContain('pourboire');
      expect(harness.repository.allSales()).toHaveLength(0);
    });

    it('refuse en 400 un ticket sans aucune ligne', async () => {
      await request(harness.server())
        .post(SALES)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({ lines: [] })
        .expect(400);
    });

    it('refuse en 400 une quantité nulle', async () => {
      const article = harness.repository.seedProduct({ tenantId: harness.tenantId });

      await request(harness.server())
        .post(SALES)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({ lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 0 }] })
        .expect(400);
    });

    it('refuse en 422 un article retiré du rayon, en nommant le rang de la ligne', async () => {
      const article = harness.repository.seedProduct({
        tenantId: harness.tenantId,
        isActive: false,
      });

      const response = await request(harness.server())
        .post(SALES)
        .set('Authorization', await harness.bearer('STAFF'))
        .send({ lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 1 }] })
        .expect(422);

      expect(response.body).toMatchObject({
        code: 'SALE_ITEM_UNAVAILABLE',
        details: { position: 0 },
      });
    });

    it('relit un ticket avec ses lignes, dans l’ordre du reçu', async () => {
      const article = harness.repository.seedProduct({ tenantId: harness.tenantId });
      const bearer = await harness.bearer('STAFF');

      const created = await request(harness.server())
        .post(SALES)
        .set('Authorization', bearer)
        .send({ lines: [{ kind: 'PRODUCT', productId: article.id, quantity: 1 }] })
        .expect(201);

      const id = (created.body as { id: string }).id;

      const read = await request(harness.server())
        .get(`${SALES}/${id}`)
        .set('Authorization', bearer)
        .expect(200);

      expect(read.body).toMatchObject({ id });
      expect((read.body as { items: unknown[] }).items.length).toBeGreaterThan(0);
    });

    it('rend 404 sur un ticket inconnu', async () => {
      await request(harness.server())
        .get(`${SALES}/99999999-9999-4999-8999-999999999999`)
        .set('Authorization', await harness.bearer('STAFF'))
        .expect(404);
    });

    describe('les gardes', () => {
      it('refuse la composition sans jeton', async () => {
        await request(harness.server()).post(SALES).send({ lines: [] }).expect(401);
      });

      it('refuse la composition à une cliente', async () => {
        await request(harness.server())
          .post(SALES)
          .set('Authorization', await harness.bearer('CLIENT'))
          .send({ lines: [] })
          .expect(403);
      });

      it('refuse la lecture d’un ticket à une cliente', async () => {
        await request(harness.server())
          .get(`${SALES}/99999999-9999-4999-8999-999999999999`)
          .set('Authorization', await harness.bearer('CLIENT'))
          .expect(403);
      });
    });
  });
});
