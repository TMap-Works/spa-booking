import { randomUUID } from 'node:crypto';

import { NotFoundError } from '../../../common/errors';
import { runWithTenant } from '../../../common/tenant';
import { ServiceSlugTakenError } from '../catalog.errors';
import type { ServiceView } from '../catalog.types';
import { ServicesService } from '../services.service';
import { FakeCatalogRepository } from './catalog.doubles';

/**
 * Règles métier des prestations — sans HTTP, sans base.
 *
 * Le service est exercé **dans une portée de tenant**, celle-là même que
 * `JwtAuthGuard` renseigne en vrai et que l'extension Prisma consulte : un test
 * qui l'ouvrirait autrement ne prouverait rien du chemin réel.
 */

const TENANT_A = randomUUID();
const TENANT_B = randomUUID();

/** L'erreur rejetée par une promesse, pour les assertions sur son contenu. */
async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  const RESOLVED = Symbol('resolved');
  const outcome: unknown = await promise.then(
    () => RESOLVED,
    (error: unknown) => error,
  );
  if (outcome === RESOLVED) {
    throw new Error('la promesse a abouti alors qu’un échec était attendu');
  }
  return outcome;
}

describe('ServicesService', () => {
  let repository: FakeCatalogRepository;
  let services: ServicesService;

  beforeEach(() => {
    repository = new FakeCatalogRepository();
    services = new ServicesService(repository.asRepository());
  });

  const inTenantA = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_A, fn);
  const inTenantB = async <T>(fn: () => Promise<T>): Promise<T> => runWithTenant(TENANT_B, fn);

  const price = { amountMinor: 7000, currency: 'EUR' };

  describe('création', () => {
    it('dérive le slug du nom quand il n’est pas fourni', async () => {
      const created = await inTenantA(async () =>
        services.create({ name: 'Massage Californien 60 min', durationMinutes: 60, price }),
      );

      expect(created.slug).toBe('massage-californien-60-min');
    });

    it('retient le slug fourni — c’est ce qui fige l’URL d’une prestation renommée', async () => {
      const created = await inTenantA(async () =>
        services.create({
          name: 'Massage signature',
          slug: 'massage-californien-60-min',
          durationMinutes: 60,
          price,
        }),
      );

      expect(created.slug).toBe('massage-californien-60-min');
    });

    it('pose des tampons nuls par défaut et rend la durée réellement occupée', async () => {
      const sansTampon = await inTenantA(async () =>
        services.create({ name: 'Coupe', durationMinutes: 30, price }),
      );
      const avecTampons = await inTenantA(async () =>
        services.create({
          name: 'Soin visage',
          durationMinutes: 50,
          bufferBeforeMinutes: 10,
          bufferAfterMinutes: 15,
          price,
        }),
      );

      expect(sansTampon).toMatchObject({
        bufferBeforeMinutes: 0,
        bufferAfterMinutes: 0,
        occupiedMinutes: 30,
      });
      // Le créneau bloqué sur l'agenda vaut avant + durée + après, jamais la
      // seule durée facturée : c'est de cela que le moteur de disponibilité
      // dépendra.
      expect(avecTampons.occupiedMinutes).toBe(75);
    });

    it('garde le prix en entier et en devise, jamais en flottant', async () => {
      const created = await inTenantA(async () =>
        services.create({
          name: 'Massage 90 min',
          durationMinutes: 90,
          price: { amountMinor: 10_500, currency: 'EUR' },
        }),
      );

      expect(created.price).toEqual({ amountMinor: 10_500, currency: 'EUR' });
      expect(Number.isInteger(created.price.amountMinor)).toBe(true);
    });

    it('crée la prestation active — elle est au catalogue dès sa création', async () => {
      const created = await inTenantA(async () =>
        services.create({ name: 'Coupe', durationMinutes: 30, price }),
      );

      expect(created.isActive).toBe(true);
    });

    it('refuse un slug déjà pris dans cet établissement', async () => {
      await inTenantA(async () => services.create({ name: 'Coupe', durationMinutes: 30, price }));

      const error = await inTenantA(async () =>
        rejectionOf(services.create({ name: 'Coupe', durationMinutes: 45, price })),
      );

      expect(error).toBeInstanceOf(ServiceSlugTakenError);
      expect(error).toMatchObject({ status: 409, details: { slug: 'coupe' } });
    });

    it('laisse deux établissements porter le même slug', async () => {
      // L'unicité est **par tenant** : deux salons ont chacun droit à leur
      // « coupe » (tenant-isolation §1).
      const a = await inTenantA(async () =>
        services.create({ name: 'Coupe', durationMinutes: 30, price }),
      );
      const b = await inTenantB(async () =>
        services.create({ name: 'Coupe', durationMinutes: 30, price }),
      );

      expect(a.slug).toBe(b.slug);
      expect(a.id).not.toBe(b.id);
    });

    it('rattache la prestation à une rubrique de l’établissement', async () => {
      const category = repository.seedCategory({ tenantId: TENANT_A, name: 'Coiffure' });

      const created = await inTenantA(async () =>
        services.create({
          name: 'Coupe',
          categoryId: category.id,
          durationMinutes: 30,
          price,
        }),
      );

      expect(created.category).toEqual({
        id: category.id,
        slug: category.slug,
        name: 'Coiffure',
      });
    });

    it('refuse en 404 une rubrique inconnue, sans écrire la prestation', async () => {
      const error = await inTenantA(async () =>
        rejectionOf(
          services.create({
            name: 'Coupe',
            categoryId: randomUUID(),
            durationMinutes: 30,
            price,
          }),
        ),
      );

      expect(error).toBeInstanceOf(NotFoundError);
      // Rien n'a été écrit : le contrôle a lieu avant l'insertion.
      expect(repository.services).toHaveLength(0);
    });

    it('refuse en 404 la rubrique d’un autre établissement', async () => {
      // Le cas que la clé étrangère composite `(tenant_id, category_id)` refuse
      // en base ; le module le refuse d'abord, avec un code d'erreur utile
      // plutôt qu'un 500. **404 et non 403** : un 403 confirmerait que cette
      // rubrique existe quelque part.
      const chezB = repository.seedCategory({ tenantId: TENANT_B, name: 'Barbier' });

      const error = await inTenantA(async () =>
        rejectionOf(
          services.create({
            name: 'Taille de barbe',
            categoryId: chezB.id,
            durationMinutes: 20,
            price,
          }),
        ),
      );

      expect(error).toBeInstanceOf(NotFoundError);
      expect(repository.services).toHaveLength(0);
    });
  });

  describe('lecture', () => {
    it('répond 404 pour un identifiant inconnu', async () => {
      const error = await inTenantA(async () => rejectionOf(services.byId(randomUUID())));

      expect(error).toBeInstanceOf(NotFoundError);
    });

    it('répond 404 pour la prestation d’un autre établissement', async () => {
      const chezB = repository.seedService({ tenantId: TENANT_B });

      const error = await inTenantA(async () => rejectionOf(services.byId(chezB.id)));

      expect(error).toBeInstanceOf(NotFoundError);
    });

    it('ne liste que les prestations de l’établissement courant', async () => {
      repository.seedService({ tenantId: TENANT_A, name: 'Coupe', slug: 'coupe' });
      repository.seedService({ tenantId: TENANT_B, name: 'Barbe', slug: 'barbe' });

      const listed = await inTenantA(async () => services.list({ activeOnly: false }));

      expect(listed.map((service: ServiceView) => service.name)).toEqual(['Coupe']);
    });

    it('filtre sur l’activité quand on le demande, et rend tout sinon', async () => {
      repository.seedService({ tenantId: TENANT_A, name: 'Coupe', slug: 'coupe' });
      repository.seedService({
        tenantId: TENANT_A,
        name: 'Ancienne offre',
        slug: 'ancienne-offre',
        isActive: false,
      });

      const tout = await inTenantA(async () => services.list({ activeOnly: false }));
      const actives = await inTenantA(async () => services.list({ activeOnly: true }));

      expect(tout).toHaveLength(2);
      expect(actives.map((service: ServiceView) => service.name)).toEqual(['Coupe']);
    });

    it('vérifie la rubrique du filtre au lieu de rendre une liste vide', async () => {
      // Sans ce contrôle, un identifiant inconnu — ou d'un autre établissement —
      // rendrait `[]`, indistinguable d'une rubrique réellement vide.
      const error = await inTenantA(async () =>
        rejectionOf(services.list({ activeOnly: false, categoryId: randomUUID() })),
      );

      expect(error).toBeInstanceOf(NotFoundError);
    });
  });

  describe('modification', () => {
    it('ne touche que les champs présents dans le corps', async () => {
      const seeded = repository.seedService({
        tenantId: TENANT_A,
        name: 'Coupe',
        durationMinutes: 30,
        priceAmountMinor: 3000,
      });

      const updated = await inTenantA(async () =>
        services.update(seeded.id, { durationMinutes: 45 }),
      );

      expect(updated).toMatchObject({
        name: 'Coupe',
        durationMinutes: 45,
        price: { amountMinor: 3000, currency: 'EUR' },
      });
    });

    it('efface la description et déclasse la prestation sur un `null` explicite', async () => {
      const category = repository.seedCategory({ tenantId: TENANT_A });
      const seeded = repository.seedService({ tenantId: TENANT_A, categoryId: category.id });

      const updated = await inTenantA(async () =>
        services.update(seeded.id, { description: null, categoryId: null }),
      );

      expect(updated.description).toBeNull();
      expect(updated.category).toBeNull();
    });

    it('désactive sans supprimer — la ligne reste, et son historique avec', async () => {
      const seeded = repository.seedService({ tenantId: TENANT_A });

      const updated = await inTenantA(async () =>
        services.update(seeded.id, { isActive: false }),
      );

      expect(updated.isActive).toBe(false);
      // La prestation existe toujours : `PATCH` est un basculement, jamais un
      // effacement. Les rendez-vous passés la référencent.
      expect(repository.services).toHaveLength(1);
      expect(await inTenantA(async () => services.byId(seeded.id))).toMatchObject({
        isActive: false,
      });
    });

    it('réactive une prestation retirée du catalogue', async () => {
      const seeded = repository.seedService({ tenantId: TENANT_A, isActive: false });

      const updated = await inTenantA(async () => services.update(seeded.id, { isActive: true }));

      expect(updated.isActive).toBe(true);
    });

    it('répond 404 pour la prestation d’un autre établissement, sans rien écrire', async () => {
      const chezB = repository.seedService({ tenantId: TENANT_B, name: 'Barbe' });

      const error = await inTenantA(async () =>
        rejectionOf(services.update(chezB.id, { name: 'Détourné', isActive: false })),
      );

      expect(error).toBeInstanceOf(NotFoundError);
      // La prestation du voisin est intacte : ni son nom, ni son activité.
      expect(repository.services[0]).toMatchObject({ name: 'Barbe', isActive: true });
    });

    it('refuse un slug déjà porté par une autre prestation du même établissement', async () => {
      repository.seedService({ tenantId: TENANT_A, slug: 'coupe' });
      const autre = repository.seedService({ tenantId: TENANT_A, slug: 'brushing' });

      const error = await inTenantA(async () =>
        rejectionOf(services.update(autre.id, { slug: 'coupe' })),
      );

      expect(error).toBeInstanceOf(ServiceSlugTakenError);
    });

    it('refuse en 404 le reclassement vers la rubrique d’un autre établissement', async () => {
      const seeded = repository.seedService({ tenantId: TENANT_A });
      const chezB = repository.seedCategory({ tenantId: TENANT_B });

      const error = await inTenantA(async () =>
        rejectionOf(services.update(seeded.id, { categoryId: chezB.id })),
      );

      expect(error).toBeInstanceOf(NotFoundError);
      expect(repository.services[0]?.categoryId).toBeNull();
    });
  });

  it('refuse toute opération hors portée de tenant', async () => {
    // Défaut fermé : sans contexte résolu, on ne retombe **jamais** sur « toutes
    // les données ». C'est le mode ouvert par défaut qui produit les fuites.
    await expect(services.list({ activeOnly: false })).rejects.toThrow(/tenant/i);
  });
});
