import type { INestApplication } from '@nestjs/common';

import request from 'supertest';

import { createCatalogHarness, type CatalogHarness } from './catalog.harness';

/**
 * Isolation inter-tenant du module `catalog` — obligatoire pour tout endpoint
 * nouveau (tenant-isolation §6, DoD de #24).
 *
 * La suite couvre les **huit** routes du module, pas un échantillon :
 *
 * | Route | Ce qui est vérifié |
 * |---|---|
 * | `GET /services` | la liste ne contient rien du voisin |
 * | `GET /services/:id` | 404 sur la prestation du voisin |
 * | `POST /services` | le slug du voisin reste libre ; sa rubrique inatteignable |
 * | `PATCH /services/:id` | 404, et la prestation du voisin intacte |
 * | `GET /service-categories` | la liste ne contient rien du voisin |
 * | `GET /service-categories/:id` | 404 sur la rubrique du voisin |
 * | `POST /service-categories` | le slug du voisin reste libre |
 * | `PATCH /service-categories/:id` | 404, et la rubrique du voisin intacte |
 *
 * Le protocole est celui de tenant-isolation §6 : créer chez A, s'authentifier
 * comme B, tenter lecture, modification et suppression par identifiant, attendre
 * 404 — **jamais 403**, qui confirmerait l'existence de la ressource — et
 * vérifier que la ressource de A est intacte. La suppression, ici, n'existe pas :
 * son absence est vérifiée comme le reste.
 *
 * Le scénario délibéré est celui du **même slug des deux côtés** : c'est ce que
 * `@@unique([tenantId, slug])` autorise, et c'est là qu'une confusion de tenant
 * se voit.
 */

const SLUG_PARTAGE = 'massage-60-min';
const EUR = { amountMinor: 7000, currency: 'EUR' };

