import type { INestApplication } from '@nestjs/common';

import request from 'supertest';

import { createCatalogHarness, type CatalogHarness } from './catalog.harness';

/**
 * Isolation inter-tenant du module `catalog` — obligatoire pour tout endpoint
 * nouveau (tenant-isolation §6, DoD de #24).
 *
 * La suite couvre les **onze** routes de back-office du module, pas un
 * échantillon :
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
 * | `GET /services/:id/staff` | 404 sur la prestation du voisin ; l'affectation croisée reste invisible |
 * | `POST /services/:id/staff` | 404 des deux côtés — prestation ou praticien d'ailleurs — et rien d'écrit |
 * | `DELETE /services/:id/staff/:staffId` | 404, et l'affectation du voisin intacte |
 *
 * La **douzième** route du module, `GET /public/:tenantSlug/services`, n'est pas
 * ici : elle ne se désigne pas par un jeton mais par un slug d'URL, et sa
 * traversée se prouve donc autrement — dans `public-catalog.isolation-spec.ts`.
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
 *
 * ## Morsure vérifiée par mutation
 *
 * Une suite d'isolation verte ne prouve rien tant qu'on n'a pas vu ce qui la
 * fait rougir. Deux mutations ont été appliquées à `ServiceStaffService`, puis
 * retirées (#234) :
 *
 * | Mutation | Cas qui tombent |
 * |---|---|
 * | `requireStaff` retiré de `assign` | « le praticien du voisin est inatteignable à l'affectation » |
 * | `requireService` ne refuse plus | « la liste répond 404 sur la prestation du voisin » et « la prestation du voisin est inatteignable à l'affectation » |
 *
 * La mutation de `requireService` ne fait **pas** tomber le retrait sur la
 * prestation du voisin : `removeStaff` est scopé, il ne trouve rien et le 404
 * arrive par l'autre chemin. C'est de la défense en profondeur, pas un trou —
 * mais il fallait le savoir plutôt que le supposer.
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

  /**
   * Le troisième critère de #25 : « un praticien ne peut être affecté qu'à un
   * service de son tenant ».
   *
   * Ce que ces cas prouvent tient au **service**, pas à la base : les clés
   * étrangères composites `(tenant_id, service_id)` et `(tenant_id, staff_id)`
   * sont la vraie frontière, et le double en mémoire ne les modélise pas. Si
   * `ServiceStaffService` cessait de vérifier prestation et praticien avant
   * d'écrire, la production répondrait 500 sur une violation de contrainte là où
   * le contrat annonce 404 — et c'est cette différence-là que la suite tient.
   *
   * Plusieurs cas sèment délibérément une ligne d'affectation **croisée** —
   * tenant d'un côté, prestation ou praticien de l'autre. C'est une ligne que
   * les clés composites rendent impossible en base ; elle est posée ici de force
   * pour vérifier qu'aucune couche au-dessus ne la rendrait visible si elle
   * existait.
   */
  describe('affectations praticien-prestation', () => {
    it('la liste répond 404 sur la prestation du voisin, pas une liste vide', async () => {
      const chezB = harness.repository.seedService({ tenantId: b });
      const praticienB = harness.repository.seedStaff({ tenantId: b });
      harness.repository.seedAssignment({
        tenantId: b,
        serviceId: chezB.id,
        staffId: praticienB.id,
      });

      const response = await request(server())
        .get(`/api/v1/services/${chezB.id}/staff`)
        .set('Authorization', `Bearer ${await asA()}`)
        .expect(404);

      // Une liste vide se lirait « personne n'y est affecté » et inviterait à
      // affecter quelqu'un ; le 404 dit la seule chose vraie ici. Un 403
      // confirmerait que cette prestation existe quelque part.
      expect(response.body.code).toBe('NOT_FOUND');
      expect(JSON.stringify(response.body)).not.toContain(praticienB.id);
    });

    it('l’affectation croisée que la base refuse reste invisible d’ici', async () => {
      const chezA = harness.repository.seedService({ tenantId: a });
      const praticienB = harness.repository.seedStaff({ tenantId: b, displayName: 'Voisin' });
      harness.repository.seedAssignment({
        tenantId: b,
        serviceId: chezA.id,
        staffId: praticienB.id,
      });

      const response = await request(server())
        .get(`/api/v1/services/${chezA.id}/staff`)
        .set('Authorization', `Bearer ${await asA()}`)
        .expect(200);

      expect(response.body).toEqual([]);
      expect(JSON.stringify(response.body)).not.toContain(praticienB.id);
    });

    it('l’affectation croisée reste invisible même quand elle porte notre tenant', async () => {
      // L'autre moitié du cas précédent, et la seule qui mette la portée du
      // **praticien** à l'épreuve : là-bas la ligne portait le tenant du voisin,
      // et le filtre sur l'affectation suffisait à l'écarter. Ici la ligne est
      // chez nous et désigne une fiche d'ailleurs.
      const chezA = harness.repository.seedService({ tenantId: a });
      const praticienB = harness.repository.seedStaff({ tenantId: b, displayName: 'Voisin' });
      harness.repository.seedAssignment({
        tenantId: a,
        serviceId: chezA.id,
        staffId: praticienB.id,
      });

      const response = await request(server())
        .get(`/api/v1/services/${chezA.id}/staff`)
        .set('Authorization', `Bearer ${await asA()}`)
        .expect(200);

      expect(response.body).toEqual([]);
      expect(JSON.stringify(response.body)).not.toContain(praticienB.id);
    });

    it('le praticien du voisin est inatteignable à l’affectation', async () => {
      const chezA = harness.repository.seedService({ tenantId: a });
      const praticienB = harness.repository.seedStaff({ tenantId: b });

      const response = await request(server())
        .post(`/api/v1/services/${chezA.id}/staff`)
        .set('Authorization', `Bearer ${await asA()}`)
        .send({ staffId: praticienB.id })
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      // Rien n'a été écrit : le refus est un refus, pas un enregistrement suivi
      // d'un message d'erreur.
      expect(harness.repository.assignments).toHaveLength(0);
    });

    it('la prestation du voisin est inatteignable à l’affectation', async () => {
      const chezB = harness.repository.seedService({ tenantId: b });
      const praticienA = harness.repository.seedStaff({ tenantId: a });

      const response = await request(server())
        .post(`/api/v1/services/${chezB.id}/staff`)
        .set('Authorization', `Bearer ${await asA()}`)
        .send({ staffId: praticienA.id })
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      expect(harness.repository.assignments).toHaveLength(0);
    });

    it('une affectation déjà prise chez le voisin n’en bloque pas une ici', async () => {
      // Le pendant de « le slug pris chez le voisin reste libre » : l'unicité de
      // `service_staff` est `(tenant_id, service_id, staff_id)`. Un 409 ici
      // révélerait l'existence de la ligne voisine.
      const chezA = harness.repository.seedService({ tenantId: a });
      const praticienA = harness.repository.seedStaff({ tenantId: a });
      harness.repository.seedAssignment({
        tenantId: b,
        serviceId: chezA.id,
        staffId: praticienA.id,
      });

      const response = await request(server())
        .post(`/api/v1/services/${chezA.id}/staff`)
        .set('Authorization', `Bearer ${await asA()}`)
        .send({ staffId: praticienA.id })
        .expect(201);

      expect(response.body.id).toBe(praticienA.id);
      expect(harness.repository.assignments).toHaveLength(2);
    });

    it('le retrait répond 404 et laisse l’affectation du voisin intacte', async () => {
      const chezB = harness.repository.seedService({ tenantId: b });
      const praticienB = harness.repository.seedStaff({ tenantId: b });
      harness.repository.seedAssignment({
        tenantId: b,
        serviceId: chezB.id,
        staffId: praticienB.id,
      });

      const response = await request(server())
        .delete(`/api/v1/services/${chezB.id}/staff/${praticienB.id}`)
        .set('Authorization', `Bearer ${await asA()}`)
        .expect(404);

      expect(response.body.code).toBe('NOT_FOUND');
      expect(harness.repository.assignments).toEqual([
        { tenantId: b, serviceId: chezB.id, staffId: praticienB.id },
      ]);
    });

    it('le retrait ne peut pas emporter la ligne du voisin sur une prestation d’ici', async () => {
      // La prestation est bien de l'appelant — le premier contrôle passe. Ce qui
      // doit tenir ensuite est la portée du `deleteMany` : la ligne visée porte
      // le tenant du voisin, et elle doit survivre.
      const chezA = harness.repository.seedService({ tenantId: a });
      const praticienB = harness.repository.seedStaff({ tenantId: b });
      harness.repository.seedAssignment({
        tenantId: b,
        serviceId: chezA.id,
        staffId: praticienB.id,
      });

      await request(server())
        .delete(`/api/v1/services/${chezA.id}/staff/${praticienB.id}`)
        .set('Authorization', `Bearer ${await asA()}`)
        .expect(404);

      expect(harness.repository.assignments).toEqual([
        { tenantId: b, serviceId: chezA.id, staffId: praticienB.id },
      ]);
    });

    it('un jeton émis sur le voisin ne voit que les affectations du voisin', async () => {
      const chezA = harness.repository.seedService({ tenantId: a });
      const praticienA = harness.repository.seedStaff({ tenantId: a, displayName: 'Chez A' });
      const chezB = harness.repository.seedService({ tenantId: b });
      const praticienB = harness.repository.seedStaff({ tenantId: b, displayName: 'Chez B' });
      harness.repository.seedAssignment({
        tenantId: a,
        serviceId: chezA.id,
        staffId: praticienA.id,
      });
      harness.repository.seedAssignment({
        tenantId: b,
        serviceId: chezB.id,
        staffId: praticienB.id,
      });

      const vuDeB = await request(server())
        .get(`/api/v1/services/${chezB.id}/staff`)
        .set('Authorization', `Bearer ${await harness.tokenFor('ADMIN', b)}`)
        .expect(200);

      expect(vuDeB.body).toHaveLength(1);
      expect(vuDeB.body[0].id).toBe(praticienB.id);
      expect(JSON.stringify(vuDeB.body)).not.toContain(praticienA.id);
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

    it('un `tenantId` glissé dans une demande d’affectation ne déplace rien', async () => {
      // Même liste blanche, sur la route où la tentation est la plus directe :
      // le corps ne déclare que `staffId`, et `forbidNonWhitelisted` rejette le
      // reste au lieu de l'ignorer silencieusement.
      const chezA = harness.repository.seedService({ tenantId: a });
      const praticienA = harness.repository.seedStaff({ tenantId: a });

      await request(server())
        .post(`/api/v1/services/${chezA.id}/staff`)
        .set('Authorization', `Bearer ${await asA()}`)
        .send({ staffId: praticienA.id, tenantId: b })
        .expect(400);

      expect(harness.repository.assignments).toHaveLength(0);
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
