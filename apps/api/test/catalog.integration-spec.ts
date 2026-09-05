import type { INestApplication } from '@nestjs/common';
import { randomUUID } from 'node:crypto';

import request from 'supertest';

import type { FakeCatalogRepository } from '../src/modules/catalog/__tests__/catalog.doubles';
import { createCatalogHarness, type CatalogHarness } from './catalog.harness';

/**
 * Le module `catalog` interrogé en HTTP, sur l'application réellement câblée —
 * `ValidationPipe` global, filtre d'exceptions, gardes de #21 et #22 comprises.
 *
 * Ce que cette suite prouve, et que les tests unitaires ne peuvent pas :
 *
 * - les **seuils de rôle** par route (lecture `STAFF`, écriture `MANAGER`) ;
 * - le **refus des champs non déclarés**, dont un `tenantId` glissé dans le
 *   corps — le scénario de fuite le plus direct ;
 * - la **forme des réponses**, en particulier l'absence de `tenantId` ;
 * - l'**absence de route `DELETE`** : une prestation se désactive.
 *
 * L'isolation inter-tenant proprement dite vit dans
 * `catalog-tenant.isolation-spec.ts`.
 */

const EUR = { amountMinor: 7000, currency: 'EUR' };

describe('Catalogue — API', () => {
  let harness: CatalogHarness;
  let repository: FakeCatalogRepository;

  beforeEach(async () => {
    harness = await createCatalogHarness();
    repository = harness.repository;
  });

  afterEach(async () => {
    await harness.close();
  });

  const server = (): ReturnType<INestApplication['getHttpServer']> => harness.app.getHttpServer();

  describe('prestations', () => {
    it('crée une prestation, tampons compris, et rend la durée occupée', async () => {
      const response = await request(server())
        .post('/api/v1/services')
        .set('Authorization', `Bearer ${await harness.tokenFor('MANAGER')}`)
        .send({
          name: 'Massage Californien 60 min',
          durationMinutes: 60,
          bufferBeforeMinutes: 10,
          bufferAfterMinutes: 15,
          price: EUR,
        })
        .expect(201);

      expect(response.body).toMatchObject({
        slug: 'massage-californien-60-min',
        durationMinutes: 60,
        bufferBeforeMinutes: 10,
        bufferAfterMinutes: 15,
        occupiedMinutes: 85,
        price: { amountMinor: 7000, currency: 'EUR' },
        isActive: true,
        category: null,
      });
    });

    it('refuse un prix flottant plutôt que de l’arrondir en silence', async () => {
      // `0.1 + 0.2 !== 0.3` : l'écart invisible sur un panier ne l'est plus au
      // rapprochement bancaire. Le refus est un 400 nommant le champ, pas un
      // `numeric value out of range` remonté en 500 par le pilote.
      const response = await request(server())
        .post('/api/v1/services')
        .set('Authorization', `Bearer ${await harness.tokenFor('MANAGER')}`)
        .send({
          name: 'Massage',
          durationMinutes: 60,
          price: { amountMinor: 70.5, currency: 'EUR' },
        })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
    });

    it('refuse un prix négatif et une durée nulle', async () => {
      const token = await harness.tokenFor('MANAGER');

      await request(server())
        .post('/api/v1/services')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Offert', durationMinutes: 60, price: { amountMinor: -1, currency: 'EUR' } })
        .expect(400);

      await request(server())
        .post('/api/v1/services')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Instantané', durationMinutes: 0, price: EUR })
        .expect(400);
    });

    it('refuse un corps sans prix en 400, et non en 500', async () => {
      // `@ValidateNested` seul ne suffit pas : class-validator **saute** la
      // validation imbriquée quand la valeur est `undefined`. Sans `@IsDefined`,
      // le corps traverse la validation et le service déréférence
      // `input.price.amountMinor` — un 500 sur une requête simplement incomplète.
      const response = await request(server())
        .post('/api/v1/services')
        .set('Authorization', `Bearer ${await harness.tokenFor('MANAGER')}`)
        .send({ name: 'Massage', durationMinutes: 60 })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(repository.services).toHaveLength(0);
    });

    it('refuse un nom fait d’espaces et élague celui qu’il accepte', async () => {
      // `@MinLength(1)` compte trois caractères dans `"   "` : sans élagage
      // préalable, le catalogue accueille une prestation sans nom lisible. Le
      // contrat partagé (`displayNameSchema`) élague avant de borner ; l'API ne
      // doit pas accepter ce que le contrat refuse.
      const token = await harness.tokenFor('MANAGER');

      await request(server())
        .post('/api/v1/services')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: '   ', slug: 'sans-nom', durationMinutes: 60, price: EUR })
        .expect(400);

      const created = await request(server())
        .post('/api/v1/services')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: '  Massage  ', durationMinutes: 60, price: EUR })
        .expect(201);

      expect(created.body.name).toBe('Massage');
    });

    it('refuse un tampon négatif — il rendrait la cabine avant la fin du soin', async () => {
      await request(server())
        .post('/api/v1/services')
        .set('Authorization', `Bearer ${await harness.tokenFor('MANAGER')}`)
        .send({ name: 'Massage', durationMinutes: 60, bufferAfterMinutes: -5, price: EUR })
        .expect(400);
    });

    it('rejette un `tenantId` glissé dans le corps', async () => {
      // `forbidNonWhitelisted` **rejette** au lieu d'ignorer : sans lui,
      // l'injection passerait en silence, et rien ne signalerait la tentative.
      const response = await request(server())
        .post('/api/v1/services')
        .set('Authorization', `Bearer ${await harness.tokenFor('MANAGER')}`)
        .send({
          name: 'Massage',
          durationMinutes: 60,
          price: EUR,
          tenantId: randomUUID(),
        })
        .expect(400);

      expect(response.body.code).toBe('VALIDATION_ERROR');
      expect(repository.services).toHaveLength(0);
    });

    it('n’expose jamais le `tenantId` dans une réponse', async () => {
      const created = await request(server())
        .post('/api/v1/services')
        .set('Authorization', `Bearer ${await harness.tokenFor('MANAGER')}`)
        .send({ name: 'Massage', durationMinutes: 60, price: EUR })
        .expect(201);

      expect(JSON.stringify(created.body)).not.toContain(harness.tenantId);
      expect(Object.keys(created.body).sort()).toEqual([
        'bufferAfterMinutes',
        'bufferBeforeMinutes',
        'category',
        'description',
        'durationMinutes',
        'id',
        'isActive',
        'name',
        'occupiedMinutes',
        'price',
        'slug',
      ]);
    });

    it('désactive et réactive une prestation, sans jamais la supprimer', async () => {
      const seeded = repository.seedService({ tenantId: harness.tenantId });
      const token = await harness.tokenFor('MANAGER');

      const disabled = await request(server())
        .patch(`/api/v1/services/${seeded.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ isActive: false })
        .expect(200);
      expect(disabled.body.isActive).toBe(false);

      // La ligne est toujours là : les rendez-vous passés la référencent, et le
      // reporting doit continuer à savoir ce qui a été vendu.
      expect(repository.services).toHaveLength(1);

      const enabled = await request(server())
        .patch(`/api/v1/services/${seeded.id}`)
        .set('Authorization', `Bearer ${token}`)
        .send({ isActive: true })
        .expect(200);
      expect(enabled.body.isActive).toBe(true);
    });

    it('n’expose aucune route de suppression', async () => {
      const seeded = repository.seedService({ tenantId: harness.tenantId });

      // 404 « route inconnue » et non 405 : la route n'existe pas, elle n'est
      // pas seulement interdite sur ce verbe.
      await request(server())
        .delete(`/api/v1/services/${seeded.id}`)
        .set('Authorization', `Bearer ${await harness.tokenFor('ADMIN')}`)
        .expect(404);

      expect(repository.services).toHaveLength(1);
    });

    it('refuse la lecture à un client et l’écriture à un praticien', async () => {
      const seeded = repository.seedService({ tenantId: harness.tenantId });

      // Le catalogue de back-office n'est pas la page publique : un compte
      // client n'y a rien à faire.
      await request(server())
        .get('/api/v1/services')
        .set('Authorization', `Bearer ${await harness.tokenFor('CLIENT')}`)
        .expect(403);

      // Un praticien lit — durées et tampons décident de son agenda — mais ne
      // change pas un tarif : c'est un geste de gestion.
      await request(server())
        .get('/api/v1/services')
        .set('Authorization', `Bearer ${await harness.tokenFor('STAFF')}`)
        .expect(200);

      await request(server())
        .patch(`/api/v1/services/${seeded.id}`)
        .set('Authorization', `Bearer ${await harness.tokenFor('STAFF')}`)
        .send({ price: { amountMinor: 1, currency: 'EUR' } })
        .expect(403);
    });

    it('exige une identité vérifiée sur chaque route', async () => {
      const seeded = repository.seedService({ tenantId: harness.tenantId });

      await request(server()).get('/api/v1/services').expect(401);
      await request(server()).get(`/api/v1/services/${seeded.id}`).expect(401);
      await request(server()).post('/api/v1/services').send({}).expect(401);
      await request(server()).patch(`/api/v1/services/${seeded.id}`).send({}).expect(401);
    });

    it('refuse un identifiant mal formé avant d’atteindre la base', async () => {
      await request(server())
        .get('/api/v1/services/pas-un-uuid')
        .set('Authorization', `Bearer ${await harness.tokenFor('STAFF')}`)
        .expect(400);
    });

    it('rend 409 sur un slug déjà pris dans l’établissement', async () => {
      repository.seedService({ tenantId: harness.tenantId, slug: 'coupe' });

      const response = await request(server())
        .post('/api/v1/services')
        .set('Authorization', `Bearer ${await harness.tokenFor('MANAGER')}`)
        .send({ name: 'Coupe', durationMinutes: 30, price: EUR })
        .expect(409);

      expect(response.body.code).toBe('SERVICE_SLUG_TAKEN');
    });
  });

  describe('rubriques', () => {
    it('crée une rubrique et y range une prestation', async () => {
      const token = await harness.tokenFor('MANAGER');

      const category = await request(server())
        .post('/api/v1/service-categories')
        .set('Authorization', `Bearer ${token}`)
        .send({ name: 'Soins du visage', description: 'Éclat, hydratation' })
        .expect(201);

      expect(category.body).toMatchObject({ slug: 'soins-du-visage', isActive: true });

      const service = await request(server())
        .post('/api/v1/services')
        .set('Authorization', `Bearer ${token}`)
        .send({
          name: 'Soin éclat',
          categoryId: category.body.id,
          durationMinutes: 50,
          price: EUR,
        })
        .expect(201);

      expect(service.body.category).toEqual({
        id: category.body.id,
        slug: 'soins-du-visage',
        name: 'Soins du visage',
      });
    });

    it('rend 404 sur une rubrique inconnue, à la création comme au filtre', async () => {
      const inconnue = randomUUID();

      await request(server())
        .post('/api/v1/services')
        .set('Authorization', `Bearer ${await harness.tokenFor('MANAGER')}`)
        .send({ name: 'Soin', categoryId: inconnue, durationMinutes: 50, price: EUR })
        .expect(404);

      // Sans ce contrôle, le filtre rendrait `[]`, indistinguable d'une rubrique
      // réellement vide.
      await request(server())
        .get(`/api/v1/services?categoryId=${inconnue}`)
        .set('Authorization', `Bearer ${await harness.tokenFor('STAFF')}`)
        .expect(404);
    });

    it('désactive une rubrique sans la supprimer ni déclasser ses prestations', async () => {
      const category = repository.seedCategory({ tenantId: harness.tenantId });
      repository.seedService({ tenantId: harness.tenantId, categoryId: category.id });

      const response = await request(server())
        .patch(`/api/v1/service-categories/${category.id}`)
        .set('Authorization', `Bearer ${await harness.tokenFor('MANAGER')}`)
        .send({ isActive: false })
        .expect(200);

      expect(response.body.isActive).toBe(false);
      expect(repository.categories).toHaveLength(1);
      expect(repository.services[0]).toMatchObject({ categoryId: category.id, isActive: true });
    });

    it('n’expose aucune route de suppression', async () => {
      const category = repository.seedCategory({ tenantId: harness.tenantId });

      await request(server())
        .delete(`/api/v1/service-categories/${category.id}`)
        .set('Authorization', `Bearer ${await harness.tokenFor('ADMIN')}`)
        .expect(404);

      expect(repository.categories).toHaveLength(1);
    });

    it('filtre la liste sur l’activité, et refuse une valeur qui n’est pas booléenne', async () => {
      repository.seedCategory({ tenantId: harness.tenantId, slug: 'coiffure' });
      repository.seedCategory({
        tenantId: harness.tenantId,
        slug: 'saison-passee',
        isActive: false,
      });
      const token = await harness.tokenFor('STAFF');

      const tout = await request(server())
        .get('/api/v1/service-categories')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(tout.body).toHaveLength(2);

      const actives = await request(server())
        .get('/api/v1/service-categories?activeOnly=true')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(actives.body).toHaveLength(1);

      // Une valeur non reconnue est refusée plutôt que ramenée à `false` : un
      // `false` silencieux servirait une liste que personne n'a demandée.
      await request(server())
        .get('/api/v1/service-categories?activeOnly=peut-etre')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });
  });

  /**
   * L'annuaire des fiches praticien (#421).
   *
   * Ce que cette suite prouve, et que le test unitaire ne peut pas : la route
   * est **servie** — un contrôleur oublié dans les `controllers` de son module
   * compile, passe ses tests unitaires et rend 404 en vrai —, son seuil de rôle,
   * et la forme exacte de ce qu'elle rend.
   */
  describe('annuaire des praticiens', () => {
    it('liste les fiches de l’établissement même sans aucune affectation', async () => {
      // Le cas d'amorçage, celui qui motive le ticket : c'est ici que
      // `GET /services/:id/staff` et le catalogue public rendaient tous deux une
      // liste vide, et qu'aucune première affectation n'était possible.
      const camille = repository.seedStaff({
        tenantId: harness.tenantId,
        displayName: 'Camille Rousseau',
      });

      const response = await request(server())
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${await harness.tokenFor('STAFF')}`)
        .expect(200);

      expect(repository.assignments).toHaveLength(0);
      expect(response.body).toEqual([
        { id: camille.id, displayName: 'Camille Rousseau', isActive: true },
      ]);
    });

    it('rend un identifiant que l’affectation accepte', async () => {
      // Le deuxième critère du ticket, prouvé de bout en bout : l'identifiant
      // sorti de la liste part tel quel dans `POST …/staff` et aboutit. C'est
      // exactement ce que l'identifiant d'un **compte** ne ferait pas.
      repository.seedStaff({ tenantId: harness.tenantId });
      const service = repository.seedService({ tenantId: harness.tenantId });
      const manager = await harness.tokenFor('MANAGER');

      const annuaire = await request(server())
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${manager}`)
        .expect(200);

      await request(server())
        .post(`/api/v1/services/${service.id}/staff`)
        .set('Authorization', `Bearer ${manager}`)
        .send({ staffId: annuaire.body[0].id })
        .expect(201);

      expect(repository.assignments).toHaveLength(1);
    });

    it('n’expose ni le `tenantId`, ni le compte, ni la biographie', async () => {
      repository.seedStaff({ tenantId: harness.tenantId, displayName: 'Camille' });

      const response = await request(server())
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${await harness.tokenFor('STAFF')}`)
        .expect(200);

      // Trois champs, et pas un de plus : `userId` révélerait le compte derrière
      // la fiche, `bio` ferait transiter deux mille caractères par ligne, et le
      // `tenantId` est une information interne (tenant-isolation §4).
      expect(Object.keys(response.body[0]).sort()).toEqual(['displayName', 'id', 'isActive']);
      expect(JSON.stringify(response.body)).not.toContain(harness.tenantId);
    });

    it('filtre sur l’activité, et refuse une valeur qui n’est pas booléenne', async () => {
      repository.seedStaff({ tenantId: harness.tenantId, displayName: 'Active' });
      repository.seedStaff({
        tenantId: harness.tenantId,
        displayName: 'Partie',
        isActive: false,
      });
      const token = await harness.tokenFor('STAFF');

      const tout = await request(server())
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(tout.body).toHaveLength(2);

      const actives = await request(server())
        .get('/api/v1/staff?activeOnly=true')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(actives.body).toHaveLength(1);

      // `activeOnly=false` doit valoir **faux**, et non la chaîne `"false"` —
      // qui serait vraie et filtrerait une liste que personne n'a restreinte.
      // C'est `BooleanQuery` qui fait la conversion ; sans elle, ce cas-ci
      // rendrait une fiche au lieu de deux.
      const explicitementTout = await request(server())
        .get('/api/v1/staff?activeOnly=false')
        .set('Authorization', `Bearer ${token}`)
        .expect(200);
      expect(explicitementTout.body).toHaveLength(2);

      await request(server())
        .get('/api/v1/staff?activeOnly=peut-etre')
        .set('Authorization', `Bearer ${token}`)
        .expect(400);
    });

    it('rend une liste vide, et non un 404, pour un salon sans aucune fiche', async () => {
      // Un salon qui vient d'ouvrir n'est pas une erreur : c'est l'état de
      // départ, et l'écran doit pouvoir le dire plutôt que d'afficher une panne.
      const response = await request(server())
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${await harness.tokenFor('STAFF')}`)
        .expect(200);

      expect(response.body).toEqual([]);
    });

    it('refuse la lecture à un client, l’accorde à un praticien', async () => {
      await request(server())
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${await harness.tokenFor('CLIENT')}`)
        .expect(403);

      await request(server())
        .get('/api/v1/staff')
        .set('Authorization', `Bearer ${await harness.tokenFor('STAFF')}`)
        .expect(200);
    });

    it('exige une identité vérifiée', async () => {
      await request(server()).get('/api/v1/staff').expect(401);
    });

    it('n’expose aucune route d’écriture — la fiche n’appartient à aucun module', async () => {
      const seeded = repository.seedStaff({ tenantId: harness.tenantId });
      const admin = await harness.tokenFor('ADMIN');

      // 404 « route inconnue » : le cycle de vie de la fiche praticien n'est
      // attribué à aucun module par le CDC §2.3, et `catalog` ne fait que la
      // lire pour ses affectations.
      await request(server())
        .post('/api/v1/staff')
        .set('Authorization', `Bearer ${admin}`)
        .send({ displayName: 'Nouvelle' })
        .expect(404);

      await request(server())
        .patch(`/api/v1/staff/${seeded.id}`)
        .set('Authorization', `Bearer ${admin}`)
        .send({ displayName: 'Renommée' })
        .expect(404);

      await request(server())
        .delete(`/api/v1/staff/${seeded.id}`)
        .set('Authorization', `Bearer ${admin}`)
        .expect(404);

      expect(repository.staff).toHaveLength(1);
    });

    it('rejette un paramètre non déclaré plutôt que de l’ignorer', async () => {
      // `forbidNonWhitelisted` : `tenantId` est le paramètre par lequel un
      // appelant tenterait de choisir son établissement. Il n'est pas ignoré,
      // il est refusé.
      await request(server())
        .get(`/api/v1/staff?tenantId=${randomUUID()}`)
        .set('Authorization', `Bearer ${await harness.tokenFor('STAFF')}`)
        .expect(400);
    });
  });
});