describe('Isolation inter-tenant — module catalog', () => {
  let harness: CatalogHarness;
  /** L'établissement de l'appelant. */
  let a: string;
  /** L'établissement voisin, celui qu'aucune réponse ne doit laisser voir. */
  let b: string;

  beforeEach(async () => {
    harness = await createCatalogHarness();
    a = harness.tenantId;
    b = harness.otherTenantId;
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.app.getHttpServer();

  /** Un porteur de l'établissement A, au rang le plus capable. */
  const asA = async (): Promise<string> => harness.tokenFor('ADMIN');

  describe('prestations', () => {
    it('la liste ne laisse voir aucune prestation du voisin', async () => {
      const chezA = harness.repository.seedService({ tenantId: a, name: 'Chez A' });
      const chezB = harness.repository.seedService({ tenantId: b, name: 'Chez B' });

      const response = await request(server())
        .get('/api/v1/services')
        .set('Authorization', `Bearer ${await asA()}`)
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].id).toBe(chezA.id);
      // Ni l'identifiant du voisin, ni son établissement, où que ce soit.
      expect(JSON.stringify(response.body)).not.toContain(chezB.id);
      expect(JSON.stringify(response.body)).not.toContain(b);
    });

    it('la lecture par identifiant répond 404, pas 403', async () => {
      const chezB = harness.repository.seedService({ tenantId: b });

      const response = await request(server())
        .get(`/api/v1/services/${chezB.id}`)
        .set('Authorization', `Bearer ${await asA()}`)
        .expect(404);

      // Un 403 confirmerait que cette prestation existe quelque part.
      expect(response.body.code).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain(chezB.id);
    });

    it('le slug pris chez le voisin reste libre ici', async () => {
      harness.repository.seedService({ tenantId: b, slug: SLUG_PARTAGE });

      const response = await request(server())
        .post('/api/v1/services')
        .set('Authorization', `Bearer ${await asA()}`)
        .send({ name: 'Massage 60 min', slug: SLUG_PARTAGE, durationMinutes: 60, price: EUR })
        .expect(201);

      // Deux salons ont chacun droit à leur « massage 60 min » : l'unicité est
      // par tenant. Un 409 ici révélerait l'existence de la prestation du voisin.
      expect(response.body.slug).toBe(SLUG_PARTAGE);
      expect(harness.repository.services).toHaveLength(2);
    });

    it('la rubrique du voisin est inatteignable à la création', async () => {
      const chezB = harness.repository.seedCategory({ tenantId: b });

      await request(server())
        .post('/api/v1/services')
        .set('Authorization', `Bearer ${await asA()}`)
        .send({ name: 'Soin', categoryId: chezB.id, durationMinutes: 50, price: EUR })
        .expect(404);

      // Rien n'a été écrit : la prestation d'un salon ne se range pas dans la
      // rubrique d'un autre. La clé composite `(tenant_id, category_id)` le
      // refuse aussi en base — le contrôle applicatif ne fait qu'en donner un
      // code d'erreur utile.
      expect(harness.repository.services).toHaveLength(0);
    });

    it('la rubrique du voisin est inatteignable en filtre de liste', async () => {
      const chezB = harness.repository.seedCategory({ tenantId: b });

      const response = await request(server())
        .get(`/api/v1/services?categoryId=${chezB.id}`)
        .set('Authorization', `Bearer ${await asA()}`)
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
    });

    it('la modification répond 404 et laisse la prestation du voisin intacte', async () => {
      const chezB = harness.repository.seedService({
        tenantId: b,
        name: 'Chez B',
        priceAmountMinor: 9000,
      });

      await request(server())
        .patch(`/api/v1/services/${chezB.id}`)
        .set('Authorization', `Bearer ${await asA()}`)
        .send({ name: 'Détourné', price: { amountMinor: 1, currency: 'EUR' }, isActive: false })
        .expect(404);

      expect(harness.repository.services[0]).toMatchObject({
        tenantId: b,
        name: 'Chez B',
        priceAmountMinor: 9000,
        isActive: true,
      });
    });

    it('la suppression n’existe pas, ici comme ailleurs', async () => {
      const chezB = harness.repository.seedService({ tenantId: b });

      await request(server())
        .delete(`/api/v1/services/${chezB.id}`)
        .set('Authorization', `Bearer ${await asA()}`)
        .expect(404);

      expect(harness.repository.services).toHaveLength(1);
    });
  });

  describe('rubriques', () => {
    it('la liste ne laisse voir aucune rubrique du voisin', async () => {
      const chezA = harness.repository.seedCategory({ tenantId: a, name: 'Chez A' });
      const chezB = harness.repository.seedCategory({ tenantId: b, name: 'Chez B' });

      const response = await request(server())
        .get('/api/v1/service-categories')
        .set('Authorization', `Bearer ${await asA()}`)
        .expect(200);

      expect(response.body).toHaveLength(1);
      expect(response.body[0].id).toBe(chezA.id);
      expect(JSON.stringify(response.body)).not.toContain(chezB.id);
      expect(JSON.stringify(response.body)).not.toContain(b);
    });

    it('la lecture par identifiant répond 404, pas 403', async () => {
      const chezB = harness.repository.seedCategory({ tenantId: b });

      const response = await request(server())
        .get(`/api/v1/service-categories/${chezB.id}`)
        .set('Authorization', `Bearer ${await asA()}`)
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain(chezB.id);
    });

    it('le slug pris chez le voisin reste libre ici', async () => {
      harness.repository.seedCategory({ tenantId: b, slug: 'coiffure' });

      const response = await request(server())
        .post('/api/v1/service-categories')
        .set('Authorization', `Bearer ${await asA()}`)
        .send({ name: 'Coiffure' })
        .expect(201);

      expect(response.body.slug).toBe('coiffure');
      expect(harness.repository.categories).toHaveLength(2);
    });

    it('la modification répond 404 et laisse la rubrique du voisin intacte', async () => {
      const chezB = harness.repository.seedCategory({ tenantId: b, name: 'Chez B' });

      await request(server())
        .patch(`/api/v1/service-categories/${chezB.id}`)
        .set('Authorization', `Bearer ${await asA()}`)
        .send({ name: 'Détourné', isActive: false })
        .expect(404);

      expect(harness.repository.categories[0]).toMatchObject({
        tenantId: b,
        name: 'Chez B',
        isActive: true,
      });
    });

    it('la suppression n’existe pas, ici comme ailleurs', async () => {
      const chezB = harness.repository.seedCategory({ tenantId: b });

      await request(server())
        .delete(`/api/v1/service-categories/${chezB.id}`)
        .set('Authorization', `Bearer ${await asA()}`)
        .expect(404);

      expect(harness.repository.categories).toHaveLength(1);
    });
  });

  describe('le tenant ne vient que du jeton', () => {
    it('un `tenantId` dans le corps ne déplace rien', async () => {
      // `forbidNonWhitelisted` **rejette** au lieu d'ignorer : la tentative
      // s'arrête en 400, et rien n'est écrit nulle part.
      await request(server())
        .post('/api/v1/service-categories')
        .set('Authorization', `Bearer ${await asA()}`)
        .send({ name: 'Coiffure', tenantId: b })
        .expect(400);

      expect(harness.repository.categories).toHaveLength(0);
    });

    it('un en-tête ou un paramètre de requête ne déplace rien non plus', async () => {
      const chezB = harness.repository.seedService({ tenantId: b });
      const token = await asA();

      // L'en-tête est ignoré : aucune ligne du code ne le lit — le décorateur
      // `@CurrentTenant` reçoit le contexte d'exécution et le laisse
      // délibérément de côté.
      await request(server())
        .get(`/api/v1/services/${chezB.id}`)
        .set('Authorization', `Bearer ${token}`)
        .set('X-Tenant-Id', b)
        .expect(404);

      // Un paramètre non déclaré est refusé par la liste blanche, il ne devient
      // certainement pas une portée.
      await request(server())
        .get(`/api/v1/services?tenantId=${b}`)
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('un jeton émis sur le voisin ne lit que le voisin', async () => {
      // Le pendant du cas précédent : le même appelant, le même serveur, mais un
      // jeton **signé** pour l'autre établissement. C'est la revendication
      // vérifiée qui décide, et elle seule.
      const chezA = harness.repository.seedService({ tenantId: a, name: 'Chez A' });
      const chezB = harness.repository.seedService({ tenantId: b, name: 'Chez B' });

      const vuDeB = await request(server())
        .get('/api/v1/services')
        .set('Authorization', `Bearer ${await harness.tokenFor('ADMIN', b)}`)
        .expect(200);

      expect(vuDeB.body).toHaveLength(1);
      expect(vuDeB.body[0].id).toBe(chezB.id);
      expect(JSON.stringify(vuDeB.body)).not.toContain(chezA.id);
    });
  });
});
